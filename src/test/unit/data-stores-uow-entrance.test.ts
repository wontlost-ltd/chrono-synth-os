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
import { runMigrations } from '../../storage/migrations.js';
import { directUnitOfWork } from '../../storage/direct-uow-adapter.js';
import { ConversationAuditPublisher } from '../../conversation/audit-publisher.js';
import { ConfirmationTokenStore } from '../../conversation/confirmation-token-store.js';
import { ConversationKnowledgeRetriever } from '../../conversation/conversation-knowledge-retriever.js';
import { ConversationStore } from '../../conversation/conversation-store.js';
import { BulkImportStore } from '../../knowledge/bulk-import-store.js';
import { KnowledgeSourceService } from '../../knowledge/knowledge-source-service.js';
import { SubscriptionGateService } from '../../billing/subscription-gate-service.js';
import { ConsoleLogger } from '../../utils/logger.js';

describe('Phase 2 批次 4：data stores 双入口', () => {
  it('SubscriptionGateService 双入口：IDatabase 路径走原 SQL', () => {
    const db = createMemoryDatabase();
    runMigrations(db);
    try {
      const fromDb = new SubscriptionGateService(db);
      const decision = fromDb.canUseResource('default', 'conversation_message');
      assert.equal(decision.allowed, true);

      const fromUow = new SubscriptionGateService(directUnitOfWork(db));
      assert.throws(() => fromUow.canUseResource('default', 'conversation_message'), /requires IDatabase entrance/);
    } finally { db.close(); }
  });

  it('ConfirmationTokenStore 双入口', () => {
    const db = createMemoryDatabase();
    runMigrations(db);
    try {
      const fromDb = new ConfirmationTokenStore(db);
      const issued = fromDb.issue({
        tenantId: 'default', personaId: 'p1', sessionId: 's1', externalUserId: 'u1',
        topic: 'finance', rule: 'require_confirmation', userInput: 'hello',
      });
      assert.ok(issued.token.startsWith('cct_'));

      const fromUow = new ConfirmationTokenStore(directUnitOfWork(db));
      assert.throws(() => fromUow.pruneExpired(), /requires IDatabase entrance/);
    } finally { db.close(); }
  });

  it('ConversationKnowledgeRetriever 双入口', async () => {
    const db = createMemoryDatabase();
    runMigrations(db);
    try {
      const fromDb = new ConversationKnowledgeRetriever(db);
      const result = await fromDb.retrieve({ tenantId: 'default', personaId: 'p1', userInput: 'test', topK: 5 });
      assert.deepEqual(result, []);

      const fromUow = new ConversationKnowledgeRetriever(directUnitOfWork(db));
      await assert.rejects(
        () => fromUow.retrieve({ tenantId: 'default', personaId: 'p1', userInput: 'test', topK: 5 }),
        /requires IDatabase entrance/,
      );
    } finally { db.close(); }
  });

  it('ConversationStore 双入口', () => {
    const db = createMemoryDatabase();
    runMigrations(db);
    try {
      const fromDb = new ConversationStore(db);
      const count = fromDb.countBySession({ tenantId: 'default', personaId: 'p1', sessionId: 's1' });
      assert.equal(count, 0);

      const fromUow = new ConversationStore(directUnitOfWork(db));
      assert.throws(
        () => fromUow.countBySession({ tenantId: 'default', personaId: 'p1', sessionId: 's1' }),
        /requires IDatabase entrance/,
      );
    } finally { db.close(); }
  });

  it('BulkImportStore 双入口', () => {
    const db = createMemoryDatabase();
    runMigrations(db);
    try {
      const fromDb = new BulkImportStore(db);
      assert.equal(fromDb.get('default', 'job_missing'), null);

      const fromUow = new BulkImportStore(directUnitOfWork(db));
      assert.throws(() => fromUow.get('default', 'job_missing'), /requires IDatabase entrance/);
    } finally { db.close(); }
  });

  it('ConversationAuditPublisher 双入口：UoW 模式下静默跳过', () => {
    const db = createMemoryDatabase();
    runMigrations(db);
    try {
      const logger = new ConsoleLogger('warn');
      const fromDb = new ConversationAuditPublisher(db, logger);
      fromDb.publish({
        tenantId: 'default', actorType: 'user', actorId: 'u1',
        actionType: 'audit.test', targetType: 'tt', targetId: 'ti',
      });

      const fromUow = new ConversationAuditPublisher(directUnitOfWork(db), logger);
      fromUow.publish({
        tenantId: 'default', actorType: 'user', actorId: 'u1',
        actionType: 'audit.test', targetType: 'tt', targetId: 'ti',
      });
    } finally { db.close(); }
  });

  it('KnowledgeSourceService 双入口：UoW 与 IDatabase 等价（Phase 3 解锁）', () => {
    const db = createMemoryDatabase();
    runMigrations(db);
    try {
      const fromDb = new KnowledgeSourceService(db);
      const fromUow = new KnowledgeSourceService(directUnitOfWork(db));
      assert.deepEqual(
        fromDb.list('default', 1, 10).pagination.total,
        fromUow.list('default', 1, 10).pagination.total,
      );
    } finally { db.close(); }
  });
});
