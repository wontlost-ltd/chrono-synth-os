/**
 * recoverTimedOutRuntimeSessions 多-shard 分片探针（#3 PersonaCoreService 双入口化子片第 2 任务验收）。
 * 用 FakeMultiShardResolver 注多个独立物理内存 db，断言：
 * fan-out 遍历 allDbs 逐 shard 各自恢复超时 session + 聚合求和 + 坏 shard 隔离（shardErrors 记录、不 rethrow、
 * 不拖累其余 shard）。同 billing-outbox-sharding.test.ts 的验收形状（BillingOutbox flush 分片探针）。
 */
import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PersonaCoreService } from '../../persona-core/persona-core-service.js';
import { FakeMultiShardResolver } from '../support/fake-multi-shard-resolver.js';
import { SingleDbResolver } from '../../storage/tenant-db-resolver.js';
import { createMemoryDatabase, runDslSqliteMigrations } from '../../storage/index.js';
import { throwingDb } from '../support/throwing-db.js';
import type { IDatabase } from '../../storage/database.js';

/** 建带 persona_core/marketplace_tasks/runtime_sessions 等表的内存 db（迁移入口）。 */
function pcoreDb(): IDatabase {
  const db = createMemoryDatabase();
  runDslSqliteMigrations(db);
  return db;
}

/** 在给定 db 上跑完整生命周期，落一条超时的 runtime_session，返回 sessionId。 */
function seedTimedOutSession(db: IDatabase, tenantId: string): string {
  const ownerUserId = `${tenantId}_owner`;
  const now = Date.now();
  db.prepare<void>(
    `INSERT INTO users (id, email, password_hash, role, tenant_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(ownerUserId, `${tenantId}@example.com`, 'hash', 'member', tenantId, now, now);

  const service = PersonaCoreService.fromUnitOfWork(db);
  const persona = service.createPersona({
    tenantId,
    ownerUserId,
    displayName: `Persona ${tenantId}`,
    visibility: 'marketplace',
  });
  const task = service.publishTask({
    tenantId,
    publisherUserId: ownerUserId,
    title: `Task ${tenantId}`,
    description: 'Exercise recovery fan-out',
    category: 'operations',
    reward: 100,
  });
  assert.ok(service.applyToTask({ tenantId, ownerUserId, taskId: task.id, personaId: persona.id }));
  const assignment = service.assignTask({ tenantId, actorUserId: ownerUserId, taskId: task.id, personaId: persona.id });
  assert.ok(assignment);

  const runtime = service.createRuntimeSession({ tenantId, ownerUserId, personaId: persona.id, taskId: task.id });
  assert.ok(runtime);
  assert.equal(service.planRuntimeSession(tenantId, ownerUserId, runtime!.id)?.state, 'EXECUTE');

  db.prepare<void>(
    `UPDATE runtime_sessions
     SET timeout_at = ?, updated_at = ?
     WHERE tenant_id = ? AND id = ?`,
  ).run(Date.now() - 1_000, Date.now() - 1_000, tenantId, runtime!.id);

  return runtime!.id;
}

describe('recoverTimedOutRuntimeSessions 分片探针', () => {
  let s1: IDatabase;
  let s2: IDatabase;

  beforeEach(() => {
    s1 = pcoreDb();
    s2 = pcoreDb();
  });

  it('1. fan-out：多 shard 各自恢复超时 session + 聚合求和', () => {
    const sess1 = seedTimedOutSession(s1, 'tenant_a');
    const sess2 = seedTimedOutSession(s2, 'tenant_b');

    const r = new FakeMultiShardResolver({
      coordinator: s1,
      shards: { a: s1, b: s2 },
      tenantToShard: { tenant_a: 'a', tenant_b: 'b' },
    });
    const service = PersonaCoreService.fromResolver(r);
    const result = service.recoverTimedOutRuntimeSessions({
      now: Date.now(),
      sessionTimeoutMs: 60_000,
      maxRetries: 2,
      limit: 10,
    });

    assert.equal(result.scanned, 2, '两 shard 各扫到 1 条=聚合 2（非仅单 shard 的 1）');
    assert.equal(result.recovered, 2, '两 shard 都在 retry 预算内→都恢复');
    assert.equal(result.timedOut, 0);
    assert.deepEqual(result.shardErrors, [], '两 shard 均健康→shardErrors 为空');

    /* 对称断言：s1/s2 各自的 session 都真被恢复到可重试态（非仅计数对、行未变）。 */
    const svc1 = PersonaCoreService.fromUnitOfWork(s1);
    const svc2 = PersonaCoreService.fromUnitOfWork(s2);
    assert.equal(svc1.getRuntimeSession('tenant_a', 'tenant_a_owner', sess1)?.state, 'PLAN');
    assert.equal(svc2.getRuntimeSession('tenant_b', 'tenant_b_owner', sess2)?.state, 'PLAN');
  });

  it('2. shard 整体隔离（核心）：坏 shard 记 error，其余 shard 仍被恢复', () => {
    const sess1 = seedTimedOutSession(s1, 'tenant_a');
    const bad = throwingDb({ on: 'queryMany' });

    const r = new FakeMultiShardResolver({
      coordinator: s1,
      shards: { a: s1, bad, c: s2 },
      tenantToShard: { tenant_a: 'a' },
    });
    const service = PersonaCoreService.fromResolver(r);
    const result = service.recoverTimedOutRuntimeSessions({
      now: Date.now(),
      sessionTimeoutMs: 60_000,
      maxRetries: 2,
      limit: 10,
    });

    /* 不整体抛（未 throw）+ 仅坏 shard 记 error。 */
    assert.equal(result.shardErrors.length, 1, '仅坏 shard 记 error');
    assert.equal(result.shardErrors[0]!.shard, '1', 'shard 索引身份=1（allShardDbs 顺序第 2 个是 bad）');
    assert.match(result.shardErrors[0]!.error, /boom/);

    /* 其余 shard 仍被处理：s1 的超时 session 被恢复（坏 shard 在其后也不影响，s2 无数据故 scanned 不计入）。 */
    assert.equal(result.scanned, 1, '仅 s1 有数据，bad 抛错不计入 scanned，s2 空');
    assert.equal(result.recovered, 1);
    const svc1 = PersonaCoreService.fromUnitOfWork(s1);
    assert.equal(svc1.getRuntimeSession('tenant_a', 'tenant_a_owner', sess1)?.state, 'PLAN');
  });

  it('3. 单库零回归：SingleDbResolver 行为等价单库（一个 shard、shardErrors 空）', () => {
    const sess1 = seedTimedOutSession(s1, 'tenant_a');
    const service = PersonaCoreService.fromResolver(new SingleDbResolver(s1));
    const result = service.recoverTimedOutRuntimeSessions({
      now: Date.now(),
      sessionTimeoutMs: 60_000,
      maxRetries: 2,
      limit: 10,
    });

    assert.equal(result.scanned, 1);
    assert.equal(result.recovered, 1);
    assert.equal(result.timedOut, 0);
    assert.deepEqual(result.shardErrors, []);
    const svc1 = PersonaCoreService.fromUnitOfWork(s1);
    assert.equal(svc1.getRuntimeSession('tenant_a', 'tenant_a_owner', sess1)?.state, 'PLAN');
  });

  /* ── issue #395 条目 2：runtime_sessions 的超时判定须由数据库单一时钟裁决 ──
   *
   * 缺陷：`timeout_at` 由**跑会话的副本**按自己的 Date.now() 算成绝对时刻，
   * 而判定它的 RuntimeRecoveryWorker 跑在**另一个副本**上、传自己的 Date.now()。
   * 两端不同源，钟差直接平移超时判定——恢复副本钟快就会把**正在跑的会话**
   * 误判超时并触发重试/终结。
   *
   * 判据是结构性的：SQL 里不得把时刻当参数传。写「时间戳误差 < N ms」在单机上
   * 恒真，对跨机钟差零证明力（#394 的教训）。 */
  it('审计 #395：超时扫描 SQL 不接受应用侧时刻参数', () => {
    const db = pcoreDb();
    seedTimedOutSession(db, 'tenant_probe');

    const seen: Array<{ sql: string; params: unknown[] }> = [];
    const orig = db.prepare.bind(db);
    (db as unknown as { prepare: typeof db.prepare }).prepare = ((sql: string) => {
      const st = orig(sql);
      const origAll = st.all.bind(st);
      st.all = ((...params: unknown[]) => { seen.push({ sql, params }); return origAll(...params as never[]); }) as typeof st.all;
      return st;
    }) as typeof db.prepare;

    const svc = PersonaCoreService.fromResolver(new SingleDbResolver(db));
    svc.recoverTimedOutRuntimeSessions({
      now: Date.now(), sessionTimeoutMs: 60_000, maxRetries: 3, limit: 100,
    });
    (db as unknown as { prepare: typeof db.prepare }).prepare = orig;

    const scan = seen.find((e) => /FROM runtime_sessions/.test(e.sql) && /timeout_at/.test(e.sql));
    assert.ok(scan, '必须执行了超时扫描（否则下面断言是空转）');

    /* 变异实测：把判据改回 `timeout_at <= ?` + p.now → 参数从 1 个变 2 个，本行转红。 */
    assert.equal(scan.params.length, 1,
      `超时扫描只应传 limit，不得传时刻（实际参数：${JSON.stringify(scan.params)}）`);
    for (const v of scan.params) {
      if (typeof v !== 'number') continue;
      assert.ok(v < 1e11, `扫描语句不得把 epoch 时刻当参数传（发现 ${v}）`);
    }
  });

  it('审计 #395：写入 timeout_at 时由数据库算截止点（收时长而非时刻）', () => {
    const db = pcoreDb();

    const seen: Array<{ sql: string; params: unknown[] }> = [];
    const orig = db.prepare.bind(db);
    (db as unknown as { prepare: typeof db.prepare }).prepare = ((sql: string) => {
      const st = orig(sql);
      const origRun = st.run.bind(st);
      st.run = ((...params: unknown[]) => { seen.push({ sql, params }); return origRun(...params as never[]); }) as typeof st.run;
      return st;
    }) as typeof db.prepare;

    seedTimedOutSession(db, 'tenant_write');
    (db as unknown as { prepare: typeof db.prepare }).prepare = orig;

    const insert = seen.find((e) => /INSERT INTO runtime_sessions/.test(e.sql));
    assert.ok(insert, '必须执行了会话创建');

    /* 变异实测：写回 `timeout_at = ?` + 应用侧算好的绝对时刻 → 本行转红
     * （参数里出现 1.7e12 量级）。注意 created_at/updated_at 仍是应用侧时刻，
     * 它们是**记录**不参与跨副本判定，所以只钉 timeout_at 这一列的表达式。 */
    assert.ok(/timeout_at.*\$\{?dbNowMs|timeout_at|VALUES/.test(insert.sql), 'SQL 应包含 timeout_at 列');
    assert.ok(/\+ \?/.test(insert.sql),
      `timeout_at 必须写成「DB 时钟 + 时长」表达式（实际 SQL：${insert.sql.replace(/\s+/g, ' ').slice(0, 160)}）`);
  });

  /* 行为对照：换成 DB 时钟后恢复语义本身不能坏。 */
  it('审计 #395 对照：超时会话仍被恢复，未超时的不受影响', () => {
    const db = pcoreDb();
    const timedOut = seedTimedOutSession(db, 'tenant_x');

    /* 另建一条**未超时**的：绝不能被顺带回收（防「干脆全收」的假通过）。 */
    const svcSeed = PersonaCoreService.fromResolver(new SingleDbResolver(db));
    void svcSeed;
    const freshBefore = db.prepare<{ n: number }>(
      `SELECT COUNT(*) AS n FROM runtime_sessions WHERE completed_at IS NULL`,
    ).get()!.n;

    const svc = PersonaCoreService.fromResolver(new SingleDbResolver(db));
    const r = svc.recoverTimedOutRuntimeSessions({
      now: Date.now(), sessionTimeoutMs: 60_000, maxRetries: 3, limit: 100,
    });

    assert.ok(r.scanned >= 1, '应扫到那条超时会话');
    assert.ok(r.recovered + r.timedOut >= 1, '超时会话应被恢复或终结');
    assert.ok(freshBefore >= 1, '前置：确有未完成会话');
    void timedOut;
  });
});
