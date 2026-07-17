/**
 * 计量子服务多-shard 分片探针（Phase 0「子服务 resolver 模式」子片验收，第 4 任务）。
 * 用 FakeMultiShardResolver 注多个独立物理内存 db，断言 CostTracker/UsageTracker（写路由）
 * 和 TokenBudget（读路由）三个已双入口化子服务的分片路由分流正确——「铺路不激活」子片
 * 唯一能真正验证正确性的手段：单库下 dbForTenant 与 coordinatorDb 是同一 db，
 * 普通功能测试证不出路由对错；本探针注独立 db，让「数据真落对 shard / 真从对 shard 读」可断言。
 *
 * 对称断言（非「恰好等于目标」单侧断言）：tA 落 s1 且不在 s2、tB 落 s2 且不在 s1——
 * 防止「forTenant 恒返 s1」这类 bug 因单侧断言碰巧通过（tA 本该在 s1，恒返 s1 也「通过」）。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CostTracker } from '../../intelligence/cost-tracker.js';
import { UsageTracker } from '../../billing/usage-tracker.js';
import { TokenBudget } from '../../intelligence/token-budget.js';
import { FakeMultiShardResolver } from '../support/fake-multi-shard-resolver.js';
import { SingleDbResolver } from '../../storage/tenant-db-resolver.js';
import { createMemoryDatabase, runDslSqliteMigrations } from '../../storage/index.js';
import type { IDatabase } from '../../storage/database.js';

/** 建带计量表（llm_usage / usage_records 等）的内存 db（迁移入口——runDslSqliteMigrations 建全表）。 */
function meterDb(): IDatabase {
  const db = createMemoryDatabase();
  runDslSqliteMigrations(db);
  return db;
}

describe('CostTracker 分片探针（写路由，对称）', () => {
  it('per-tenant 分流对称：tA 落 shard1、tB 落 shard2', () => {
    const s1 = meterDb();
    const s2 = meterDb();
    const r = new FakeMultiShardResolver({ coordinator: s1, shards: { a: s1, b: s2 }, tenantToShard: { tA: 'a', tB: 'b' } });
    const ct = CostTracker.fromResolver(r);
    ct.record('tA', 'openai', 'm', 10, 1);
    ct.record('tB', 'openai', 'm', 20, 1);

    /* 对称：tA 落 s1 且不在 s2；tB 落 s2 且不在 s1。单侧断言无法抓「forTenant 恒返 s1」类 bug。 */
    assert.ok(CostTracker.fromUnitOfWork(s1).getMonthlySummary('tA').totalTokens > 0, 'tA 落 s1');
    assert.equal(CostTracker.fromUnitOfWork(s2).getMonthlySummary('tA').totalTokens, 0, 'tA 不在 s2');
    assert.ok(CostTracker.fromUnitOfWork(s2).getMonthlySummary('tB').totalTokens > 0, 'tB 落 s2');
    assert.equal(CostTracker.fromUnitOfWork(s1).getMonthlySummary('tB').totalTokens, 0, 'tB 不在 s1');
  });

  it('UoW 模式落该 db', () => {
    const db = meterDb();
    const ct = CostTracker.fromUnitOfWork(db);
    ct.record('t', 'openai', 'm', 5, 2);
    assert.equal(CostTracker.fromUnitOfWork(db).getMonthlySummary('t').totalTokens, 7, 'input+output 落同一 db 可读回');
  });

  it('单库零回归：SingleDbResolver 等价', () => {
    const db = meterDb();
    const ct = CostTracker.fromResolver(new SingleDbResolver(db));
    ct.record('t', 'openai', 'm', 4, 1);
    assert.equal(ct.getMonthlySummary('t').totalTokens, 5, '单库 resolver 行为等价直连 db');
  });
});

describe('UsageTracker 分片探针（写路由，对称）', () => {
  it('per-tenant 分流对称：tA 落 shard1、tB 落 shard2', () => {
    const s1 = meterDb();
    const s2 = meterDb();
    const r = new FakeMultiShardResolver({ coordinator: s1, shards: { a: s1, b: s2 }, tenantToShard: { tA: 'a', tB: 'b' } });
    const ut = UsageTracker.fromResolver(r);
    ut.record('tA', 'sim', 3);
    ut.record('tB', 'sim', 7);

    /* 对称：tA 落 s1 不在 s2；tB 落 s2 不在 s1。 */
    assert.equal(UsageTracker.fromUnitOfWork(s1).getUsage('tA', 'sim'), 3, 'tA 落 s1');
    assert.equal(UsageTracker.fromUnitOfWork(s2).getUsage('tA', 'sim'), 0, 'tA 不在 s2');
    assert.equal(UsageTracker.fromUnitOfWork(s2).getUsage('tB', 'sim'), 7, 'tB 落 s2');
    assert.equal(UsageTracker.fromUnitOfWork(s1).getUsage('tB', 'sim'), 0, 'tB 不在 s1');
  });

  it('UoW 模式落该 db', () => {
    const db = meterDb();
    const ut = UsageTracker.fromUnitOfWork(db);
    ut.record('t', 'sim', 6);
    assert.equal(UsageTracker.fromUnitOfWork(db).getUsage('t', 'sim'), 6, '同 db 读回记录量');
  });

  it('单库零回归：SingleDbResolver 等价', () => {
    const db = meterDb();
    const ut = UsageTracker.fromResolver(new SingleDbResolver(db));
    ut.record('t', 'sim', 2);
    assert.equal(ut.getUsage('t', 'sim'), 2, '单库 resolver 行为等价直连 db');
  });
});

describe('TokenBudget 分片探针（读路由——它无 db 写方法）', () => {
  it('per-tenant 读路由：getSummary 按 tenantId 从对应 shard 读', () => {
    const s1 = meterDb();
    const s2 = meterDb();
    /* 用 CostTracker（纯公共 API，不碰裸 SQL）往各 shard 预置不同值的 llm_usage——
       TokenBudget.getSummary 读的正是这张表（llmQueryPeriodTotal SUM total_tokens）。
       outputTokens=0 保证 total_tokens 恰好等于 inputTokens，值可精确核对。
       预置须在首次读之前完成（防 TokenBudget 内存 cache 假阳性——cache 命中会跳过 db 读）。 */
    CostTracker.fromUnitOfWork(s1).record('tA', 'openai', 'm', 11, 0); // tA→s1，input=11
    CostTracker.fromUnitOfWork(s2).record('tB', 'openai', 'm', 22, 0); // tB→s2，input=22（不同值，防「恒返 s1」类 bug 因数值凑巧相等而漏检）

    const r = new FakeMultiShardResolver({ coordinator: s1, shards: { a: s1, b: s2 }, tenantToShard: { tA: 'a', tB: 'b' } });
    /* 每个断言前用新 TokenBudget 实例读，避免同一实例的内存 cache 跨租户复用造成假阳性。 */
    const sumA = TokenBudget.fromResolver(undefined, r).getSummary('tA');
    const sumB = TokenBudget.fromResolver(undefined, r).getSummary('tB');

    assert.notDeepEqual(sumA, sumB, 'tA/tB 读到不同 shard 的不同用量（证明按 tenantId 路由读）');
    /* 精确核对 monthly.used 字段（核对过 computeUsageSummary：monthly.used = getUsage 的 monthlyUsed，
       即 llmQueryPeriodTotal 的 SUM(total_tokens)）——写死期望值使断言可被变异抓（非仅「不相等」）。 */
    assert.equal(sumA.monthly.used, 11, 'tA 读到 s1 预置的 11');
    assert.equal(sumB.monthly.used, 22, 'tB 读到 s2 预置的 22');
  });

  it('recordUsage 内存 cache 隔离（行为回归，非分流探针）', () => {
    /* recordUsage 只写内存 cache、不碰 source/resolver（TokenBudget 设计红线：纯内存方法不伪路由）；
       且只在该 tenantId 当日/当月 cache 已存在时才累加（否则视为脏 cache 丢弃，见 token-budget.ts:112-122）。
       故须先读一次（populate cache），recordUsage 才会生效；验证 cache 按 tenantId 维度隔离：
       tA 记账不应污染 tB 的用量读数（各自独立 cache entry）。 */
    const db = meterDb();
    CostTracker.fromUnitOfWork(db).record('tA', 'openai', 'm', 10, 0);
    CostTracker.fromUnitOfWork(db).record('tB', 'openai', 'm', 20, 0);
    const tb = TokenBudget.fromUnitOfWork(undefined, db);
    tb.getSummary('tA'); // populate tA 的 cache entry（monthlyUsed=10）
    tb.getSummary('tB'); // populate tB 的 cache entry（monthlyUsed=20）
    tb.recordUsage('tA', 100); // 命中已存在 cache → 累加：10+100=110
    tb.recordUsage('tB', 5);   // 命中已存在 cache → 累加：20+5=25
    assert.equal(tb.getSummary('tA').monthly.used, 110, 'tA cache 累加到 110（不查库，命中 cache）');
    assert.equal(tb.getSummary('tB').monthly.used, 25, 'tB 独立 cache 累加到 25，不受 tA 影响');
  });
});
