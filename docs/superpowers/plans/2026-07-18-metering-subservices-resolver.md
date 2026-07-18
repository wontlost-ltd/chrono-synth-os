# 计量子服务双入口化 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `CostTracker`/`TokenBudget`/`UsageTracker` 三个计量子服务改为双入口（`fromResolver`/`fromUnitOfWork`），套用 QuotaManager 已立的模式，复用 `FakeMultiShardResolver` 探针脚手架。

**Architecture:** 三者全 per-tenant 方法、零 cross-tenant 方法（无 fan-out）。私有构造器 + 两静态工厂 + 内部 `MeterSource`（只 `forTenant`）。每个类的构造点在**它自己的 task 内原子迁移**（私有化即改全部该类构造点保编译）——三类互相独立，各自原子。单库（SingleDbResolver）+ UoW 模式逐字等价现状。

**Tech Stack:** TypeScript (NodeNext ESM, `.js` imports)，node:test，SQLite 内存库，`@chrono/kernel` 端口 + llm-usage/usage-records 命令。

## Global Constraints

- **零回归铁律**：单库（SingleDbResolver）+ UoW 模式与改造前逐字等价；全量 unit fail=0。
- **实际访问 db 才必经 forTenant**：真读写 db 的带 tenantId 方法经 `this.source.forTenant(tenantId)`；**纯内存方法（TokenBudget.recordUsage）不碰 source、不伪路由**。
- **UoW 模式固定 tx**：`forTenant` 忽略 tenantId 恒返 tx（结构上不可能重解析脱离事务）。
- **无 cross-tenant/fan-out**：三者无 `allShardDbs` 调用；`MeterSource` 只有 `forTenant`，不加 `allDbs`。
- **私有构造器 = 有意 API 破坏**：仓内全部该类构造点原子迁移保编译。
- **无适配层**：直接用 `IDatabase extends SyncWriteUnitOfWork`（`src/storage/database.ts:27`）。
- **inventory 不动**：三者不命中 ratchet；route 的 longlived-root-capture 条目保留；`check:db-access` 继续通过。
- 注释简体中文；ESM `.js`；同步（无 async）；无 `Math.random`；保留现有 `Date.now()` 用法。
- **构造点分类以声明静态类型为准**：声明 `IDatabase`→`fromResolver(new SingleDbResolver(x))`；声明**仅** `SyncWriteUnitOfWork`→`fromUnitOfWork(x)`。已核实唯一 fromUnitOfWork 点：`billing-route-facade.ts:77`（UsageTracker，`tx: SyncWriteUnitOfWork`）。

---

### Task 1: CostTracker 双入口 + 构造点原子迁移

**Files:**
- Modify: `src/intelligence/cost-tracker.ts`（私有构造器 + fromResolver/fromUnitOfWork + MeterSource）
- Modify: 全部 `new CostTracker(` 构造点（生产 3 + 测试）
- Test: `src/test/unit/model-router.test.ts`（其 CostTracker 构造点适配）

**Interfaces:**
- Consumes: `TenantDbResolver`/`SingleDbResolver`（`src/storage/tenant-db-resolver.js`）、`SyncWriteUnitOfWork`（`@chrono/kernel`）。
- Produces: `CostTracker.fromResolver(resolver)` / `CostTracker.fromUnitOfWork(tx)`；`record`/`getMonthlySummary`/`getRecent` 签名不变，内部经 source.forTenant。

- [ ] **Step 1: 写失败测试（双入口）**

在 `src/test/unit/model-router.test.ts`（或就近的 CostTracker 测试点）加一处最小断言（若无独立 CostTracker 测试文件，加到 model-router.test.ts 的相关 describe）：

```ts
import { SingleDbResolver } from '../../storage/tenant-db-resolver.js';
// 已有 CostTracker import 与内存 db 建法

it('CostTracker.fromResolver：record 落对应 db 且可读回', () => {
  const db = /* 该文件现有建 llm 表内存 db 方式 */;
  const ct = CostTracker.fromResolver(new SingleDbResolver(db));
  ct.record('tX', 'openai', 'gpt-x', 10, 20);
  const sum = ct.getMonthlySummary('tX');
  assert.ok(sum.totalTokens > 0, 'record 落库、getMonthlySummary 读回');
});
```

- [ ] **Step 2: 跑确认失败**

Run: `npm run build 2>&1 | grep -E "error TS" | head; node --test --test-force-exit dist/test/unit/model-router.test.js 2>&1 | grep -E "^ℹ (tests|pass|fail)"`
Expected: FAIL —— `CostTracker.fromResolver` 不存在 / 构造器私有后旧 `new CostTracker(db)` 编译红（Step 4 统一迁移）。

- [ ] **Step 3: 重构 CostTracker**

`src/intelligence/cost-tracker.ts` 全文重构（保留 record 的成本计算 + getMonthlySummary/getRecent 逻辑，只换 db 取源）：

```ts
import type { SyncWriteUnitOfWork } from '@chrono/kernel';
import { estimateCost, type CostRecord } from '@chrono/kernel';
import { llmCmdRecord, llmQueryMonthlySummary, llmQueryRecent } from '@chrono/kernel';
import { registerCoreSelfExecutors } from '../storage/executors/index.js';
import type { TenantDbResolver } from '../storage/tenant-db-resolver.js';

export type { CostRecord };

/** 内部 db 取源：resolver 模式按 tenantId 解析；UoW 模式固定 tx。 */
interface MeterSource {
  forTenant(tenantId: string): SyncWriteUnitOfWork;
}

export class CostTracker {
  private constructor(private readonly source: MeterSource) {
    registerCoreSelfExecutors();
  }

  static fromResolver(resolver: TenantDbResolver): CostTracker {
    return new CostTracker({ forTenant: (t) => resolver.dbForTenant(t) });
  }

  static fromUnitOfWork(tx: SyncWriteUnitOfWork): CostTracker {
    return new CostTracker({ forTenant: () => tx });
  }

  record(tenantId: string, provider: string, model: string, inputTokens: number, outputTokens: number): CostRecord {
    const cost = estimateCost(model, inputTokens, outputTokens);
    const now = Date.now();
    const rec: CostRecord = {
      tenantId, provider, model,
      inputTokens: cost.inputTokens, outputTokens: cost.outputTokens,
      totalTokens: cost.totalTokens, estimatedCostUsd: cost.estimatedCostUsd, timestamp: now,
    };
    this.source.forTenant(tenantId).execute(llmCmdRecord({
      tenantId, provider, model,
      inputTokens: cost.inputTokens, outputTokens: cost.outputTokens,
      totalTokens: cost.totalTokens, estimatedCostUsd: cost.estimatedCostUsd, now,
    }));
    return rec;
  }

  getMonthlySummary(tenantId: string): { totalCalls: number; totalTokens: number; totalInputTokens: number; totalOutputTokens: number; estimatedCostUsd: number } {
    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);
    const row = this.source.forTenant(tenantId).queryOne(llmQueryMonthlySummary({ tenantId, monthStartMs: monthStart.getTime() }));
    return {
      totalCalls: row?.total_calls ?? 0,
      totalTokens: row?.total_tokens ?? 0,
      totalInputTokens: row?.total_input ?? 0,
      totalOutputTokens: row?.total_output ?? 0,
      estimatedCostUsd: row?.total_cost ?? 0,
    };
  }

  getRecent(tenantId: string, limit = 20): readonly CostRecord[] {
    const rows = this.source.forTenant(tenantId).queryMany(llmQueryRecent({ tenantId, limit }));
    return rows.map(r => ({
      tenantId: r.tenant_id, provider: r.provider, model: r.model,
      inputTokens: r.input_tokens, outputTokens: r.output_tokens, totalTokens: r.total_tokens,
      estimatedCostUsd: r.estimated_cost_usd, timestamp: r.recorded_at,
    }));
  }
}
```

（无-db 第三态砍掉：原 `db?` 可选 + `this.tx=null` + 方法内 `if(this.tx)` 分支全删——生产无人用，且 fail-silent 反模式。）

- [ ] **Step 4: 迁移全部 CostTracker 构造点（同提交保编译）**

`grep -rn "new CostTracker(" src --include="*.ts"` 复核。已知：
- 生产 `fromResolver(new SingleDbResolver(x))`（x 声明 IDatabase）：`memory-facade.ts:102`（`this.sharedDb`）、`decisions.ts:68`（`sharedDb`）、`onboarding.ts:71`（`sharedDb`）。**注意 memory-facade:102 现是 `config ? new CostTracker(this.sharedDb) : undefined`——保留 config 三元，改成 `config ? CostTracker.fromResolver(new SingleDbResolver(this.sharedDb)) : undefined`**。
- 测试 → `CostTracker.fromUnitOfWork(db)`（内存 db，单库语境）：`model-router.test.ts:192` + 复核有无其它。
- 每个 fromResolver 文件按目录深度 import `SingleDbResolver`（`src/intelligence/` 是 `../storage/`；`src/core/` 是 `../storage/`；`src/server/routes/` 是 `../../storage/`——按文件实际位置）。

- [ ] **Step 5: 跑确认通过 + typecheck + grep 无残留**

Run:
```bash
npm run typecheck 2>&1 | tail -2
npm run build >/dev/null 2>&1; echo "build=$?"
grep -rn "new CostTracker(" src --include="*.ts" && echo "!!!残留" || echo "无直接构造（预期）"
node --test --test-force-exit dist/test/unit/model-router.test.js 2>&1 | grep -E "^ℹ (tests|pass|fail)"
```
Expected: typecheck 0；无 `new CostTracker(` 残留；model-router 测试绿。

- [ ] **Step 6: 提交**

```bash
git add src/intelligence/cost-tracker.ts src/core/memory-facade.ts src/server/routes/decisions.ts src/server/routes/onboarding.ts src/test/unit/model-router.test.ts
git commit -m "$(printf 'feat(intelligence): CostTracker 双入口（fromResolver/fromUnitOfWork）\n\n私有构造器 + MeterSource（只 forTenant，无 fan-out）。record/getMonthlySummary/\ngetRecent 经 source.forTenant。砍无-db 第三态（fail-silent 反模式，生产无人用）。\n全部构造点原子迁移保编译。\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

### Task 2: TokenBudget 双入口（保 config 首参，纯读服务）+ 构造点原子迁移

**Files:**
- Modify: `src/intelligence/token-budget.ts`（私有构造器 + fromResolver(config, resolver)/fromUnitOfWork(config, tx) + MeterSource）
- Modify: 全部 `new TokenBudget(` 构造点（生产 3 + 测试 3）
- Test: `src/test/unit/model-router.test.ts`（TokenBudget 构造点适配）

**Interfaces:**
- Consumes: `TenantDbResolver`/`SingleDbResolver`、`SyncWriteUnitOfWork`。
- Produces: `TokenBudget.fromResolver(config, resolver)` / `TokenBudget.fromUnitOfWork(config, tx)`；`checkBudget`/`recordUsage`/`checkAlert`/`getSummary` 签名不变。

- [ ] **Step 1: 写失败测试（双入口，config 位保留）**

```ts
it('TokenBudget.fromResolver：getSummary 按 tenantId 读对应 db', () => {
  const db = /* 建 llm 表内存 db */;
  const tb = TokenBudget.fromResolver({ /* 现有 config 形状，或 undefined 用默认 */ }, new SingleDbResolver(db));
  const sum = tb.getSummary('tX');
  assert.ok(sum, 'getSummary 返回结构');
});
```

- [ ] **Step 2: 跑确认失败**

Run: `npm run build 2>&1 | grep -E "error TS" | head; node --test --test-force-exit dist/test/unit/model-router.test.js 2>&1 | grep -E "^ℹ (tests|pass|fail)"`
Expected: FAIL（fromResolver 不存在 / 私有构造器致旧构造点红）。

- [ ] **Step 3: 重构 TokenBudget**

`src/intelligence/token-budget.ts`：
- 加 `import type { TenantDbResolver } from '../storage/tenant-db-resolver.js';`
- 内部 `interface MeterSource { forTenant(tenantId: string): SyncWriteUnitOfWork; }`
- 私有构造器 `private constructor(private readonly config: TokenBudgetConfig, private readonly source: MeterSource)`（config 处理沿用现有默认合并逻辑）。
- `static fromResolver(config: Partial<TokenBudgetConfig> | undefined, resolver: TenantDbResolver)`：`new TokenBudget(合并后config, { forTenant: (t) => resolver.dbForTenant(t) })`。
- `static fromUnitOfWork(config: Partial<TokenBudgetConfig> | undefined, tx: SyncWriteUnitOfWork)`：`new TokenBudget(合并后config, { forTenant: () => tx })`。
- **读方法**（`checkBudget`/`checkAlert`/`getSummary` 经私有 `getUsage`）：`getUsage(tenantId)` 内 `this.source.forTenant(tenantId).queryOne(llmQueryPeriodTotal(...))`（把现有 `this.tx.queryOne` 换成 `this.source.forTenant(tenantId)`）。
- **`recordUsage`（纯内存）**：保持原样只写 `this.cache` Map，**不碰 source**（红线：纯内存不伪路由）。
- 砍无-db 第三态（原 `db?` 可选 + `this.tx=null` + `if(this.tx)` 分支删；getUsage 直接用 source）。

（保留 `getUsage` 的 monthStart/dayStart 计算 + cache 逻辑，只换 db 取源为 `this.source.forTenant(tenantId)`。）

- [ ] **Step 4: 迁移全部 TokenBudget 构造点（同提交）**

`grep -rn "new TokenBudget(" src --include="*.ts"` 复核。已知：
- 生产 `fromResolver(config, new SingleDbResolver(x))`：`memory-facade.ts:101`（`config ? new TokenBudget(config.intelligence.budget, this.sharedDb) : undefined` → `config ? TokenBudget.fromResolver(config.intelligence.budget, new SingleDbResolver(this.sharedDb)) : undefined`）、`decisions.ts:67`（`new TokenBudget(config.intelligence.budget, sharedDb)` → `TokenBudget.fromResolver(config.intelligence.budget, new SingleDbResolver(sharedDb))`）、`onboarding.ts:70`（同款）。
- 测试 → `TokenBudget.fromUnitOfWork(config, db)`：`model-router.test.ts:136/150/167`。

- [ ] **Step 5: typecheck + build + grep 无残留 + 测试绿**

Run:
```bash
npm run typecheck 2>&1 | tail -2
npm run build >/dev/null 2>&1; echo "build=$?"
grep -rn "new TokenBudget(" src --include="*.ts" && echo "!!!残留" || echo "无直接构造（预期）"
node --test --test-force-exit dist/test/unit/model-router.test.js 2>&1 | grep -E "^ℹ (tests|pass|fail)"
```
Expected: typecheck 0；无残留；测试绿。

- [ ] **Step 6: 提交**

```bash
git add src/intelligence/token-budget.ts src/core/memory-facade.ts src/server/routes/decisions.ts src/server/routes/onboarding.ts src/test/unit/model-router.test.ts
git commit -m "$(printf 'feat(intelligence): TokenBudget 双入口（保 config 首参，纯读服务）\n\n私有构造器 + fromResolver(config,resolver)/fromUnitOfWork(config,tx)。读方法\n（checkBudget/checkAlert/getSummary 经 getUsage）走 source.forTenant；recordUsage\n纯内存不碰 source（红线：不伪路由）。砍无-db 第三态。构造点原子迁移。\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

### Task 3: UsageTracker 双入口 + 构造点原子迁移

**Files:**
- Modify: `src/billing/usage-tracker.ts`（私有构造器 + fromResolver/fromUnitOfWork + MeterSource）
- Modify: 全部 `new UsageTracker(` 构造点（生产 5 + 测试 7）
- Test: 涉及的测试文件构造点适配

**Interfaces:**
- Consumes: `TenantDbResolver`/`SingleDbResolver`、`SyncWriteUnitOfWork`。
- Produces: `UsageTracker.fromResolver(resolver)` / `UsageTracker.fromUnitOfWork(tx)`；`record`/`getUsage`/`getSummary` 签名不变。

- [ ] **Step 1: 写失败测试**

```ts
it('UsageTracker.fromResolver：record 落对应 db 且可读回', () => {
  const db = /* 建 usage_records 表内存 db */;
  const ut = UsageTracker.fromResolver(new SingleDbResolver(db));
  ut.record('tX', 'sim', 3);
  assert.equal(ut.getUsage('tX', 'sim'), 3);
});
```

- [ ] **Step 2: 跑确认失败**

Run: `npm run build 2>&1 | grep -E "error TS" | head`
Expected: FAIL。

- [ ] **Step 3: 重构 UsageTracker**

`src/billing/usage-tracker.ts`：私有构造器 + `MeterSource` + 两工厂（同 CostTracker 结构）。`record`/`getUsage`/`getSummary` 经 `this.source.forTenant(tenantId)`。现构造 `(tx: SyncWriteUnitOfWork)` 声明放宽——两工厂各自接 resolver / tx。

- [ ] **Step 4: 迁移全部 UsageTracker 构造点（同提交）**

`grep -rn "new UsageTracker(" src --include="*.ts"` 复核。已知：
- 生产 `fromResolver(new SingleDbResolver(x))`（声明 IDatabase）：`memory-facade.ts:104`（`sharedTx`）、`life-simulations.ts:41`（`optTx`，`options?.db` IDatabase；保留 `optTx ? ... : undefined` 三元）、`onboarding.ts:76`（`sharedTx`）、`decisions.ts:71`（`sharedTx`）。
- 生产 `fromUnitOfWork(tx)`（**声明仅 SyncWriteUnitOfWork**）：`billing-route-facade.ts:77`（`tx`，构造器 `:74` `tx: SyncWriteUnitOfWork`）。
- 测试 → `UsageTracker.fromUnitOfWork(db)`：`model-router.test.ts:292`、`conversation-billing-usage.test.ts:71`、`billing-uow-entrance.test.ts:32/33`、`billing-usage-outbox.test.ts:43/55`、`billing-api.test.ts:133`。

- [ ] **Step 5: typecheck + build + grep 无残留 + 相关测试绿**

Run:
```bash
npm run typecheck 2>&1 | tail -2
npm run build >/dev/null 2>&1; echo "build=$?"
grep -rn "new UsageTracker(" src --include="*.ts" && echo "!!!残留" || echo "无直接构造（预期）"
node --test --test-force-exit dist/test/unit/model-router.test.js dist/test/unit/billing-uow-entrance.test.js 2>&1 | grep -E "^ℹ (tests|pass|fail)"
```
Expected: typecheck 0；无残留；测试绿。

- [ ] **Step 6: 提交**

```bash
git add src/billing/usage-tracker.ts src/core/memory-facade.ts src/server/routes/life-simulations.ts src/server/routes/onboarding.ts src/server/routes/decisions.ts src/billing/billing-route-facade.ts
git add -A  # 测试文件构造点
git commit -m "$(printf 'feat(billing): UsageTracker 双入口（fromResolver/fromUnitOfWork）\n\n私有构造器 + MeterSource。record/getUsage/getSummary 经 source.forTenant。\nbilling-route-facade 走 fromUnitOfWork（声明仅 SyncWriteUnitOfWork），其余 fromResolver。\n构造点原子迁移。\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

### Task 4: 探针测试（一文件三 describe + 变异证明）

**Files:**
- Create: `src/test/unit/metering-subservices-sharding.test.ts`

**Interfaces:**
- Consumes: 三个子服务的 `fromResolver`/`fromUnitOfWork`（Task 1-3）、`FakeMultiShardResolver`（上片 `src/test/support/fake-multi-shard-resolver.ts`）、`SingleDbResolver`、`createMemoryDatabase`+`runDslSqliteMigrations`。

- [ ] **Step 1: 写探针测试（三 describe）**

创建 `src/test/unit/metering-subservices-sharding.test.ts`。helper `meterDb()`=createMemoryDatabase + runDslSqliteMigrations。

**describe CostTracker（写路由，对称）：**
```ts
it('per-tenant 分流对称：tA 落 shard1、tB 落 shard2', () => {
  const s1 = meterDb(), s2 = meterDb();
  const r = new FakeMultiShardResolver({ coordinator: s1, shards: { a: s1, b: s2 }, tenantToShard: { tA: 'a', tB: 'b' } });
  const ct = CostTracker.fromResolver(r);
  ct.record('tA', 'openai', 'm', 10, 1);
  ct.record('tB', 'openai', 'm', 20, 1);
  assert.ok(CostTracker.fromUnitOfWork(s1).getMonthlySummary('tA').totalTokens > 0, 'tA 落 s1');
  assert.equal(CostTracker.fromUnitOfWork(s2).getMonthlySummary('tA').totalTokens, 0, 'tA 不在 s2');
  assert.ok(CostTracker.fromUnitOfWork(s2).getMonthlySummary('tB').totalTokens > 0, 'tB 落 s2');
  assert.equal(CostTracker.fromUnitOfWork(s1).getMonthlySummary('tB').totalTokens, 0, 'tB 不在 s1');
});
it('UoW 模式落该 db', () => { /* fromUnitOfWork(db).record → 同 db 读回 */ });
it('单库零回归：SingleDbResolver 等价', () => { /* fromResolver(new SingleDbResolver(db)) record/read */ });
```

**describe UsageTracker（写路由，对称）：** 同 CostTracker 结构，用 `record(tenant,'sim',n)` + `getUsage` 对称断言 tA 落 s1 不在 s2、tB 落 s2 不在 s1 + UoW + 零回归。

**describe TokenBudget（读路由——它无 db 写方法）：**
```ts
it('per-tenant 读路由：getSummary 按 tenantId 从对应 shard 读', () => {
  const s1 = meterDb(), s2 = meterDb();
  /* 用 CostTracker 往各 shard 预置不同值的 llm_usage（TokenBudget 读的就是这表）——纯公共 API，不碰裸 SQL。
     预置在首次读之前完成（防 TokenBudget cache 假阳性）。 */
  CostTracker.fromUnitOfWork(s1).record('tA', 'openai', 'm', 11, 0);  // tA→s1，input=11
  CostTracker.fromUnitOfWork(s2).record('tB', 'openai', 'm', 22, 0);  // tB→s2，input=22（不同值）
  const r = new FakeMultiShardResolver({ coordinator: s1, shards: { a: s1, b: s2 }, tenantToShard: { tA: 'a', tB: 'b' } });
  const tb = TokenBudget.fromResolver(undefined /* 默认 config */, r);
  /* getSummary 读 llm_usage 的 used——断言 tA 读到 s1 的量、tB 读到 s2 的量（值不同，能区分路由）。
     用 getSummary 返回的精确 used 字段（核对 TokenBudget.getSummary 返回结构的字段名，用 used/月度总量那个）。 */
  const sumA = tb.getSummary('tA');
  const sumB = tb.getSummary('tB');
  assert.notDeepEqual(sumA, sumB, 'tA/tB 读到不同 shard 的不同用量（证明按 tenantId 路由读）');
  /* 更强：断言具体 used 值对应各自 shard 预置量（核对字段名后写死期望）。 */
});
it('recordUsage 内存 cache 隔离（行为回归，非分流探针）', () => { /* 不碰 resolver，验 tenantId 维度 cache 隔离 */ });
```
（实现者核对 `TokenBudget.getSummary` 返回结构的确切字段名——预置的 input/total token 反映到哪个返回字段，写死期望值使断言精确、可被变异抓。）

- [ ] **Step 2: 跑确认通过**

Run: `npm run build >/dev/null 2>&1; node --test --test-force-exit dist/test/unit/metering-subservices-sharding.test.js 2>&1 | grep -E "^ℹ (tests|pass|fail)"`
Expected: 全绿。

- [ ] **Step 3: 变异证明（三个，不提交变异）**

对每个子服务各变异一次证探针非重言式：
- CostTracker：临时改 `fromResolver` 的 `forTenant` 恒返 `resolver.coordinatorDb()`（=s1，无视 tenantId），重 build 跑 → CostTracker「per-tenant 分流对称」应变红（tB 落 s2 断言失败）。
- UsageTracker：同上变异 → UsageTracker 分流应红。
- TokenBudget：改 `getUsage` 里 `forTenant` 恒返 coordinatorDb（s1）→ TokenBudget 读路由「tA/tB 不同」应红（都读 s1）。
每次变异后 `git checkout` 还原对应源文件、重 build 确认恢复绿。三次变异结果写进 report。

- [ ] **Step 4: 提交**

```bash
git add src/test/unit/metering-subservices-sharding.test.ts
git commit -m "$(printf 'test(multi-tenant): 计量子服务分片探针（CostTracker/UsageTracker 写路由 + TokenBudget 读路由 + 变异）\n\n对称分流断言（tA 落 s1 不在 s2、tB 反之）；TokenBudget 用 CostTracker 预置\nllm_usage 后验读路由（它无 db 写）；三次变异各触发对应 describe 红后还原。\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

### Task 5: 全量回归 + inventory/ratchet 验证（纯验证）

> 三类构造点已在各自 Task 原子迁移。本任务全仓验证，无源码改动（除非发现回归须修）。

**Files:** 无预期改动。

- [ ] **Step 1: 无残留直接构造**

Run: `for c in TokenBudget CostTracker UsageTracker; do grep -rn "new $c(" src --include="*.ts" | grep -vE "src/intelligence/token-budget.ts|src/intelligence/cost-tracker.ts|src/billing/usage-tracker.ts" && echo "!!!$c 外部残留" || echo "$c 外部零残留"; done`
Expected: 三者外部零残留（仅类内自身工厂合法）。

- [ ] **Step 2: 全量 unit 回归**

Run:
```bash
npm run typecheck 2>&1 | tail -2; npm run build >/dev/null 2>&1; echo "build=$?"
node --test --test-force-exit 'dist/test/unit/**/*.test.js' 2>&1 | grep -E "^ℹ (tests|suites|pass|fail)"
```
Expected: typecheck 0；build 0；**全量 unit fail=0**（baseline 本批前 2102）。

- [ ] **Step 3: ratchet 不变**

Run: `node scripts/check-db-access-ratchet.mjs; echo "ratchet=$?"`
Expected: exit 0，26 条不变（三者改持 source 不命中 ratchet PATTERN，inventory 条目保留）。

- [ ] **Step 4: 集成点验（Task 3 改了 billing 集成测试构造点）**

Run:
```bash
node --test --test-force-exit \
  dist/test/integration/billing-api.test.js \
  dist/test/integration/conversation-billing-usage.test.js \
  2>&1 | grep -E "^ℹ (tests|pass|fail)"
```
（核对这些文件是否真存在于 integration 目录；若 billing-uow-entrance/billing-usage-outbox 在 unit 目录则已被 Step 2 覆盖。）
Expected: 全绿（PG 相关若无 PG 则 SKIP）。

- [ ] **Step 5: 无提交（纯验证）或补记**

无源码改动则无需提交。若发现回归并修复则提交修复。

---

## Self-Review

**1. Spec coverage**：
- CostTracker 双入口 → Task 1。✓ TokenBudget（纯读+config 位）→ Task 2。✓ UsageTracker → Task 3。✓
- 探针（写路由 CostTracker/UsageTracker + 读路由 TokenBudget + 变异）→ Task 4。✓
- 全部构造点分类迁移（fromUnitOfWork 仅 billing-route-facade）→ 各 Task 内原子迁移。✓
- inventory 不动 / 零回归 → Task 5。✓
- usage_records 多-shard 风险 → spec 已登记为后续子片（本计划不实现，符合范围）。✓

**2. Placeholder scan**：探针测试代码块里 `meterDb()` / 建库方式 / getSummary 字段名标注了「核对现有方式/字段名」——是有意的核对指令（配 fallback），非占位。无 TBD。

**3. Type consistency**：`MeterSource { forTenant }` 在 Task 1 定义，Task 2/3 一致（各类内联）；`fromResolver`/`fromUnitOfWork` 签名一致（TokenBudget 多 config 首参）；探针用的工厂名与 Task 1-3 产出一致。

**4. 编译原子性**：每个类的私有化 + 全部该类构造点在**同一 Task 内**迁移（Task 1/2/3 各自原子）——比 QuotaManager 那批更利落（三类独立）。Task 4/5 建立在三类已迁移基础。

**注意点（实现者）：**
- 三类的 MeterSource 会是三份逐字相同的 `interface MeterSource { forTenant... }`——**遵循「重复三次再通用化」**：本计划让三份内联（与 QuotaManager 风格一致，不新增跨文件抽象）；Task 3 完成后若觉值得提取共享 helper，作为独立后续小重构，不在本计划范围。
- TokenBudget.getSummary 返回结构的字段名（used/月度量）实现者核对后在探针写死期望值。
- 每个 fromResolver 文件的 `SingleDbResolver` import 相对深度按文件位置。
