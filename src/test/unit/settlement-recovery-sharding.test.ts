/**
 * SettlementReconciliationWorker + RuntimeRecoveryWorker 多-shard 分片探针
 * （分片 Phase 0 · Plan 2 · Task 3 —— 两 worker 都从裸 db/tx 换成共享 resolver，跨 shard fan-out）。
 *
 * 背景：这两个 worker 是 cross-tenant 后台扫描器（结算对账 / 运行态恢复），此前只跑「当前 tx」或
 * 「SingleDbResolver 包一层的单 db」。多 shard 部署下若只跑一个库，其余 shard 的待结算租户 / 卡死
 * runtime session 永不被处理——非-home shard 上静默断裂。本探针用 FakeMultiShardResolver 注 2 个独立
 * 物理 db，锚定 fan-out（两 shard 都被处理，聚合计数=两 shard 之和，非仅 home）+ 逐 shard 隔离。
 *
 * 单库下 dbForTenant/coordinatorDb/allShardDbs 是同一 db，「非-home shard 漏处理」测不出来——多 shard
 * 布置是唯一能让「只跑 home」与「fan-out 全 shard」产生可观测差异的手段。
 */

import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDatabase, runDslSqliteMigrations } from '../../storage/index.js';
import type { IDatabase } from '../../storage/database.js';
import { SettlementReconciliationWorker } from '../../billing/settlement-reconciliation-worker.js';
import { PersonaCoreService } from '../../persona-core/persona-core-service.js';
import { RuntimeRecoveryWorker } from '../../persona-core/runtime-recovery-worker.js';
import { FakeMultiShardResolver } from '../support/fake-multi-shard-resolver.js';
import { throwingDb } from '../support/throwing-db.js';
import { SilentLogger } from '../../utils/logger.js';

/** 建带全表的内存 db（迁移入口——一个 db=一个 shard）。 */
function shardDb(): IDatabase {
  const db = createMemoryDatabase();
  runDslSqliteMigrations(db);
  return db;
}

/**
 * 在给定 shard db 上落一个「待对账」租户：建 persona（连带自动建 wallet）+ 一条孤儿
 * wallet_transactions（reference_type='wallet_settlement' 但引用不存在的结算）。
 * 效果：① 该租户经 UNION 进入 settleQueryTenantsWithSettlements 枚举；② reconcileTenant 会删除该
 * 孤儿交易（orphanTransactionsRemoved=1），产出一条真实 reconcile run——证明该 shard 的租户被结算。
 */
function seedPendingSettlementTenant(db: IDatabase, tenantId: string): void {
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
    visibility: 'private',
  });

  const walletId = (db.prepare<{ id: string }>(
    `SELECT id FROM persona_wallets WHERE tenant_id = ? AND persona_id = ?`,
  ).get(tenantId, persona.id) as { id: string }).id;

  /* 孤儿结算交易：reference_id 指向不存在的结算 → reconcileTenant 判为 orphan 并删除。 */
  db.prepare<void>(
    `INSERT INTO wallet_transactions (
       id, tenant_id, wallet_id, transaction_type, amount_minor, currency, reference_type, reference_id, created_at
     ) VALUES (?, ?, ?, 'task_payment', 100, 'USD', 'wallet_settlement', ?, ?)`,
  ).run(`wtx_${tenantId}_orphan`, tenantId, walletId, `settle_missing_${tenantId}`, now);
}

/** 在给定 shard db 上落一个「超时」runtime session，返回 sessionId（模型同 persona-marketplace-recovery-sharding）。 */
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

describe('SettlementReconciliationWorker 分片探针（结算对账 fan-out + shard 隔离）', () => {
  let s0: IDatabase;
  let s1: IDatabase;

  beforeEach(() => {
    s0 = shardDb();
    s1 = shardDb();
  });

  it('① fan-out：两 shard 各自的待结算租户都被结算（runs 计数=两 shard 之和、shardErrors 空）', async () => {
    seedPendingSettlementTenant(s0, 'tenant_a');
    seedPendingSettlementTenant(s1, 'tenant_b');
    const resolver = new FakeMultiShardResolver({
      coordinator: s0,
      shards: { shard0: s0, shard1: s1 },
      tenantToShard: { tenant_a: 'shard0', tenant_b: 'shard1' },
    });
    const worker = new SettlementReconciliationWorker(resolver, new SilentLogger(), { batchSize: 100 });

    const result = await worker.flush();

    /* 两 shard 各枚举出 1 个待结算租户 → runs 计数=2（非仅单 shard 的 1）。 */
    assert.equal(result.runs.length, 2, '两 shard 待结算租户之和');
    assert.equal(result.shardErrors.length, 0, '两 shard 均健康→shardErrors 空');
    /* 各 shard 的租户都真被结算（对称，非仅计数对）：孤儿交易被删（orphanTransactionsRemoved=1）。 */
    const byTenant = new Map(result.runs.map((r) => [r.tenantId, r]));
    assert.equal(byTenant.get('tenant_a')?.orphanTransactionsRemoved, 1, 's0 租户被结算（孤儿删）');
    assert.equal(byTenant.get('tenant_b')?.orphanTransactionsRemoved, 1, 's1 租户被结算（只跑 home 则会漏）');
    /* 两 shard 的孤儿交易行都真被物理删（非仅计数对、行未变）。 */
    assert.equal(s0.prepare(`SELECT COUNT(*) AS c FROM wallet_transactions`).get()!['c' as never], 0, 's0 孤儿已删');
    assert.equal(s1.prepare(`SELECT COUNT(*) AS c FROM wallet_transactions`).get()!['c' as never], 0, 's1 孤儿已删');
  });

  it('② shard 隔离：坏 shard（queryMany 抛）记 shardErrors、好 shard 仍结算', async () => {
    seedPendingSettlementTenant(s0, 'tenant_a');
    /* reconcileTenants 首调 tx.queryMany(settleQueryTenantsWithSettlements) → 抛 → 整 shard 进 catch。 */
    const bad = throwingDb({ on: 'queryMany' });
    const resolver = new FakeMultiShardResolver({
      coordinator: s0,
      shards: { shard0: s0, shard1: bad },
      tenantToShard: { tenant_a: 'shard0' },
    });
    const logger = new SilentLogger();
    const worker = new SettlementReconciliationWorker(resolver, logger, { batchSize: 100 });

    const result = await worker.flush();

    /* 坏 shard 记 shardErrors（keyer 按首见顺序：s0=shard#0、bad=shard#1）。 */
    assert.equal(result.shardErrors.length, 1, '仅坏 shard 记 error');
    assert.equal(result.shardErrors[0]!.shardKey, 'shard#1', 'shard 身份=shard#1（allShardDbs 顺序第 2 个是 bad）');
    assert.match(result.shardErrors[0]!.error, /boom/);
    /* 好 shard 仍结算（隔离：坏 shard 不拖累好 shard）。 */
    assert.equal(result.runs.length, 1, 's0 仍结算');
    assert.equal(result.runs[0]!.tenantId, 'tenant_a');
    assert.equal(s0.prepare(`SELECT COUNT(*) AS c FROM wallet_transactions`).get()!['c' as never], 0, 's0 孤儿仍被删');
  });

  it('③ 单库零回归：SingleDbResolver 等价单库（无 shardErrors、runs=枚举租户数）', async () => {
    const { SingleDbResolver } = await import('../../storage/tenant-db-resolver.js');
    seedPendingSettlementTenant(s0, 'tenant_a');
    const worker = new SettlementReconciliationWorker(new SingleDbResolver(s0), new SilentLogger(), { batchSize: 100 });

    const result = await worker.flush();

    assert.equal(result.runs.length, 1);
    assert.equal(result.runs[0]!.tenantId, 'tenant_a');
    assert.equal(result.shardErrors.length, 0);
  });
});

describe('RuntimeRecoveryWorker 分片探针（运行态恢复 fan-out）', () => {
  let s0: IDatabase;
  let s1: IDatabase;

  beforeEach(() => {
    s0 = shardDb();
    s1 = shardDb();
  });

  it('① fan-out：两 shard 各自的超时 session 都被恢复（scanned/recovered=两 shard 之和，非仅 home）', async () => {
    const sess0 = seedTimedOutSession(s0, 'tenant_a');
    const sess1 = seedTimedOutSession(s1, 'tenant_b');
    const resolver = new FakeMultiShardResolver({
      coordinator: s0,
      shards: { shard0: s0, shard1: s1 },
      tenantToShard: { tenant_a: 'shard0', tenant_b: 'shard1' },
    });
    const worker = new RuntimeRecoveryWorker(resolver, new SilentLogger(), {
      pollIntervalMs: 10_000,
      sessionTimeoutMs: 60_000,
      maxRetries: 2,
      batchSize: 10,
    });

    const result = await worker.flush();

    assert.equal(result.scanned, 2, '两 shard 各扫到 1 条=聚合 2（非仅 home shard 的 1）');
    assert.equal(result.recovered, 2, '两 shard 都在 retry 预算内→都恢复');
    assert.equal(result.timedOut, 0);
    assert.deepEqual(result.shardErrors, [], '两 shard 均健康→shardErrors 空');

    /* 对称断言：s0/s1 各自的 session 都真被恢复到可重试态（非仅计数对、行未变）。 */
    const svc0 = PersonaCoreService.fromUnitOfWork(s0);
    const svc1 = PersonaCoreService.fromUnitOfWork(s1);
    assert.equal(svc0.getRuntimeSession('tenant_a', 'tenant_a_owner', sess0)?.state, 'PLAN', 's0 session 恢复');
    assert.equal(svc1.getRuntimeSession('tenant_b', 'tenant_b_owner', sess1)?.state, 'PLAN', 's1 session 恢复（只跑 home 则会漏）');
  });

  it('② shard 隔离：坏 shard（queryMany 抛）记 shardErrors、好 shard 仍恢复', async () => {
    const sess0 = seedTimedOutSession(s0, 'tenant_a');
    const bad = throwingDb({ on: 'queryMany' });
    const resolver = new FakeMultiShardResolver({
      coordinator: s0,
      shards: { shard0: s0, shard1: bad },
      tenantToShard: { tenant_a: 'shard0' },
    });
    const worker = new RuntimeRecoveryWorker(resolver, new SilentLogger(), {
      pollIntervalMs: 10_000,
      sessionTimeoutMs: 60_000,
      maxRetries: 2,
      batchSize: 10,
    });

    const result = await worker.flush();

    /* recoverTimedOutRuntimeSessions 底层用数组下标记 shard（'1'），不经 worker keyer。 */
    assert.equal(result.shardErrors.length, 1, '仅坏 shard 记 error');
    assert.equal(result.shardErrors[0]!.shard, '1', 'shard 索引身份=1（allShardDbs 顺序第 2 个是 bad）');
    assert.match(result.shardErrors[0]!.error, /boom/);
    /* 好 shard 仍恢复。 */
    assert.equal(result.scanned, 1, '仅 s0 有数据');
    assert.equal(result.recovered, 1);
    const svc0 = PersonaCoreService.fromUnitOfWork(s0);
    assert.equal(svc0.getRuntimeSession('tenant_a', 'tenant_a_owner', sess0)?.state, 'PLAN');
  });
});
