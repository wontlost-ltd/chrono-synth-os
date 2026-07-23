# 分片 Phase 0 · Plan 1：注入链统一（buildResolver + 单 resolver 穿全链）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development。步骤用 checkbox（`- [ ]`）追踪。

**Goal:** 建 `buildResolver`（config → 单/多库 `TenantDbResolver`）+ 把**唯一一个** resolver 实例从组合根 `app.ts` 穿进 `TenantOSFactory` + 每个 route + 每个子服务，替换所有内联 `new SingleDbResolver(...)`——使子服务从此按 tenantId 路由（多库时走对 shard，单库零回归）。**本 Plan 只做注入链统一，仍 fail-closed 挡多库启动**（不放开）；buildAppServices 逐成员 rewire + Auth mixed-scope 是 Plan 1b/1c，route 内 sharedDb 直用是 Plan 2。

**Architecture:** 组合根 `app.ts` 用 `buildResolver(config, hostDb)` 建**一个** `TenantDbResolver`（单库=`SingleDbResolver(hostDb)` 零回归；多库=`ShardRouter` seed hostDb 同实例，但本 Plan 仍 fail-closed 挡多库）。该实例穿进 `TenantOSFactory` + `registerXxxRoutes(app, os, config, db?, tenantFactory?, resolver)`（route 签名加 `resolver` 可选参，缺省 `new SingleDbResolver(os.getDatabase())` 保测试/直调）+ 替换 route 内所有 `new SingleDbResolver(sharedDb)` 为传入的共享 resolver。子服务 `fromResolver(config, resolver)` 从此运行时按 tenantId 解析 db。

**Tech Stack:** Node.js + TypeScript。复用 `ShardRouter`（`src/storage/shard-router.ts`，已实现，Plan 1 只在 buildResolver 里构造它但仍 fail-closed 挡）、`SingleDbResolver`（`src/storage/tenant-db-resolver.ts`）、`fromResolver` 子服务（TokenBudget/CostTracker/QuotaManager/UsageTracker/BillingOutbox，已 shard-ready）。测试 `src/test/unit/` + `FakeMultiShardResolver`（`src/test/support/`，2-shard 断言脚手架）。

## Global Constraints

（出自 spec §3-A / §8）

1. **单库零回归**：`config.db.shards` 空 → `buildResolver` 返 `SingleDbResolver(hostDb)`，全链行为与现状 `assert.deepEqual` 等价——现有全测试绿是硬门（SingleDbResolver 三方法返同一 db）。
2. **仍 fail-closed 挡多库**：本 Plan 不放开 `createDatabase` 的多-shard guard（那是 Plan 3）。buildResolver 多库分支可建 ShardRouter 但**不接进生产启动**——仅供 Plan 1 的 2-shard **测试**用 `FakeMultiShardResolver` 验路由，生产多库仍拒启动。
3. **一个 resolver 实例**：全链共享同一个 `TenantDbResolver`——禁再有内联 `new SingleDbResolver(...)` 局部构造（route/子服务都用穿进来的）。
4. **default=home 不变量**：单库下 default 与其他租户走同一 db（现状）；多库 seed 见 spec §4（本 Plan 不激活多库，仅 buildResolver 契约预留）。
5. **中文注释**；改动经 `test:golden`（含新 db-capability 门——注入链改动会动 inventory 里 requires-resolver-rewire 条目的接线状态，须同步；见约束 8）。
6. **不碰 sink 下沉的非本 Plan 部分**：buildAppServices 成员 rewire（Plan 1b）、Auth mixed-scope（Plan 1c）、route 内 sharedDb.prepare 直用（Plan 2）不在本 Plan——本 Plan 只做「穿 resolver 参 + 替换内联 SingleDbResolver」。
7. **测试位置** `src/test/unit/`（扁平）。
8. **db-capability 门同步**：本 Plan 把内联 `new SingleDbResolver(sharedDb)` 换成穿进的共享 resolver——受影响的 inventory flow contract 的 `coveredEdgeIds`/`disposition` 可能变（resolver 参穿进后某些 carrier 的 provenance 变 resolved）。跑 `npm run check:db-access`，红则**按真实归因更新 inventory**（若某 edge 从 unresolved 变 resolved 是真的接了 resolver，更新 disposition + wiringStatus 可留 planned——真接线验证是后续 wired/verified），不放宽门。

---

## File Structure

- `src/storage/build-resolver.ts` — `buildResolver(config, hostDb): TenantDbResolver`（新；单库 SingleDbResolver / 多库 ShardRouter seed hostDb）。
- `src/server/app.ts` — 用 `buildResolver` 建唯一 resolver + 穿进 factory + 各 registerXxxRoutes。
- `src/server/routes/*.ts` — 受影响 route（decisions/onboarding/companion 等有内联 `new SingleDbResolver`）签名加 `resolver` 可选参 + 替换内联构造。
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

test('多库（shards 非空）→ 建 ShardRouter，home shard seed = hostDb 同实例（default 落 host）', () => {
  const hostDb = new SqliteDatabase(':memory:');
  // 多库 config：home shard connStr 与 host 对应；buildResolver seed hostDb（见 spec §4/§5.3）
  const r = buildResolver(cfg({ s0: { connectionString: 'sqlite::memory:host' } }) /* homeShardId=s0 */, hostDb);
  // default 路由到 home shard = hostDb 同实例（注入式 seed，非另建）
  assert.equal(r.dbForTenant('default'), hostDb);
  r.allShardDbs?.().forEach((d) => { if (d !== hostDb) d.close(); });
});
```
> 注：多库 config 需 `homeShardId`——实现者按真实 schema 造（`config.db.homeShardId='s0'`）。`buildResolver` 多库分支构造 `ShardRouter` 并把 hostDb seed 进（home connStr 命中 → 返 hostDb 同实例，见 spec §5.3 seedDbs）。

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

export function buildResolver(config: AppConfig, hostDb: IDatabase): TenantDbResolver {
  const shards = config.db.shards;
  if (!shards || Object.keys(shards).length === 0) {
    return new SingleDbResolver(hostDb);   // 单库：三方法返同一 hostDb，零回归
  }
  const homeShardId = config.db.homeShardId;
  if (!homeShardId || !(homeShardId in shards)) {
    throw new Error(`buildResolver: 多库须 homeShardId ∈ shards（当前 '${homeShardId}'）`);
  }
  // 多库：ShardRouter，把 hostDb 显式 seed 进 home connStr（注入式同实例，spec §5.3——非 connStr 字符串比较）
  const flatShards: Record<string, string> = {};
  for (const [id, s] of Object.entries(shards)) flatShards[id] = (s as { connectionString: string }).connectionString;
  return new ShardRouter({
    shards: flatShards,
    homeShardId,
    coordinatorConnStr: config.db.coordinator?.connectionString,
    buildDb: (connStr) => { throw new Error(`buildResolver: 多库 buildDb 未接线（Plan 3 放开时实现；连接 ${connStr}）`); },
    seedDbs: { [flatShards[homeShardId]]: hostDb },   // home connStr → hostDb 同实例
  });
}
```
> 注：`ShardRouter` 若无 `seedDbs` 构造参（spec §5.3 要求加），实现者先给 `ShardRouter` 加 `seedDbs?: Record<connStr, IDatabase>`（构造时预填 `byConnStr`，标记外部拥有不 close）——这是 spec §4 可执行 seed 契约的落地。`buildDb` 多库真连接是 Plan 3；本 Plan `buildDb` 抛错即可（生产不走多库，测试用 seed 的 home + FakeMultiShardResolver 验路由）。

- [ ] **Step 4: 运行确认通过** — 2 测试

- [ ] **Step 5: Commit** — `git add src/storage/build-resolver.ts src/storage/shard-router.ts src/test/unit/build-resolver.test.ts && git commit -m "feat(shard): buildResolver（config→单/多库 resolver）+ ShardRouter seedDbs（home seed hostDb 同实例）"`（结尾 Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>）

---

## Task 2: app.ts 建唯一 resolver + 穿进 factory + route 签名加 resolver 参

**Files:**
- Modify: `src/server/app.ts`（`buildResolver` 建 resolver + 穿 factory + 各 registerXxxRoutes 传 resolver）
- Modify: 受影响 route（`decisions.ts`/`onboarding.ts`/`companion/chat.ts`/`companion/perceive.ts`/`companion/perceive-stream.ts`/`companion/learn-github.ts` 等有内联 `new SingleDbResolver` 的）签名加 `resolver?: TenantDbResolver` 参 + 替换内联为传入 resolver（缺省 `new SingleDbResolver(os.getDatabase())`）
- Test: `src/test/unit/injection-chain.test.ts`

**Interfaces:**
- 每 `registerXxxRoutes(app, os, config, db?, tenantFactory?, resolver?)`——`resolver` 可选参，缺省单库 SingleDbResolver（保测试/直调兼容）；app.ts 装配时穿真 resolver。

- [ ] **Step 1: 写失败测试（resolver 穿透 + 单库零回归 + 子服务 per-tenant）**

```typescript
// src/test/unit/injection-chain.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeMultiShardResolver } from '../support/fake-multi-shard-resolver.js';
// 用 FakeMultiShardResolver 注两 shard db，验子服务对不同 tenant 落不同 shard（证 resolver 真穿到子服务）
// 实现者：照既有 metering-subservices-sharding.test.ts 装配 TokenBudget/QuotaManager.fromResolver(fakeResolver)

test('TokenBudget.fromResolver(共享 resolver) 对 tenant A/B 各计量落各自 shard（不串账）', () => {
  // A→shard0, B→shard1（FakeMultiShardResolver 映射）→ 断言 A 的计量只在 shard0 db、B 只在 shard1
  // （这验的是「resolver 穿进子服务后按 tenantId 路由」——Plan 1 的核心）
});
```
> 实现者注：本 task 的核心可验点是「共享 resolver 穿进子服务，子服务按 tenantId 走对 shard」。照 `src/test/unit/metering-subservices-sharding.test.ts`（已存在）的既有断言模式。单库零回归靠 `test:golden` 全绿兜。

- [ ] **Step 2: 运行确认失败**

- [ ] **Step 3: 改 app.ts + route 签名**

app.ts：`const resolver = buildResolver(config, db);` 替换 `new SingleDbResolver(db)`；`new TenantOSFactory(resolver, ...)`；各 `registerXxxRoutes(app, os, config, db, tenantFactory, resolver)` 传 resolver。
route：签名末加 `resolver: TenantDbResolver = new SingleDbResolver(os.getDatabase())`；替换内部 `new SingleDbResolver(sharedDb)` → 用 `resolver`（子服务 `fromResolver(config, resolver)`）。**不动 route 内 `sharedDb.prepare(...)` 直用**（那是 Plan 2）。

- [ ] **Step 4: 运行确认通过 + 单库回归**

Run: `npx tsx --test src/test/unit/injection-chain.test.ts src/test/unit/metering-subservices-sharding.test.ts`
Expected: PASS（resolver 穿透 + 子服务 per-tenant）

- [ ] **Step 5: db-capability 门同步**

Run: `npm run check:db-access`
Expected: 可能红（内联 SingleDbResolver 换成穿进 resolver 后，某些 carrier provenance 从 unresolved 变 resolved / coveredEdgeIds 变）→ **按真实归因更新 inventory**（disposition 从 requires-resolver-rewire→resolver 且 provenance→resolved 的，更新；coveredEdgeIds/expectedCount 同步）。绿则过。**不放宽门**。

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
