/**
 * MetricsQueryService 多-shard scatter-gather + partial failure 探针
 * （租户分片 Phase 0 · Plan 2 · Task 5 验收）。
 *
 * 用 FakeMultiShardResolver 注两个独立物理内存 db，断言 5 项聚合的**合并算法定死**：
 *  - population diversity：各 shard 原始 decision_style 行 concat → 协调层**全局重算**
 *    personalityDiversity(全部 styles)（非各 shard 局部分数 SUM）；
 *  - billing outbox backlog：各 shard count SUM；
 *  - observability summary：各 shard rollup count SUM + updated_at 取 **MAX**（非 SUM）；
 *  - queue backlog：各 shard count by status SUM；
 *  - tenant usage：各 shard 原始行（无 limit）concat → 全局 merge（同 tenant+resource SUM）
 *    → sort DESC → limit（非各 shard 各 limit 后拼）。
 * 再断言 **partial failure**：throwingDb 作 s1 → degraded:true + shardErrors 含 shard#1 +
 * data 是 s0 部分聚合（非静默当零、非整体抛）。
 *
 * 「铺路不激活」子片唯一能真正验证正确性的手段：单库下 allShardDbs()=[db]，普通功能测试证不出
 * scatter-gather 对错；本探针注独立 db，让「各 shard 独立聚合、协调层合并」可断言。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MetricsQueryService } from '../../observability/metrics-query-service.js';
import { FakeMultiShardResolver } from '../support/fake-multi-shard-resolver.js';
import { SingleDbResolver } from '../../storage/tenant-db-resolver.js';
import { throwingDb } from '../support/throwing-db.js';
import { createMemoryDatabase, runDslSqliteMigrations } from '../../storage/index.js';
import { registerCoreSelfExecutors } from '../../storage/executors/index.js';
import { applyObservabilityRollupDelta } from '../../observability/observability-outbox.js';
import {
  decisionStyleSetCmd, DEFAULT_DECISION_STYLE, personalityDiversity,
  type DecisionStyle,
} from '@chrono/kernel';
import type { IDatabase } from '../../storage/database.js';

/** 建一个迁移全表的内存 db（scatter-gather 每 shard 独立库）。 */
function shardDb(): IDatabase {
  registerCoreSelfExecutors();
  const db = createMemoryDatabase();
  runDslSqliteMigrations(db);
  return db;
}

/** 写一条 decision_style 行（走 kernel command，落 style_json）。返回该行的完整 DecisionStyle（updatedAt=0）。 */
function seedStyle(db: IDatabase, tenantId: string, overrides: Partial<Omit<DecisionStyle, 'updatedAt'>>): DecisionStyle {
  const payload = { ...DEFAULT_DECISION_STYLE, ...overrides };
  db.execute(decisionStyleSetCmd({ tenantId, personaId: 'default', styleJson: JSON.stringify(payload), updatedAt: 100 }));
  return { ...payload, updatedAt: 0 };
}

/** 写一条 usage_records 行。 */
function seedUsage(db: IDatabase, id: string, tenantId: string, resource: string, quantity: number, recordedAt: number): void {
  db.prepare('INSERT INTO usage_records (id, tenant_id, resource, quantity, recorded_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, tenantId, resource, quantity, recordedAt);
}

/** 写一条 tasks 行（仅设 status，其余走默认）。 */
function seedTask(db: IDatabase, id: string, status: string): void {
  const now = Date.now();
  db.prepare('INSERT INTO tasks (id, tenant_id, type, payload, status, created_at, updated_at, available_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, 'default', 'demo', '{}', status, now, now, now);
}

/** 写一条 billing_outbox 行。 */
function seedBilling(db: IDatabase, tenantId: string, idem: string, status: string): void {
  db.prepare('INSERT INTO billing_outbox (tenant_id, customer_id, event_name, quantity, idempotency_key, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(tenantId, 'cus', 'llm_tokens', 1, idem, status, Date.now());
}

const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

describe('MetricsQueryService 分片 scatter-gather', () => {
  it('1. population diversity：两 shard 全部 styles 全局重算（非局部分数 SUM）', () => {
    const s0 = shardDb(), s1 = shardDb();
    /* s0/s1 各写不同风格的租户 → 全局群体应含全部 4 份风格。 */
    const st0a = seedStyle(s0, 't0a', { riskAppetite: 0.1, explorationBias: 0.1 });
    const st0b = seedStyle(s0, 't0b', { riskAppetite: 0.2, explorationBias: 0.2 });
    const st1a = seedStyle(s1, 't1a', { riskAppetite: 0.8, explorationBias: 0.9 });
    const st1b = seedStyle(s1, 't1b', { riskAppetite: 0.9, explorationBias: 0.95 });
    const r = new FakeMultiShardResolver({ coordinator: s0, shards: { a: s0, b: s1 }, tenantToShard: {} });
    const svc = new MetricsQueryService(r);

    const agg = svc.getPopulationDiversity();
    assert.equal(agg.degraded, false);
    assert.equal(agg.shardErrors.length, 0);
    /* 全局重算基准：把两 shard 全部 styles concat 后一次算——非各 shard 各算再 SUM。 */
    const expected = personalityDiversity([st0a, st0b, st1a, st1b]);
    assert.equal(agg.data.count, 4, '两 shard 4 个已初始化人格');
    assert.equal(agg.data.count, expected.count);
    assert.equal(agg.data.diversityScore, expected.diversityScore, 'diversityScore 必须等于全局重算值');
    assert.deepEqual(agg.data.perDimensionSpread, expected.perDimensionSpread);
    assert.deepEqual(agg.data.perDimensionMean, expected.perDimensionMean);
    /* 反证：若误做「各 shard 局部算再取和/均值」，两个近似同质的子群 score 会远小于跨群全局 score。 */
    const s0Only = personalityDiversity([st0a, st0b]);
    assert.ok(expected.diversityScore > s0Only.diversityScore, '全局群体比单 shard 子群更分散（防局部 SUM 退化）');
  });

  it('2. billing outbox backlog：各 shard count SUM', () => {
    const s0 = shardDb(), s1 = shardDb();
    seedBilling(s0, 't0', 'i0-1', 'pending');
    seedBilling(s0, 't0', 'i0-2', 'pending');
    seedBilling(s0, 't0', 'i0-3', 'failed');
    seedBilling(s1, 't1', 'i1-1', 'pending');
    seedBilling(s1, 't1', 'i1-2', 'failed');
    seedBilling(s1, 't1', 'i1-3', 'failed');
    const r = new FakeMultiShardResolver({ coordinator: s0, shards: { a: s0, b: s1 }, tenantToShard: {} });
    const agg = new MetricsQueryService(r).getBillingOutboxBacklog();
    assert.equal(agg.degraded, false);
    assert.equal(agg.data.pending, 3, 'pending=2(s0)+1(s1)');
    assert.equal(agg.data.failed, 3, 'failed=1(s0)+2(s1)');
  });

  it('3. observability summary：rollup count SUM + updated_at MAX（非 SUM）', () => {
    const s0 = shardDb(), s1 = shardDb();
    /* s0 updated_at=1000，s1 updated_at=5000 → MAX=5000（若 SUM 会=6000）。 */
    applyObservabilityRollupDelta(s0, 't0', { runtimeCompletedCount: 3, taskTerminalCount: 4, taskSuccessCount: 3, updatedAt: 1000 });
    applyObservabilityRollupDelta(s1, 't1', { runtimeCompletedCount: 2, taskTerminalCount: 5, taskSuccessCount: 4, updatedAt: 5000 });
    const r = new FakeMultiShardResolver({ coordinator: s0, shards: { a: s0, b: s1 }, tenantToShard: {} });
    const agg = new MetricsQueryService(r).getObservabilitySummary();
    assert.equal(agg.degraded, false);
    assert.equal(agg.data.rollup.runtime_completed_count, 5, 'count SUM=3+2');
    assert.equal(agg.data.rollup.task_terminal_count, 9, 'count SUM=4+5');
    assert.equal(agg.data.rollup.task_success_count, 7, 'count SUM=3+4');
    assert.equal(agg.data.rollup.updated_at, 5000, 'updated_at 取两 shard MAX（非 SUM=6000）');
  });

  it('4. queue backlog：各 shard count by status SUM', () => {
    const s0 = shardDb(), s1 = shardDb();
    seedTask(s0, 'q0-1', 'pending');
    seedTask(s0, 'q0-2', 'pending');
    seedTask(s0, 'q0-3', 'running');
    seedTask(s1, 'q1-1', 'pending');
    seedTask(s1, 'q1-2', 'failed');
    const r = new FakeMultiShardResolver({ coordinator: s0, shards: { a: s0, b: s1 }, tenantToShard: {} });
    const agg = new MetricsQueryService(r).getQueueBacklog();
    assert.equal(agg.degraded, false);
    assert.equal(agg.data.pending, 3, 'pending=2(s0)+1(s1)');
    assert.equal(agg.data.running, 1, 'running=1(s0)+0(s1)');
    assert.equal(agg.data.failed, 1, 'failed=0(s0)+1(s1)');
  });

  it('5. tenant usage：全局 merge(同 tenant+resource SUM)+sort DESC+limit（非各 shard 各 limit）', () => {
    const s0 = shardDb(), s1 = shardDb();
    const now = Date.now();
    /* 跨 shard 同 (tenant, resource) 行——全局 merge 后应 SUM 成一行。 */
    seedUsage(s0, 'u0-1', 'shared', 'llm_tokens', 100, now);
    seedUsage(s1, 'u1-1', 'shared', 'llm_tokens', 250, now);
    /* 独有行，用于验 sort DESC + limit 顺序。 */
    seedUsage(s0, 'u0-2', 't0', 'storage', 500, now);
    seedUsage(s1, 'u1-2', 't1', 'embeddings', 10, now);
    const r = new FakeMultiShardResolver({ coordinator: s0, shards: { a: s0, b: s1 }, tenantToShard: {} });
    const svc = new MetricsQueryService(r);

    /* limit=2：全局按 total DESC 取前 2。合并后：{shared/llm_tokens:350}、{t0/storage:500}、{t1/embeddings:10}
       → sort DESC: 500, 350, 10 → limit 2 = [{t0/storage:500}, {shared/llm_tokens:350}]。
       若误做「各 shard 各 limit 2 后拼」，shared 行会被拆成两条 100/250、且不会跨 shard 合并。 */
    const agg = svc.getTenantUsage(RETENTION_MS, 2);
    assert.equal(agg.degraded, false);
    assert.equal(agg.data.length, 2, '全局 limit=2（非各 shard 各 2 后拼成 4）');
    assert.deepEqual(agg.data[0], { tenant_id: 't0', resource: 'storage', total: 500 }, '最大在前');
    assert.deepEqual(agg.data[1], { tenant_id: 'shared', resource: 'llm_tokens', total: 350 }, '跨 shard 同键 merge SUM=100+250');

    /* limit 足够大时全部 3 行出现（含合并后的 shared 单行）。 */
    const all = svc.getTenantUsage(RETENTION_MS, 100);
    assert.equal(all.data.length, 3, '合并后 3 个 (tenant,resource) 键');
    const shared = all.data.find((row) => row.tenant_id === 'shared' && row.resource === 'llm_tokens');
    assert.equal(shared?.total, 350, '跨 shard 同键全局 SUM');
  });

  it('6. partial failure：throwingDb 作 s1 → degraded + shardErrors 含 shard#1 + data 是 s0 部分聚合', () => {
    const s0 = shardDb();
    seedBilling(s0, 't0', 'i0-1', 'pending');
    seedBilling(s0, 't0', 'i0-2', 'pending');
    const bad = throwingDb({ on: 'queryOne' }); // getBillingOutboxBacklog 走 queryOne
    const r = new FakeMultiShardResolver({ coordinator: s0, shards: { a: s0, bad }, tenantToShard: {} });
    const agg = new MetricsQueryService(r).getBillingOutboxBacklog();

    assert.equal(agg.degraded, true, '有 shard 失败 → degraded');
    assert.equal(agg.shardErrors.length, 1, '仅坏 shard 记 error');
    assert.equal(agg.shardErrors[0]!.shardKey, 'shard#1', 'allShardDbs 顺序第 2 个是 bad → shard#1');
    assert.match(agg.shardErrors[0]!.error, /boom/, 'error 携带原始信息');
    /* data 是 s0 的部分聚合（pending=2），非静默当零、非整体抛。 */
    assert.equal(agg.data.pending, 2, 's0 部分聚合仍可见（坏 shard 不拖累健康 shard）');
    assert.equal(agg.data.failed, 0);
  });

  it('7. 单库零回归：SingleDbResolver 行为等价单库（degraded=false，聚合=单库值）', () => {
    const db = shardDb();
    seedBilling(db, 't', 'i-1', 'pending');
    seedTask(db, 'q-1', 'pending');
    seedUsage(db, 'u-1', 't', 'llm_tokens', 42, Date.now());
    const svc = new MetricsQueryService(new SingleDbResolver(db));
    assert.equal(svc.getBillingOutboxBacklog().data.pending, 1);
    assert.equal(svc.getQueueBacklog().data.pending, 1);
    const usage = svc.getTenantUsage(RETENTION_MS, 100);
    assert.equal(usage.degraded, false);
    assert.deepEqual(usage.data, [{ tenant_id: 't', resource: 'llm_tokens', total: 42 }]);
  });
});
