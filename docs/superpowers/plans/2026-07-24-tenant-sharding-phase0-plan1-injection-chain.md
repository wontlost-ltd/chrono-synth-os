# 分片 Phase 0 · Plan 1：注入链统一（buildResolver + 单 resolver 穿全链）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development。步骤用 checkbox（`- [ ]`）追踪。
> 第 3 轮修订（采纳 Codex 79 退回）：buildResolver 多库 fail-closed throw(不构造 runtime)+route deps 对象 resolver 必填(避 TS1016)+createApp assertShardingActivationAllowed guard(防 seam 绕过)+ShardRouter seedDbs 独立单测+删多库 :memory: 身份自相矛盾测。前轮 72 退。

**Goal:** 建 `buildResolver`（单库→`SingleDbResolver`；多库→`throw`）+ 把**唯一一个** resolver 实例从组合根 `app.ts` 穿进 `TenantOSFactory` + 每个 route（deps 对象 resolver 必填）+ 每个子服务，替换所有内联 `new SingleDbResolver(...)`——使子服务从此按 tenantId 路由（单库零回归；多库路由由 FakeMultiShardResolver 测试验，生产 fail-closed 挡）。buildAppServices 逐成员 rewire + Auth mixed-scope 是 Plan 1b/1c，route 内 sharedDb 直用是 Plan 2。

**Architecture:** 组合根 `app.ts` 用 `buildResolver(config, hostDb)` 建**一个** `TenantDbResolver`——**单库=`SingleDbResolver(hostDb)`（零回归）；多库=直接 `throw MultiShardRuntimeNotReady`（Codex 第 2 轮裁决：Plan 1 不激活多库，buildResolver 不伪装能安全建多库 runtime——那是 Plan 3 typed bundle 携 verified identity 的事）**。该 resolver 实例穿进 `TenantOSFactory` + 每个 `registerXxxRoutes`（**签名改 deps 对象，resolver 必填**，避免 TS1016 必填参跟可选参后 + 十几处传错位置）+ 替换 route 内所有 `new SingleDbResolver(sharedDb)` 为传入的共享 resolver。子服务 `fromResolver(config, resolver)` 从此运行时按 tenantId 解析 db。`ShardRouter.seedDbs`（borrowed/owned）作为**独立能力单测**（供 Plan 3 复用），不由 Plan 1 的 buildResolver 接生产。

**Tech Stack:** Node.js + TypeScript。复用 `ShardRouter`（`src/storage/shard-router.ts`，Plan 1 只加 seedDbs 能力单测，buildResolver 不构造多库 runtime）、`SingleDbResolver`（`src/storage/tenant-db-resolver.ts`）、`fromResolver` 子服务（TokenBudget/CostTracker/QuotaManager/UsageTracker/BillingOutbox，已 shard-ready）。测试 `src/test/unit/` + `FakeMultiShardResolver`（`src/test/support/`，2-shard 断言脚手架）。

## Global Constraints

（出自 spec §3-A / §8）

1. **单库零回归**：`config.db.shards` 空 → `buildResolver` 返 `SingleDbResolver(hostDb)`，全链行为与现状 `assert.deepEqual` 等价——现有全测试绿是硬门（SingleDbResolver 三方法返同一 db）。
2. **仍 fail-closed 挡多库**：本 Plan 不放开多库。**buildResolver 多库分支直接 throw**（不建 ShardRouter runtime——那是 Plan 3 typed bundle）；`createDatabase` guard 保留；`createApp` 用注入 resolver 前也须 `assertShardingActivationAllowed(config)`（防 deps.resolver 绕过 guard，Codex 第 2 轮 #3）。2-shard 路由验证用 `FakeMultiShardResolver` 经 createApp seam 注入（config.db.shards 空 + 注入 fake，验注入链不解除 config guard）。
3. **一个 resolver 实例（必填，非可选回退——Codex 退回 #1）**：全链共享同一个 `TenantDbResolver`，route 的 resolver **必填**（无 `= new SingleDbResolver(...)` 默认回退——那是静默错-shard 逃生口，Plan 3 放开时会漏）。测试/直调显式传 `new SingleDbResolver(testDb)` 或用测试 helper。**机械门**：`rg -n 'new SingleDbResolver' src/server/app.ts src/server/routes` 结果只允许「组合根 app.ts 建唯一那个」+ 明确批准的测试 helper，**其余零**（本 Plan 收尾断言）。禁在生产 route 函数内部静默构造 fallback。
4. **default=home 不变量**：单库下 default 与其他租户走同一 db（现状）；多库 seed 见 spec §4（本 Plan 不激活多库，仅 buildResolver 契约预留）。
5. **中文注释**；改动经 `test:golden`（含新 db-capability 门——注入链改动会动 inventory 里 requires-resolver-rewire 条目的接线状态，须同步；见约束 8）。
6. **不碰 sink 下沉的非本 Plan 部分**：buildAppServices 成员 rewire（Plan 1b）、Auth mixed-scope（Plan 1c）、route 内 sharedDb.prepare 直用（Plan 2）不在本 Plan——本 Plan 只做「穿 resolver 参 + 替换内联 SingleDbResolver」。
7. **测试位置** `src/test/unit/`（扁平）。
8. **db-capability 门同步**：本 Plan 把内联 `new SingleDbResolver(sharedDb)` 换成穿进的共享 resolver——受影响的 inventory flow contract 的 `coveredEdgeIds`/`disposition` 可能变（resolver 参穿进后某些 carrier 的 provenance 变 resolved）。跑 `npm run check:db-access`，红则**按真实归因更新 inventory**（若某 edge 从 unresolved 变 resolved 是真的接了 resolver，更新 disposition + wiringStatus 可留 planned——真接线验证是后续 wired/verified），不放宽门。

---

## File Structure

- `src/storage/build-resolver.ts` — `buildResolver(config, hostDb): TenantDbResolver`（新；单库 SingleDbResolver / 多库 throw MultiShardRuntimeNotReady）+ `assertShardingActivationAllowed`。
- `src/server/app.ts` — 用 `buildResolver` 建唯一 resolver + 穿进 factory + 各 registerXxxRoutes。
- `src/server/routes/*.ts` — 受影响 route 签名改 **deps 对象（resolver 必填）** + 替换内联 `new SingleDbResolver`。
- Test: `src/test/unit/build-resolver.test.ts` + `src/test/unit/injection-chain-*.test.ts`。

---

## Task 1: `buildResolver` — config → 单/多库 resolver（多库仍 fail-closed 挡生产）

**Files:**
- Create: `src/storage/build-resolver.ts`
- Test: `src/test/unit/build-resolver.test.ts`

**Interfaces:**
- Consumes: `AppConfig`（`config.db.shards`/`.coordinator`/`.homeShardId`，`config/schema.ts:22-24` 真实形状 `Record<shardId,{connectionString}>`）、`SingleDbResolver`/`ShardRouter`/`IDatabase`。
- Produces: `buildResolver(config: AppConfig, hostDb: IDatabase): TenantDbResolver`。

- [ ] **Step 1: 写失败测试**

```typescript
// src/test/unit/build-resolver.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildResolver } from '../../storage/build-resolver.js';
import { SingleDbResolver } from '../../storage/tenant-db-resolver.js';
import { SqliteDatabase } from '../../storage/database.js';

function cfg(shards?: unknown) {
  return { db: { driver: 'sqlite', path: ':memory:', shards, pool: { max: 10, idleTimeoutMs: 30000 } } } as never;
}

test('单库（shards 空）→ SingleDbResolver，三方法同一 db（零回归）', () => {
  const db = new SqliteDatabase(':memory:');
  const r = buildResolver(cfg(undefined), db);
  assert.ok(r instanceof SingleDbResolver);
  assert.equal(r.dbForTenant('t1'), db);
  assert.equal(r.coordinatorDb(), db);
  assert.deepEqual(r.allShardDbs(), [db]);
  db.close();
});

test('多库（shards 非空）→ buildResolver throw MultiShardRuntimeNotReady（Plan 1 不构造多库 runtime）', () => {
  const hostDb = new SqliteDatabase(':memory:');
  assert.throws(
    () => buildResolver(cfg({ s0: { connectionString: 'postgres://h' } }), hostDb),
    /多库 runtime 未就绪|MultiShardRuntimeNotReady/,
  );
  hostDb.close();
});
```
> 注：Plan 1 buildResolver 只单库；多库 fail-closed throw（Codex 裁决——不伪装能安全建多库 runtime，verified identity seed 是 Plan 3 typed bundle）。`:memory:` 字符串相等证明不了同实例，故不用 connStr 比较验 seed。

- [ ] **Step 2: 运行确认失败** — `npx tsx --test src/test/unit/build-resolver.test.ts`（FAIL：模块不存在）

- [ ] **Step 3: 写 `buildResolver`**

```typescript
// src/storage/build-resolver.ts
/** 组合根建唯一 TenantDbResolver：单库 SingleDbResolver（零回归）/ 多库 ShardRouter（home seed hostDb 同实例）。
 * 本 Plan 生产仍 fail-closed 挡多库（createDatabase guard 未放开）；多库分支供 Plan 1 测试 + Plan 3 放开复用。 */
import type { AppConfig } from '../config/schema.js';
import type { IDatabase } from './database.js';
import type { TenantDbResolver } from './tenant-db-resolver.js';
import { SingleDbResolver } from './tenant-db-resolver.js';
import { ShardRouter } from './shard-router.js';

/** 多库尚未就绪（Plan 3 typed bundle 携 verified identity 构造）——Plan 1 buildResolver fail-closed。 */
export class MultiShardRuntimeNotReadyError extends Error {
  constructor() { super('多库 runtime 未就绪（Plan 3 放开）——buildResolver 仅支持单库；多库须经 typed bundle'); }
}

export function buildResolver(config: AppConfig, hostDb: IDatabase): TenantDbResolver {
  const shards = config.db.shards;
  if (!shards || Object.keys(shards).length === 0) {
    return new SingleDbResolver(hostDb);   // 单库：三方法返同一 hostDb，零回归
  }
  // 多库：Plan 1 不构造 runtime（不伪装能安全建多库——须 verified identity seed，Plan 3 typed bundle 做）。fail-closed。
  throw new MultiShardRuntimeNotReadyError();
}
```
> 注（Codex 第 2 轮裁决——buildResolver 多库直接 fail-closed，不构造 ShardRouter runtime）：
> - Plan 1 buildResolver 只单库；多库 throw（`createDatabase` guard 本就挡多库，此处双重保险 + 诚实：不伪装能安全建多库 runtime）。
> - **`ShardRouter.seedDbs`（borrowed/owned）作为独立能力单测**（Task 1b，供 Plan 3 复用，不由 buildResolver 接）：加 `seedDbs?: Record<connStr, IDatabase>`（构造预填 `byConnStr`，标记 borrowed）；close ownership 测：`close()` 不关 borrowed / owned 每个恰关一次 / `initialize()` 中途失败只关 owned 不关 seed / coordinator 与 home 共 seed 不重复关 / 幂等 / 非 home 未接 buildDb fail-closed。**同步改 `shard-router.ts:7` 「所有池唯一 owner」注释**（加 borrowed 例外）。
> - verified physical identity（PG URL canonical / SQLite realpath / `:memory:` 实例级 token）是 Plan 3 typed bundle 的事——Plan 1 不做（`:memory:` 字符串相等证明不了同实例，Codex 核实）。

- [ ] **Step 4: 运行确认通过** — 2 测试

- [ ] **Step 5: Commit** — `git add src/storage/build-resolver.ts src/test/unit/build-resolver.test.ts && git commit -m "feat(shard): buildResolver（单库 SingleDbResolver / 多库 fail-closed throw）"`（结尾 Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>）

---

## Task 1b: `ShardRouter.seedDbs`（borrowed/owned close ownership）——独立能力，供 Plan 3 复用

**Files:** Modify `src/storage/shard-router.ts`（加 `seedDbs?: Record<connStr, IDatabase>` + borrowed 标记 + close 只关 owned）；Test `src/test/unit/shard-router-seed.test.ts`

**关键**：`seedDbs` 构造预填 `byConnStr` 且标记 **borrowed（外部拥有）**；`close()` 只关 owned（buildDb 建的），不关 borrowed；`initialize()` 中途失败只回收 owned。改 `shard-router.ts:7` 的「所有池唯一 owner」注释加 borrowed 例外。

- [ ] **Step 1: 写失败测试**（borrowed seed close() 不关它+owned 恰关一次+init 未接 buildDb 时非 home 访问 fail-closed+coordinator 与 home 共 seed 不重复关+close 幂等——用 close 计数断言，非手工遍历 allShardDbs）
- [ ] **Step 2: 运行确认失败**
- [ ] **Step 3: 加 seedDbs + borrowed 集 + close 只关 owned**
- [ ] **Step 4: 运行确认通过**（各场景 close 计数正确）
- [ ] **Step 5: Commit** — `feat(shard): ShardRouter seedDbs（borrowed 外部拥有不 close，供 Plan 3 typed bundle 复用）`

---

## Task 2: app.ts 建唯一 resolver + 穿进 factory + route 签名加 resolver 参

**Files:**
- Modify: `src/server/app.ts`（`buildResolver` 建 resolver + 穿 factory + 各 registerXxxRoutes 传 resolver）
- Modify: 受影响 route（清单表所列 decisions/onboarding/companion/me/tasks/personas/admin-templates/life-simulations/persona-core 等）签名改 **deps 对象 resolver 必填** + 替换内联为 `deps.resolver`（无默认回退）
- Test: `src/test/unit/injection-chain.test.ts`

**Interfaces:**
- 每 `registerXxxRoutes(app, os, config, db, tenantFactory, resolver)`——`resolver` **必填**（无默认回退，Codex #1）；测试/直调显式传 `new SingleDbResolver(testDb)`。

**内联 SingleDbResolver 精确清单（Codex 退回 #2——穷举非「等」）+ 本 Plan 处置**：
| 位置 | 现内联 | 本 Plan 处置 | 归属 |
|---|---|---|---|
| `app.ts:300` TenantOSFactory | `new SingleDbResolver(db)` | → `buildResolver(config, db)` 唯一 resolver | **Plan 1** |
| `app.ts:402` queue QuotaManager | `new SingleDbResolver(queueTx)` | → 共享 resolver | **Plan 1** |
| `app.ts:462/466/467` bulkImport/p1dUsage/p1dBilling | `new SingleDbResolver(tx)` | → 共享 resolver | **Plan 1** |
| `app.ts:511/512/513` conversation budget/cost/quota | `new SingleDbResolver(db/tx)` | → 共享 resolver | **Plan 1** |
| `app.ts:944` retention BillingOutbox | `new SingleDbResolver(tx)` | → 共享 resolver | **Plan 1** |
| routes: decisions(5)/onboarding(5)/companion·chat/perceive/perceive-stream/learn-github/me(2)/admin-templates/tasks/personas/persona-core/life-simulations(3) | `new SingleDbResolver(sharedDb/tx)` | 子服务 fromResolver 的那些 → 穿进的共享 resolver | **Plan 1** |
| `core/memory-facade.ts` | `new SingleDbResolver(...)` | route 内 id-based UPDATE 直用（§5.2 具名点） | **Plan 2** |
| `persona-core/runtime-recovery-worker.ts` | `new SingleDbResolver(os.getDatabase())` | worker per-shard fan-out | **Plan 2**（§5.2 worker） |
> buildAppServices 成员构造（`app-services.ts` 用 root db，非上表内联 SingleDbResolver 而是裸 db 传 service ctor）= **Plan 1b**。route 内 `sharedDb.prepare(...WHERE tenant_id=?)` 直查 = **Plan 2**。
> **机械门（收尾）**：`rg -n 'new SingleDbResolver' src/server/app.ts src/server/routes` → 只剩 `app.ts` 那**一个** buildResolver 内部（若 buildResolver 单库分支用它）+ 明确测试 helper，routes 内**零**（Plan 1 处置的都换成穿进 resolver；memory-facade/worker 是 Plan 2 但它们不在 routes 目录）。

- [ ] **Step 1: 写失败测试（resolver 穿透 + 单库零回归 + 子服务 per-tenant）**

```typescript
// src/test/unit/injection-chain.test.ts —— 真验 app→route→子服务 同一 resolver 实例（Codex 退回 #3）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeMultiShardResolver } from '../support/fake-multi-shard-resolver.js';
// 关键：给 createApp 加测试 seam `deps.resolver`——注入同一个 FakeMultiShardResolver，
// 走真实 route 注册，发 tenant A/B 请求，断言 route 内真实子服务写到 shard A/B。
// 直接测 TokenBudget.fromResolver(fake) 不够（那只重证 shard-ready，metering-subservices 已证）。

test('createApp 注入 fake resolver → decisions/onboarding/companion route 内子服务对 A/B 写各自 shard', async () => {
  const fake = new FakeMultiShardResolver({ /* coordinator + shards{s0,s1} + tenantToShard{A:s0,B:s1} */ } as never);
  const { app } = await buildTestApp({ resolver: fake });   // seam：createApp 未传时才 buildResolver(config,hostDb)
  // 对 tenant A、B 各发一个会触发子服务计量的请求 → 断言 A 的行只在 shard0 db、B 只在 shard1（不串）
  // 至少覆盖 decisions/onboarding/companion 各一条代表链（非直接构造子服务）
});

test('同一 resolver 实例穿透：真两租户请求经 route 子服务写各自 shard（行为验，非仅 param spy）', async () => {
  const fake = new FakeMultiShardResolver({ /* coordinator + s0/s1 + A:s0,B:s1 */ } as never);
  const { app } = await buildTestApp({ resolver: fake });
  // 明确 endpoint + 认证/tenant 前置：对 A 发触发 TokenBudget/Quota/Usage 写的请求 → 断言记录只在 shard0 db；B→shard1
  // （行为测试为主；identity spy 可作补充，但不代替——Codex 第 2 轮）
});

test('createApp seam 不解除 config guard：config.db.shards 非空 + 注入 fake resolver → 仍拒启动', async () => {
  const fake = new FakeMultiShardResolver({} as never);
  await assert.rejects(
    () => buildTestApp({ config: /* 含非空 shards */ multiShardConfig, resolver: fake }),
    /拒绝启动|MultiShardRuntimeNotReady|activation/,
  );  // 证 deps.resolver 绕不过 assertShardingActivationAllowed
});
```
> 实现者注：核心是**真经 createApp→route→子服务链**验同一 resolver（非直接 new 子服务）。给 `createApp` 加 `deps.resolver` seam（生产未传时 `buildResolver(config, hostDb)`）。`buildTestApp` 用既有 route 集成测试夹具（照 `src/test/integration/persona-core-api.test.ts`）。若某 route 忘穿 resolver，此测试须能抓（identity 断言或 A/B 串 shard）。单库零回归靠 `test:golden` 全绿兜。

- [ ] **Step 2: 运行确认失败**

- [ ] **Step 3: 改 app.ts + route 签名**

app.ts：**加 `deps.resolver` 测试 seam + guard**——`assertShardingActivationAllowed(config)`（`config.db.shards` 非空即抛，防 deps.resolver 绕过 createDatabase guard，Codex 第 2 轮 #3）→ `const resolver = deps.resolver ?? buildResolver(config, db);`；替换 `new SingleDbResolver(db)`；`new TenantOSFactory(resolver, ...)`；各 route 传 resolver。app.ts 9 处内联全换共享 resolver。
route：**签名改 deps 对象，resolver 必填**（Codex 第 2 轮 #1——必填参不能跟可选参后=TS1016；deps 对象避免十几处传错位置）：`registerXxxRoutes(app, deps: { os, config, db?, tenantFactory?, resolver })`。替换内部 `new SingleDbResolver(sharedDb)` → `deps.resolver`（子服务 `fromResolver(config, deps.resolver)`）。**不动 route 内 `sharedDb.prepare(...)` 直用**（Plan 2）。route 测试/直调改显式传 `resolver: new SingleDbResolver(testDb)`——**靠 `npm run typecheck` 编译捕获所有漏改调用点**（比人工清单可靠）。

- [ ] **Step 4: 运行确认通过 + 单库回归**

Run: `npx tsx --test src/test/unit/injection-chain.test.ts src/test/unit/metering-subservices-sharding.test.ts`
Expected: PASS（resolver 穿透 + 子服务 per-tenant）

- [ ] **Step 5: db-capability 门同步 + wiringStatus 推进（Codex #5）**

Run: `npm run check:db-access`
Expected: 可能红（内联 SingleDbResolver 换穿进 resolver 后 carrier provenance / coveredEdgeIds 变）→ **按真实归因更新 inventory**：
- 本 Plan 真改成共享 resolver 的 edge → `wiringStatus: 'wired'`（代码已用共享 resolver，尚无 2-shard 行为验证）；
- 被 Task 2 Step 4 的真两租户 route 测试覆盖的 → 可 `'verified'`；
- route 内 sharedDb.prepare（Plan 2）+ buildAppServices（Plan 1b）留项仍 `'planned'`。
- **wiringStatus 与 provenance（resolved/unresolved）是两个轴**——resolved 表 scanner 能追来源，wired/verified 表接线进度。绿则过，**不放宽门**。

- [ ] **Step 6: Commit** — `feat(shard): app.ts 建唯一 resolver 穿全链 + route 加 resolver 参替换内联 SingleDbResolver`

---

## 收尾（全 task 完成后）

- [ ] **本地全量门**：`npm run test:golden`（EXIT 0；单库零回归——现有全测试绿；check:db-access 门同步后绿）。
- [ ] **2-shard 路由验收（FakeMultiShardResolver）**：确认共享 resolver 穿进子服务后，两 tenant 落不同 shard（Plan 1 的核心价值——虽生产仍 fail-closed 挡多库，但注入链已就位）。
- [ ] **最终整片 code review**（重点核：真只有一个 resolver 实例穿全链、无残留内联 SingleDbResolver、单库零回归、db-capability 门同步无放宽）。

## Self-Review（writing-plans 自检）

**Spec 覆盖**：spec §3-A「注入链统一：一个 resolver 穿全链」→ Task 1（buildResolver）+ Task 2（穿 app.ts/factory/route）。§4 default=home seed 契约 → Task 1 ShardRouter seedDbs。**本 Plan 是 Plan 1 的 A 段基础切片**；buildAppServices 逐成员 rewire（spec §3-A buildAppServices）+ Auth mixed-scope（§4.1）是后续 Plan 1b/1c（本 Plan 只穿基础注入链，不含 ~15 buildAppServices 成员的逐个 rewire——那量大且独立可测，单列）。

**Placeholder 扫描**：无 TBD；buildResolver/app.ts 改动有完整代码；测试委托既有 metering-subservices-sharding.test.ts / FakeMultiShardResolver 惯例（非占位，是复用现成 2-shard 脚手架）。

**边界**：本 Plan 仍 fail-closed 挡多库生产（约束 2）——注入链就位但未放开，零风险。db-capability 门（Plan 0）会捕捉注入链改动对 inventory 的影响（约束 8），确保接线真做了而非漏。

**已知实现期待核实点**：`ShardRouter` 加 `seedDbs` 构造参（spec §5.3 契约落地）；route 真实签名（各 registerXxxRoutes 现有参数顺序）；`config.db.homeShardId`/`coordinator` schema 字段（`config/schema.ts:22-24` 已核实形状）。
