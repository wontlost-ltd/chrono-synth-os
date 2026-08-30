/**
 * 单元测试：conversation/knowledge/billing 数据存储层双入口（Phase 2 批次 4 验收）
 *
 * 该批次属于 B' 类（保留 raw db.prepare）。验收要点：
 *  - 双入口构造均不抛错
 *  - IDatabase 入口下既有功能保持等价
 *  - UoW 入口下读写路径明确抛错（指向后续 kernel 命令下沉）
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDatabase } from '../../storage/database.js';
import { runDslSqliteMigrations } from '../../storage/index.js';
import { ConversationAuditPublisher } from '../../conversation/audit-publisher.js';
import { ConfirmationTokenStore } from '../../conversation/confirmation-token-store.js';
import { ConversationKnowledgeRetriever } from '../../conversation/conversation-knowledge-retriever.js';
import { ConversationStore } from '../../conversation/conversation-store.js';
import { BulkImportStore } from '../../knowledge/bulk-import-store.js';
import { KnowledgeSourceService } from '../../knowledge/knowledge-source-service.js';
import { SubscriptionGateService } from '../../billing/subscription-gate-service.js';
import { SingleDbResolver } from '../../storage/tenant-db-resolver.js';
import { ConsoleLogger } from '../../utils/logger.js';

describe('Phase 2 批次 4：data stores 双入口', () => {
  it('SubscriptionGateService 双入口：IDatabase 与 UoW 等价（已下沉至 kernel）', () => {
    const db = createMemoryDatabase();
    runDslSqliteMigrations(db);
    try {
      const fromDb = new SubscriptionGateService(db);
      assert.equal(fromDb.canUseResource('default', 'conversation_message').allowed, true);

      const fromUow = new SubscriptionGateService(db);
      assert.equal(fromUow.canUseResource('default', 'conversation_message').allowed, true);
    } finally { db.close(); }
  });

  it('ConfirmationTokenStore 双入口：已下沉至 kernel', () => {
    const db = createMemoryDatabase();
    runDslSqliteMigrations(db);
    try {
      const fromDb = new ConfirmationTokenStore(db);
      const issued = fromDb.issue({
        tenantId: 'default', personaId: 'p1', sessionId: 's1', externalUserId: 'u1',
        topic: 'finance', rule: 'require_confirmation', userInput: 'hello',
      });
      assert.ok(issued.token.startsWith('cct_'));

      const fromUow = new ConfirmationTokenStore(db);
      const result = fromUow.consume({
        token: issued.token,
        tenantId: 'default', personaId: 'p1', sessionId: 's1', externalUserId: 'u1',
        userInput: 'hello',
      });
      assert.deepEqual(result, { ok: true });
      assert.equal(fromUow.pruneExpired(), 0);
    } finally { db.close(); }
  });

  it('ConversationKnowledgeRetriever 双入口：已下沉至 kernel', async () => {
    const db = createMemoryDatabase();
    runDslSqliteMigrations(db);
    try {
      const fromDb = new ConversationKnowledgeRetriever(db);
      assert.deepEqual(await fromDb.retrieve({ tenantId: 'default', personaId: 'p1', userInput: 'test', topK: 5 }), []);

      const fromUow = new ConversationKnowledgeRetriever(db);
      assert.deepEqual(await fromUow.retrieve({ tenantId: 'default', personaId: 'p1', userInput: 'test', topK: 5 }), []);
    } finally { db.close(); }
  });

  it('ConversationStore 双入口：已下沉至 kernel', () => {
    const db = createMemoryDatabase();
    runDslSqliteMigrations(db);
    try {
      const fromDb = new ConversationStore(db);
      assert.equal(fromDb.countBySession({ tenantId: 'default', personaId: 'p1', sessionId: 's1' }), 0);

      const fromUow = new ConversationStore(db);
      assert.equal(fromUow.countBySession({ tenantId: 'default', personaId: 'p1', sessionId: 's1' }), 0);
    } finally { db.close(); }
  });

  it('BulkImportStore 双入口：已下沉至 kernel', () => {
    const db = createMemoryDatabase();
    runDslSqliteMigrations(db);
    try {
      const fromDb = new BulkImportStore(db);
      assert.equal(fromDb.get('default', 'job_missing'), null);

      const fromUow = new BulkImportStore(db);
      assert.equal(fromUow.get('default', 'job_missing'), null);
    } finally { db.close(); }
  });

  /* ── issue #395 条目 5：bulk_knowledge_import_jobs 的卡死回收 ──
   *
   * `started_at` 由跑 import 的副本写、回收判定跑在 worker 副本上，两端时钟
   * 不同源时钟差直接平移判定——worker 钟快就把**正在跑**的 job 标成 failed。
   *
   * 该路径当前无生产调用方（潜伏），此前也**零覆盖**：把判定改回应用侧
   * cutoff 后编译通过、全套照样绿。故一并补上。 */
  it('审计 #395：reapStuck 只传时长，截止点由数据库算', () => {
    const db = createMemoryDatabase();
    runDslSqliteMigrations(db);
    try {
      const store = new BulkImportStore(db);
      store.create({
        id: 'job_stuck', tenantId: 'default', personaId: 'p1', ownerUserId: 'u1',
        totalItems: 10, deduplicateStrategy: 'skip',
      });
      store.markRunning('job_stuck');

      /* 把 started_at 挪早 10 分钟 —— 调用方已无法通过传 now 把时钟推快。 */
      db.prepare<void>(
        `UPDATE bulk_knowledge_import_jobs SET started_at = started_at - 600000 WHERE id = ?`,
      ).run('job_stuck');

      /* 另有一条**刚开始**的：绝不能被顺带回收（防「干脆全收」的假通过）。 */
      store.create({
        id: 'job_fresh', tenantId: 'default', personaId: 'p1', ownerUserId: 'u1',
        totalItems: 10, deduplicateStrategy: 'skip',
      });
      store.markRunning('job_fresh');

      const seen: Array<{ sql: string; params: unknown[] }> = [];
      const orig = db.prepare.bind(db);
      (db as unknown as { prepare: typeof db.prepare }).prepare = ((sql: string) => {
        const st = orig(sql);
        const origAll = st.all.bind(st);
        st.all = ((...params: unknown[]) => { seen.push({ sql, params }); return origAll(...params as never[]); }) as typeof st.all;
        return st;
      }) as typeof db.prepare;

      const reaped = store.reapStuck(5 * 60 * 1000);
      (db as unknown as { prepare: typeof db.prepare }).prepare = orig;

      /* 行为：只回收卡死那条。 */
      assert.equal(reaped, 1, '只该回收卡死的那一条');
      assert.equal(store.get('default', 'job_stuck')?.state, 'failed');
      assert.equal(store.get('default', 'job_fresh')?.state, 'running', '刚开始的不得被顺带回收');

      /* 结构：SQL 不得把截止时刻当参数传。
       * 变异实测：判定改回 `started_at < ?` + Date.now()-stuckAfterMs →
       * 参数变成 1.7e12 量级，下面转红。 */
      const scan = seen.find((e) => /bulk_knowledge_import_jobs/.test(e.sql) && /started_at </.test(e.sql));
      assert.ok(scan, '必须执行了卡死扫描');
      assert.deepEqual(scan.params, [5 * 60 * 1000],
        `扫描只应传时长（实际参数：${JSON.stringify(scan.params)}）`);
      assert.ok(/started_at < \(/.test(scan.sql), '截止点必须由 SQL 内的 DB 时钟算出');
    } finally { db.close(); }
  });

  it('ConversationAuditPublisher 双入口：UoW 模式下静默跳过', () => {
    const db = createMemoryDatabase();
    runDslSqliteMigrations(db);
    try {
      const logger = new ConsoleLogger('warn');
      const fromDb = new ConversationAuditPublisher(db, logger);
      fromDb.publish({
        tenantId: 'default', actorType: 'user', actorId: 'u1',
        actionType: 'audit.test', targetType: 'tt', targetId: 'ti',
      });

      const fromUow = new ConversationAuditPublisher(db, logger);
      fromUow.publish({
        tenantId: 'default', actorType: 'user', actorId: 'u1',
        actionType: 'audit.test', targetType: 'tt', targetId: 'ti',
      });
    } finally { db.close(); }
  });

  it('KnowledgeSourceService 双入口：UoW 与 IDatabase 等价（Phase 3 解锁）', () => {
    const db = createMemoryDatabase();
    runDslSqliteMigrations(db);
    try {
      /* 分片 Plan 1b（Task 5）：KnowledgeSourceService ctor 收 resolver（不再接裸 db/uow）。 */
      const fromDb = new KnowledgeSourceService(new SingleDbResolver(db));
      const fromUow = new KnowledgeSourceService(new SingleDbResolver(db));
      assert.deepEqual(
        fromDb.list('default', 1, 10).pagination.total,
        fromUow.list('default', 1, 10).pagination.total,
      );
    } finally { db.close(); }
  });
});
