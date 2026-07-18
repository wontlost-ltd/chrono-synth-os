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
import type { IDatabase } from '../../storage/database.js';

/** 建带 persona_core/marketplace_tasks/runtime_sessions 等表的内存 db（迁移入口）。 */
function pcoreDb(): IDatabase {
  const db = createMemoryDatabase();
  runDslSqliteMigrations(db);
  return db;
}

/** 最小 IDatabase 桩：queryMany 恒抛错，其余方法 no-op（只用于 shard 整体隔离探针）。 */
function throwingDb(): IDatabase {
  return {
    dialect: 'sqlite',
    exec: () => {},
    prepare: () => ({ run: () => ({ changes: 0, lastInsertRowid: 0 }), get: () => undefined, all: () => [] }),
    transaction: (fn: () => unknown) => fn(),
    transactionRollback: (fn: () => unknown) => fn(),
    close: () => {},
    queryOne: () => null,
    queryMany: () => { throw new Error('boom'); },
    execute: () => ({ rowsAffected: 0 }),
  } as unknown as IDatabase;
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
    const bad = throwingDb();

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
});
