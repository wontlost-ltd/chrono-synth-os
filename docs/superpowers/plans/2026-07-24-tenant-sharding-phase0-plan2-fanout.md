# 租户分片 Phase 0 · Plan 2（fan-out）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development 逐 task 实现。步骤用 checkbox（`- [ ]`）跟踪。
>
> spec `docs/superpowers/specs/2026-07-24-tenant-sharding-phase0-plan2-fanout-design.md`（Codex 64→87→95 通过）。计划第 3 轮修订：**改用「implementer 自核签名」模式**——设计约束定死（fan-out 模式/隔离铁律/合并算法/健康状态机语义），但**具体真实签名由 implementer subagent 先 Read/codegraph 核验再 TDD**（不在计划里写从记忆推的伪代码——前两轮从记忆写伪代码引入了 runMediaRetention arity/Logger 签名等编译错，交给有代码上下文的 implementer 核更可靠）。observability 独立进程已拆出（见下）。
>
> **⚠️ implementer 铁律（每 task 必做）**：改任何函数前，先 `Read` 目标函数的**真实签名**（ctor 参数、返回类型）+ 调用的工具函数（如 `runMediaRetention`/`Logger.error`/`ToolPermissionService.pruneInvocationsBefore`/kernel query factory）的真实签名 + 现有该 worker/route 的**测试文件**（迁移它们到新 ctor/签名，别留旧签名调用编译错）。TDD red-first 会抓签名不符——先让红测试暴露真实契约，再按真实契约实现。计划给的是**意图+文件+模式+测试锚**，不是可粘贴的代码。

## 关键约定（全 task 统一）

- **shardKey 稳定物理库标识**：`allShardDbs()` 只返 `IDatabase[]`，`IDatabase` 无公开 connStr。建 `src/storage/shard-key.ts` 导出 `makeShardKeyer(): (db: IDatabase) => string`（内部 `WeakMap<IDatabase,string>` + 单调计数器，`shard#0/shard#1/...` 按首见顺序）。每 worker 一个 keyer 实例，fan-out 循环 `const shardKey = this.keyer(shardDb)`。测试断言按 shardKey 稳定（非数组下标）。
- **公共可配置 throwingDb 测试桩（Codex：5 现有桩语义不同不能统一为全抛）**：建 `src/test/support/throwing-db.ts` 导出 `throwingDb(opts?: { on?: 'execute' | 'queryMany' | 'queryOne' | 'prepare' | 'all' }): IDatabase`——按 `opts.on` 指定的方法抛错、其余 no-op/返空（默认 `on:'execute'`）。**逐文件按原语义迁移** 5 现有 *-sharding.test.ts（billing/quota/template 原 execute 抛→`throwingDb({on:'execute'})`；persona-marketplace/persona-core 原 queryMany 抛→`throwingDb({on:'queryMany'})`），跑这 5 测确认行为不变。Plan 2 新测按需选 `on`。
- **observability 独立进程拆出（真交付物，非只声明）**：Plan 2 **不含** observability worker fan-out。其跨 shard（Kafka consumer-group 路由/多 pipeline 生命周期/monitor 聚合）是独立子设计——**待本 Plan 2 完成后，另起独立 spec+plan 单独走**。本计划 Self-Review 的 spec 覆盖据此排除 observability（spec §范围里 observability 那条明确 defer）。
- **ShardAggregate 通用类型**：建 `src/observability/shard-aggregate.ts` 导出 `interface ShardAggregate<TData> { data: TData; degraded: boolean; shardErrors: Array<{ shardKey: string; error: string }> }` + `aggregateShards<TShard, TData>(resolver, keyer, perShard: (db: IDatabase) => TShard, merge: (results: TShard[]) => TData): ShardAggregate<TData>`（**双泛型** TShard/TData，遍历 allShardDbs 逐 shard perShard 收集 + merge 成功结果 + shardErrors 收失败）。
- **kernel query 链（Codex：新 raw query 需全链）**：Task5 的无-limit tenant usage raw query 需在 `packages/kernel/src/domain/.../metrics-queries.ts` 加 query constant+factory+类型+export，再在 `src/storage/executors/metrics-query-executors.ts` 注册——implementer 照现有 metrics query 的 kernel→executor 链核验后补全链（非只改 executor）。

**Goal:** 消除分片后「全局 worker/timer 只处理 home shard=静默漏」「route 内联 tenant-scoped 直查走 host db=错 shard」「metrics 跨租户聚合只读 home shard=假低值」三类 sink，让跨租户扫描经 `resolver.allShardDbs()` fan-out、租户级直查经 `dbForTenant`、平台表经 `coordinatorDb`。最高优先=GDPR MediaRetention。

**Architecture:** 照抄已有 3 fan-out 先例（BillingOutbox `shardErrors` 隔离 / QuotaManager fromResolver / PersonaCoreService allDbs）。每跨租户 worker 循环 `allShardDbs()` 逐 shard try/catch 隔离 + 聚合。单库 `SingleDbResolver.allShardDbs()=[db]` 零回归。不放开 fail-closed（Plan 3）。

**Tech Stack:** TypeScript、`TenantDbResolver.allShardDbs()`、`FakeMultiShardResolver` + `throwingDb()` 桩（`src/test/unit/billing-outbox-sharding.test.ts` 先例）、node:test。

## Global Constraints

- **零-LLM 内核铁律**：纯路由 fan-out，无 LLM。
- **fan-out 隔离铁律**：跨租户 worker 循环逐 shard try/catch，单 shard 抛错 catch 记 `shardErrors` + 继续下一 shard，绝不因一 shard 挂导致其他 shard 的 GDPR 擦除/结算/清理被跳过。
- **GDPR 健康状态机（spec 定死）**：MediaRetention 任一 shard 本轮**抛错 OR `failed>0`**→立即 `isHealthy()=false`；per-shard 连续失败次数+最后失败时间（**用稳定物理库标识非数组下标**，Codex writing-plans note）；该 shard 下轮 `failed===0` 且无异常→清除；所有 shard 恢复才 true。两失败路径（shard 抛错 + runMediaRetention 返 failed>0）都记 `meterShardEraseFailure`（**按失败 shard-run 计数**，Codex note）+ logger.error（非 info）+ 暴露到 metrics surface（JSON/Prometheus + degraded gauge）。timer `shardErrors>0` 或任一 `failed>0` 必须 logger.error。
- **DualWrite ledger 亲和性**：`for (const shardDb of allShardDbs()) { const ledger = new SqliteEventLedger(shardDb); await flushOutbox(shardDb, ledger); }`——循环内每 shard 现构造 ledger，绝不复用中心 ledger（防跨 shard 串写）。
- **Token 落 shard**：refresh_tokens 落各租户 shard（Plan 1c）；cleanupExpiredTokens fan-out `allShardDbs()`（非 coordinatorDb）。
- **metrics partial failure**：scatter-gather 返回固定 `{ data, degraded: shardErrors.length>0, shardErrors }`；某 shard 失败绝不静默当零。
- **metrics 合并算法定死**：diversity 各 shard 原始 styles concat 后**全局重算** `personalityDiversity`（非局部分数 SUM）；backlog/count SUM；rollup `updated_at` 取 MAX；tenant usage 全局 merge+sort+limit（非各 shard 各 limit）。
- **单库零回归**：SingleDbResolver 下所有现有 worker/timer/metrics 测试绿。
- **worker ctor 改注入 resolver**：app.ts 装配点照 `reservationRecoveryWorker` 的 `captureResolver(site)` 参照系同步；worker start/stop/onClose/isHealthy 统一手法不变。
- **inventory 逐 edge 校准**：per-shard-worker/route 直查 edge 真 fan-out+2-shard 测覆盖→planned→verified；未覆盖保持 planned（诚实，非 mass-upgrade）。
- **不含（Plan 3）**：TaskQueue 分片、companion/perceive/OS 大 carrier typed bundle、放开 fail-closed、真 2-shard PG 验收。

---

## File Structure

- Worker fan-out：`src/perception/media/media-retention-worker.ts`、`src/workers/dual-write-flush-worker.ts`、`src/billing/settlement-reconciliation-worker.ts`、`src/persona-core/runtime-recovery-worker.ts`、`src/agent/tool-invocations-retention-worker.ts`。（observability 独立进程不含，拆独立 plan。）
- Timer：`src/server/app.ts`（retention timer :950-981、cleanupExpiredTokens :941-948）、`src/identity/auth-service.ts`（cleanupExpiredTokens fan-out）。
- Metrics：`src/server/routes/metrics.ts`、`src/observability/metrics-query-service.ts`。
- Route 直查：`src/server/routes/decisions.ts`、`onboarding.ts`、`admin-deployment.ts`、`onboarding-v2.ts`。
- 装配：`src/server/app.ts`（worker ctor 传 resolver）。
- inventory：`src/storage/db-access-inventory.ts` + `src/test/unit/db-access-inventory-completeness.test.ts`。
- 测试：每 worker 一个 `*-sharding.test.ts`（照 billing-outbox-sharding.test.ts 脚手架）。

---

## Task 1: MediaRetentionWorker GDPR fan-out + 健康状态机（最优先）

**Files:**
- Create: `src/storage/shard-key.ts`（`makeShardKeyer` 工具）
- Create: `src/test/support/throwing-db.ts`（公共 throwingDb 桩）+ 改 5 现有 *-sharding.test.ts 的本地 throwingDb 为 import（保持行为不变）
- Modify: `src/perception/media/media-retention-worker.ts`（ctor 收 resolver + flushOnce fan-out + 健康状态机 + metric）
- Modify: `src/server/app.ts:602-611`（装配传 resolver + eraser 不变）
- Modify: `src/server/routes/metrics.ts`（暴露 `mediaRetentionShardEraseFailures` counter + `mediaRetentionDegraded` gauge 到 JSON/Prometheus surface——照该文件现有 `billingMetrics`/`observabilityPipelineMetrics` 暴露方式）
- Modify: metric 定义处（找 `meterShardFlushErrors` 所在 metrics 模块，加 `meterShardEraseFailure(shardKey)` 同款 counter）
- Test: `src/test/unit/media-retention-sharding.test.ts`（新建）

**Interfaces:**
- Consumes: `TenantDbResolver.allShardDbs()`、`runMediaRetention`（**先 Read 真实签名**——Codex 核为 `(tx, eraser, now: number)` 3 参返 `{erased, failed}`，别传 options）、`makeShardKeyer`、`Logger`（真实 `error(layer, message, data?)`）。
- Produces: `MediaRetentionWorker` ctor 首参 `tx: SyncWriteUnitOfWork` → `resolver: TenantDbResolver`（eraser/logger/now/options 其余不变）；`flushOnce(): Promise<{ totalErased: number; totalFailed: number; shardErrors: Array<{ shardKey: string; error: string }> }>`（**保留 totalFailed + per-shard**）；`isHealthy()` = `timer !== undefined && shardFailures.size === 0`（保 timer 生命周期语义）；private `shardFailures: Map<string, { consecutiveFailures: number; lastFailureAt: number }>` + `keyer = makeShardKeyer()`。

- [ ] **Step 0: 建公共工具（本 task 前置，全 Plan 复用）**

`src/storage/shard-key.ts`：`export function makeShardKeyer(): (db: IDatabase) => string { const m = new WeakMap<IDatabase, string>(); let n = 0; return (db) => { let k = m.get(db); if (!k) { k = \`shard#\${n++}\`; m.set(db, k); } return k; }; }`。
`src/test/support/throwing-db.ts`：`export function throwingDb(): IDatabase { ... }`（照 `billing-outbox-sharding.test.ts` 现有本地 throwingDb 抄一份，全方法抛）；改 5 个现有 *-sharding.test.ts（persona-marketplace-recovery/quota-manager/persona-template-service/persona-core-service/billing-outbox）的本地 `throwingDb` 为 `import { throwingDb } from '../support/throwing-db.js'`，跑这 5 测确认行为不变。

- [ ] **Step 1: 写 GDPR fan-out + 健康状态机测（红）**

`media-retention-sharding.test.ts`（FakeMultiShardResolver 2 shard + import throwingDb）：
1. **fan-out 擦除**：s0/s1 各 seed 过期 media ref → flushOnce → 两 shard 过期 media 都被 `runMediaRetention` 擦 + 擦除器对两 shard 都调；`totalErased`=两 shard 之和、`totalFailed`===0、shardErrors 空。
2. **仅 home 会漏（旧行为锚）**：断言 s1 的 media 确被擦（若只跑 allShardDbs()[0] 则 s1 漏）——聚合计数证真 fan-out。
3. **shard 抛错隔离 + 健康**：throwingDb() 作 s1 的 db（FakeMultiShardResolver shards.b=throwingDb()）→ flushOnce shardErrors 含 `{shardKey:'shard#1', error}` + s0 仍擦(totalErased>0) + `meterShardEraseFailure` 被调 + logger.error(非 info) + `isHealthy()===false`。
4. **failed>0 路径**：eraser 对 s1 的对象擦除抛（runMediaRetention 内部捕获返 `{erased, failed>0}`，不进 shard catch）→ 断言 totalFailed>0 + 记 meterShardEraseFailure + logger.error + isHealthy false。
5. **恢复（用可切换桩，非固定 throwingDb）**：用**可切换的 eraser 桩**（布尔开关：先 `failNext=true` 让 s1 的对象擦除抛→runMediaRetention 返 failed>0→isHealthy false；再 `failNext=false` 下一轮 s1 failed===0）→ 断言 shardFailures 删该 shard；两 shard 都好且 timer 已 start → isHealthy true。（不能用固定 throwingDb——它不会自动"修好"；恢复测试须用状态可变的桩。）

- [ ] **Step 2: 跑测确认失败** — `npx tsx --test src/test/unit/media-retention-sharding.test.ts`，Expected FAIL（ctor 裸 tx）。

- [ ] **Step 3: 改 MediaRetentionWorker（先核签名再改）**

**先 Read**：`runMediaRetention` 真实签名（`media-ref-store.ts`——Codex 核为 `(tx, eraser, now: number)` 3 参返 `{erased, failed}`，**用真实参数别传多余的 options**）；`Logger` 接口真实签名（Codex 核为 `error(layer: string, message: string, data?: unknown)`——**按真实参数顺序调**，别写 `error(obj, msg)`）；BillingOutbox 的 shard-error metric 真实形态（Codex 核为内存数字 `billingMetrics.meterShardFlushErrors++` 非函数——**照真实形态**给 media 加同款内存 counter）。

改法（意图，签名以 Read 为准）：
- ctor 首参 `tx: SyncWriteUnitOfWork` → `resolver: TenantDbResolver`（eraser/logger/now/options 不变）；`private keyer = makeShardKeyer()`；`private shardFailures = new Map<string, { consecutiveFailures: number; lastFailureAt: number }>()`。
- flushOnce 遍历 `this.resolver.allShardDbs()`：每 shard `this.keyer(shardDb)` → try `runMediaRetention(shardDb, this.eraser, this.now())`（**真实 3 参**）累加 erased/failed；`failed>0` → recordFailure + media shard-error counter++ + `logger.error`（真实签名）；成功 → recordSuccess（`shardFailures.delete`）；catch → shardErrors.push + recordFailure + counter++ + logger.error。返回 `{ totalErased, totalFailed, shardErrors }`（保留 totalFailed）。
- `recordFailure(k)` 累加 consecutiveFailures + lastFailureAt；`recordSuccess(k)` 删。
- **isHealthy 保留 timer 生命周期语义**（Codex：现未 start/stop 后应 false）：`return this.timer !== undefined && this.shardFailures.size === 0`（不能只判 shardFailures.size）。
- timer 回调 flushOnce 后：`if (r.shardErrors.length > 0 || r.totalFailed > 0) logger.error(...)`（强制告警非「决定」）。
- **metric 所有权定死**：media shard-error 用**模块级内存 counter**（照 billingMetrics 形态）；`registerMetricsRoutes` 读该模块级 counter + worker 的 degraded 状态暴露 `mediaRetentionShardEraseFailures` + `mediaRetentionDegraded` gauge（route 从模块级 metrics + 注入的 worker.isHealthy 读，别把 worker 实例散到 route——用模块级 metrics 状态是 codebase 既有模式，Read billingMetrics 暴露确认）。

- [ ] **Step 4: 跑测确认通过** — Expected PASS。

- [ ] **Step 5: 装配 + 全门** — app.ts:609 `new MediaRetentionWorker(captureResolver('media-retention'), mediaEraser, logger, ...)`。`npm run test:golden` EXIT 0。

- [ ] **Step 6: Commit**

```bash
git add src/storage/shard-key.ts src/test/support/throwing-db.ts src/test/unit/*-sharding.test.ts src/perception/media src/server/app.ts src/server/routes/metrics.ts src/observability
git commit -m "feat(shard): MediaRetentionWorker GDPR allShardDbs fan-out + 健康状态机(抛错/failed>0 立即 degraded,meterShardEraseFailure 暴露 metrics)+公共 shard-key/throwing-db

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: DualWriteFlushWorker fan-out（ledger 亲和性）

**Files:**
- Modify: `src/workers/dual-write-flush-worker.ts`（ctor 收 resolver + flush fan-out 循环内构造 ledger）
- Modify: `src/server/app.ts:408-410`（装配传 resolver）
- Test: `src/test/unit/dual-write-flush-sharding.test.ts`（新建）

**Interfaces:**
- Consumes: `allShardDbs()`、`new SqliteEventLedger(shardDb)`、`personaCoreDualWrite.flushOutbox(db, ledger)`。
- Produces: `DualWriteFlushWorker` ctor `({ resolver, logger })`；`flush(): { totalFlushed; totalFailed; shardErrors }`。

- [ ] **Step 1: 写 ledger 无串写测（红）**

`dual-write-flush-sharding.test.ts`（2 shard）：s0/s1 各 seed persona_core_ledger_outbox 行 → flush → **断言 s0 的 outbox 只 append 到 s0 的 ledger、s1 只到 s1**（无跨 shard 串写：s1 的 ledger 不含 s0 的事件）；totalFlushed=两 shard 之和；throwingDb 注 s1 → shardErrors[s1] + s0 仍 flush。

- [ ] **Step 2: 跑测确认失败** — Expected FAIL。

- [ ] **Step 3: 改 worker（先核 SqliteEventLedger ctor + flushOutbox 签名）**

**先 Read**：`SqliteEventLedger` ctor（Codex 核为收单 `IDatabase`）、`personaCoreDualWrite.flushOutbox(db, ledger)` 签名（Codex 核 `(db, ledger)` 返 `{flushed, failed}`）、现有 `dual-write-flush-worker.test.ts`（迁移到新 ctor）。
改法（意图）：
- ctor 从 `{ db, logger }` 改 `{ resolver, logger }`；`private keyer = makeShardKeyer()`；删 ctor 里 `this.ledger = new SqliteEventLedger(opts.db)`（改循环内构造）。
- flush 遍历 `resolver.allShardDbs()`：每 shard `const shardKey = this.keyer(shardDb)` → try **循环内 `new SqliteEventLedger(shardDb)`**（源库=ledger 库同一 shardDb，防串写）→ `flushOutbox(shardDb, ledger)` 累加 flushed/failed；catch → shardErrors.push（`error` 转 message string，别塞 Error 对象）+ logger.error（真实 Logger 签名）。返回 `{ totalFlushed, totalFailed, shardErrors }`。

- [ ] **Step 4: 跑测确认通过** — Expected PASS。
- [ ] **Step 5: 装配 + 全门** — app.ts:408 传 resolver。`npm run test:golden` EXIT 0。
- [ ] **Step 6: Commit**

```bash
git add src/workers/dual-write-flush-worker.ts src/server/app.ts src/test/unit/dual-write-flush-sharding.test.ts
git commit -m "feat(shard): DualWriteFlushWorker allShardDbs fan-out(循环内 new SqliteEventLedger(shardDb) 防跨 shard 串写)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: SettlementReconciliationWorker + RuntimeRecoveryWorker fan-out

**Files:**
- Modify: `src/billing/settlement-reconciliation-worker.ts`（ctor 收 resolver + flushInternal fan-out）
- Modify: `src/persona-core/runtime-recovery-worker.ts`（ctor 换注入 resolver，去 SingleDbResolver 包裹）
- Modify: `src/server/app.ts:363-389`（两 worker 装配传 resolver）
- Test: `src/test/unit/settlement-recovery-sharding.test.ts`（新建）

**Interfaces:**
- Settlement: ctor `(resolver, ...)`；flushInternal `for (const db of allShardDbs()) new SettlementReconciliationService(db).reconcileTenants()`（每 shard 枚举其租户），逐 shard 隔离聚合。
- RuntimeRecovery: ctor 从裸 db 换收共享 `resolver`（**最小改**：内部原 `PersonaCoreService.fromResolver(new SingleDbResolver(this.db))` → `PersonaCoreService.fromResolver(this.resolver)`），底层 `recoverTimedOutRuntimeSessions` 的 `source.allDbs()` fan-out 自动生效。

- [ ] **Step 1: 写 Settlement + Recovery fan-out 测（红）**

（2 shard）Settlement：s0/s1 各 seed 待结算租户 → reconcile → 两 shard 租户都被结算（枚举计数=两 shard 之和）；throwingDb 注 s1 → s1 记 error + s0 仍结算。RuntimeRecovery：s0/s1 各 seed 超时 runtime session → recover → 两 shard 都恢复（scanned=两 shard 之和，非仅 home）。

- [ ] **Step 2: 跑测确认失败** — Expected FAIL。
- [ ] **Step 3: 改两 worker** — 按 Interfaces。
- [ ] **Step 4: 跑测确认通过** — Expected PASS。
- [ ] **Step 5: 装配 + 全门** — app.ts:363/378 传 resolver。`npm run test:golden` EXIT 0。
- [ ] **Step 6: Commit**

```bash
git add src/billing/settlement-reconciliation-worker.ts src/persona-core/runtime-recovery-worker.ts src/server/app.ts src/test/unit/settlement-recovery-sharding.test.ts
git commit -m "feat(shard): Settlement+RuntimeRecovery worker allShardDbs fan-out(Recovery 换注入 resolver 去 SingleDbResolver 包裹)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: ToolInvocations + cleanupExpiredTokens + retention timer fan-out（observability 不含，拆独立 plan）

**Files:**
- Modify: `src/agent/tool-invocations-retention-worker.ts`（worker ctor 收 resolver + flushOnce 遍历 allShardDbs 各 new ToolPermissionService(shardDb)）
- Modify: `src/server/routes/auth.ts:290-292`（`cleanupExpiredTokens` **route helper 改签名**收 resolver——**逐 shard try/catch 隔离**：`for (const shardDb of resolver.allShardDbs()) { try { total += AuthService.cleanupExpired(shardDb); } catch { /* 单 shard 清理失败不阻断其他 shard */ } }`）
- Modify: `src/server/app.ts`（抽 `runDataRetentionOnce(...)` 可测函数 + 三处装配传 resolver；`cleanupExpiredTokens(db)` @ :944 改 `cleanupExpiredTokens(resolver)`）
- Test: `src/test/unit/retention-timers-sharding.test.ts`（新建）

**Interfaces（签名以 Read 为准）:**
- ToolInvocations: **先 Read `ToolPermissionService.pruneInvocationsBefore` 真实签名**（Codex 核为**只返 number 无 mayHaveMore**）。worker ctor 从收 `toolPermissionService` 改收 `resolver`（迁移现有 `tool-invocations-retention-worker.test.ts`）；flushOnce 逐 shard `new ToolPermissionService(shardDb).pruneInvocationsBefore(cutoff, batchSize)` try/catch 隔离，聚合删除计数（number 累加）。**批次预算定死**：现 worker 有 `maxBatchesPerCycle` 循环——fan-out 后语义定为 **每 shard 各自最多 maxBatchesPerCycle 批**（非所有 shard 共享 N 批），即外层 for shard、内层现有批次循环不变（因 pruneInvocationsBefore 无 mayHaveMore，续批判据用返回 count===batchSize 近似，照现有 worker 现判据别改）。
- cleanupExpiredTokens: **route helper（非 AuthService 方法）** 改收 resolver fan-out + 逐 shard try/catch（见 Files）；app.ts:944 调用点同步。
- **retention timer 抽可测 seam**：现 app.ts:950-981 是内联 setInterval 闭包，**抽为模块级 `export function runDataRetentionOnce(opts: { resolver: TenantDbResolver; now: number; retentionMs: { usage: number; billing: number; idempotency: number; webhook: number } }): { usageDeleted: number; billingDeleted: number; idempotencyDeleted: number; webhookDeleted: number; shardErrors: Array<{ shardKey: string; error: string }> }`**——跨租户表（usage_records/billing_outbox/idempotency_keys）`for (const shardDb of resolver.allShardDbs())` 各 prune 逐 shard try/catch 隔离；webhook_events（平台表无 tenant_id）→ `resolver.coordinatorDb()` prune。setInterval 闭包改调 `runDataRetentionOnce(...)`（现有 prune 工厂/SQL 以 Read 现闭包为准）。

- [ ] **Step 1: 写三处 fan-out 测（红）**

（FakeMultiShardResolver 2 shard，import throwingDb）：① ToolInvocations：s0/s1 各 seed 过期 tool invocation → flushOnce → 两 shard 都清（聚合计数=两之和）；throwingDb 作 s1 → s1 隔离、s0 仍清。② cleanupExpiredTokens：refresh_token 落 s1 过期（`authCmdCreateRefreshToken` 经 dbForTenant 写 s1）→ `cleanupExpiredTokens(resolver)` → s1 token 清（旧 coordinatorDb-only 会漏 s1，断言抓：断言仅传 coordinator 时 s1 不清）。③ `runDataRetentionOnce`：usage_records/billing_outbox/idempotency_keys 各 shard 过期行 → 两 shard 都清（各计数=两之和）；webhook_events 只在 coordinator seed → coordinatorDb 清；throwingDb 作 s1 → shardErrors 含 s1、s0 仍清。

- [ ] **Step 2: 跑测确认失败** — Expected FAIL。
- [ ] **Step 3: 改三处** — 按 Interfaces。ToolInvocationsRetentionWorker ctor 从收 `toolPermissionService` 改收 `resolver`（内部 per-shard new ToolPermissionService）；cleanupExpiredTokens route helper 改签名；抽 runDataRetentionOnce。
- [ ] **Step 4: 跑测确认通过** — Expected PASS。
- [ ] **Step 5: 装配 + 全门** — app.ts:749 tool worker 传 resolver、:944 cleanupExpiredTokens(resolver)、:950-981 timer 调 runDataRetentionOnce。`npm run test:golden` EXIT 0。
- [ ] **Step 6: Commit**

```bash
git add src/agent/tool-invocations-retention-worker.ts src/server/routes/auth.ts src/server/app.ts src/test/unit/retention-timers-sharding.test.ts
git commit -m "feat(shard): ToolInvocations+cleanupExpiredTokens+retention timer allShardDbs fan-out(token 落 shard 修 coordinatorDb-only 漏清 bug,抽 runDataRetentionOnce 可测 seam)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: MetricsQueryService scatter-gather + partial failure

**Files:**
- Create: `src/observability/shard-aggregate.ts`（`ShardAggregate<TData>` 类型 + `aggregateShards<TShard, TData>` helper，双泛型见 Global Constraints）
- Create/Modify: `packages/kernel/src/domain/.../metrics-queries.ts`（**先 Read 现有 metrics query 的 kernel→executor 链**——加无-limit `tenantUsageRaw` query constant+factory+类型+export，照现有 metrics query 全链，非只改 executor）
- Modify: `src/storage/executors/metrics-query-executors.ts`（tenant usage 查询去掉 per-shard `LIMIT`——加**无 limit 的 scatter 变体** `metricsQueryTenantUsageRaw(retentionMs)`：`SELECT tenant_id, resource, SUM(quantity) as total FROM usage_records WHERE recorded_at > ? GROUP BY tenant_id, resource`（不 ORDER/LIMIT），协调层全局 sort+limit；保留原带 limit 查询给单库路径不破）
- Modify: `src/observability/metrics-query-service.ts`（5 项聚合 scatter-gather + 合并算法 + ShardAggregate）
- Modify: `src/server/routes/metrics.ts`（加 resolver 注入 + 解包 ShardAggregate：data 进 body + degraded/shardErrors 暴露 JSON + Prometheus degraded gauge）
- Modify: `src/server/app.ts:887`（registerMetricsRoutes 传 resolver）
- Modify: 现有 `metrics-routes.test`（若 registerMetricsRoutes 加 resolver 参致旧签名调用编译错，迁移到新签名；**先 Read 确认现有测试怎么调**——route-schema 快照若因新响应字段 degraded/shardErrors 变则 `UPDATE_SNAPSHOTS=1 npm run test:contract`，仅实际变才更新）
- Test: `src/test/unit/metrics-sharding.test.ts`（新建）

**Interfaces:**
- `ShardAggregate<TData>` + `aggregateShards<TShard, TData>`（**双泛型，定义见 Global Constraints**——别用单泛型 `<T>` + 未声明的 `Data`，那是编译错）。
- **MetricsQueryService ctor 收 `resolver: TenantDbResolver`**（**不用 fromResolver 二态**——直接 ctor 单参 resolver，各方法内 `this.resolver.allShardDbs()`）。
- 合并算法（spec 定死）：diversity 各 shard 原始 styles concat → `personalityDiversity(全部 styles)`（一次全局重算）；billing/queue count SUM；observability count SUM + `updated_at` MAX；tenant usage 各 shard `metricsQueryTenantUsageRaw` 行 concat → 全局 merge（同 tenant+resource SUM）→ sort DESC → limit。
- 每方法返回 `ShardAggregate<T>`（data + degraded + shardErrors）。route 解包 data 进响应 body、degraded/shardErrors 另字段。

- [ ] **Step 1: 写 metrics 聚合 + partial failure 测（红）**

（2 shard，import throwingDb）s0/s1 各有租户/backlog/style/queue task → ① diversity=两 shard 全部 styles 全局重算（非局部分数 SUM，断言值 === `personalityDiversity([...s0Styles, ...s1Styles])`）；② billing backlog=两 shard count SUM；③ observability rollup count SUM + `updated_at`=两 shard MAX；④ queue backlog=两 shard count by status SUM；⑤ tenant usage=两 shard 租户行全局 merge(同 tenant+resource SUM)+sort DESC+limit（造 s0/s1 有同 tenant+resource 行 → 断言合并 SUM 后再 limit，非各 shard 各 limit 后拼）；⑥ throwingDb 作 s1 → 返回 `degraded:true` + shardErrors 含 `shard#1` + data 是 s0 部分聚合（非静默当零/非抛）。

- [ ] **Step 2: 跑测确认失败** — Expected FAIL。
- [ ] **Step 3: 改 MetricsQueryService + route** — 按 Interfaces。
- [ ] **Step 4: 跑测确认通过** — Expected PASS。
- [ ] **Step 5: 装配 + 全门** — app.ts:887 传 resolver。`npm run test:golden` EXIT 0。
- [ ] **Step 6: Commit**

```bash
git add src/observability/metrics-query-service.ts src/server/routes/metrics.ts src/server/app.ts src/test/unit/metrics-sharding.test.ts
git commit -m "feat(shard): MetricsQueryService scatter-gather(diversity 全局重算/updated_at MAX/usage 全局 sort)+partial failure {data,degraded,shardErrors}

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: route 内联直查下沉 dbForTenant + inventory 校准 + 全门验收

**Files:**
- Modify: `src/server/routes/decisions.ts`、`onboarding.ts`（删 sharedDb，tenant 查改 dbForTenant(request.tenantId)）
- Modify: `src/server/routes/admin-deployment.ts`（**已收 resolver**——只把剩余裸 `db.prepare(tenant_key_versions)` 改 `resolver.dbForTenant(request.tenantId)`，非「加 resolver」）、`onboarding-v2.ts`（加 resolver 注入 + persona_versions 直查改 dbForTenant）
- Modify: `src/server/app.ts`（decisions/onboarding/onboarding-v2 registrar 传 resolver；admin-deployment 已传）
- Modify: `src/storage/db-access-inventory.ts` + `src/test/unit/db-access-inventory-completeness.test.ts`
- Test: `src/test/unit/route-direct-query-sharding.test.ts`（新建）+ 现有 decisions/onboarding route 测回归

**Interfaces:**
- decisions/onboarding：删 `const sharedDb = deps.db ?? os.getDatabase()`，route 内 tenant-scoped 查（subscriptions/decision_cases/decision_runs/onboarding_sessions）改 `deps.resolver.dbForTenant(request.tenantId)`（SQL 仍带 WHERE tenant_id）。route registrar deps 加 `resolver`（缺省 `new SingleDbResolver(os.getDatabase())` 保测试兼容，照现有 route 模式）。
- admin-deployment：**已有 resolver**，剩余裸 `db.prepare` → `resolver.dbForTenant(request.tenantId)`。onboarding-v2：加 resolver 参，persona_versions 直查改 dbForTenant。

- [ ] **Step 1: 写 route 直查落对 shard 测（红）**

（2 shard）用 `createApp({ os, resolver: FakeMultiShardResolver, ... })`（照现有 route 测的 createApp + app.inject 手法）+ tenant hook 从 JWT/header 填 `request.tenantId`。租户 A 映射 s1：
- decisions：`app.inject POST /api/v1/decisions`（body 含 decision case 字段）带 A 的 auth → 断言 decision_case 行落 **s1**（`resolver.dbForTenant('tenantA')`）+ **s0 该行 undefined**；GET 列表经 s1 读回。
- onboarding：`POST /api/v1/onboarding/...` 建 onboarding_session → 落 s1、s0 无。
- admin-deployment：`POST /api/v1/admin/deployment/...`（需 admin role JWT + 前置 seed tenant_key_versions 到 s1）→ tenant_key_versions 落/读 s1。
- onboarding-v2：`POST /api/v1/onboarding-v2/...`（需 organization/session fixture）→ persona_versions 落 s1。
每 endpoint 的确切 path/body/role 以现有对应 route 测（decisions.test/onboarding.test 等）为骨架照抄，只把 db 换 FakeMultiShardResolver 并加落对 shard 断言。若某 route 无现成测则查该 route 注册的 method+path 定路由契约。

- [ ] **Step 2: 跑测确认失败** — Expected FAIL。
- [ ] **Step 3: 改四 route** — 按 Interfaces。
- [ ] **Step 4: inventory 逐 edge 校准** — decisions/onboarding/admin-deployment/onboarding-v2 的 route 直查 edge + 六 worker/timer/metrics 的 per-shard-worker edge，**真 fan-out+2-shard 测覆盖**才 planned→verified（逐 edge，绝不 mass-upgrade）。重算 expectedCount===coveredEdgeIds.length。未覆盖（companion/perceive/TaskQueue carrier）保持 planned。
- [ ] **Step 5: 全门验收**

Run: `npm run typecheck 2>&1 | tail -5`
Run: `npm run check:db-access 2>&1 | tail -15`（五诊断全空；per-shard-worker/route verified/planned 准确）
Run: `rg -n 'sharedDb\s*=\s*deps\.db|os\.getDatabase\(\)' src/server/routes/{decisions,onboarding,admin-deployment,onboarding-v2}.ts`（无裸 host db 直查残留）
Run: `npm run test:golden 2>&1 | tail -30`（EXIT 0，链走到 db-access 门，记忆 [[merge-gate-must-run-test-golden]] 非子集）

- [ ] **Step 6: Commit**

```bash
git add src/server/routes src/server/app.ts src/storage/db-access-inventory.ts src/test/unit/db-access-inventory-completeness.test.ts src/test/unit/route-direct-query-sharding.test.ts
git commit -m "feat(shard): route 内联直查下沉 dbForTenant(decisions/onboarding/admin-deployment/onboarding-v2)+inventory fan-out edge 校准 verified

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

- **Spec 覆盖**：GDPR MediaRetention(Task1)/DualWrite(Task2)/Settlement+RuntimeRecovery(Task3)/ToolInvocations+cleanupTokens+retention timer(Task4)/metrics scatter-gather(Task5)/route 直查(Task6) — spec 范围 A/B/C/D 覆盖。**observability 独立进程拆出独立 spec+plan**（Kafka 跨 shard 路由子设计，不含本 Plan）。
- **模式**：改用「implementer 自核签名」——计划给意图/文件/fan-out 模式/隔离铁律/健康状态机语义/测试锚，**真实签名由 implementer 先 Read 再 TDD**（前两轮从记忆写伪代码引入 runMediaRetention arity/Logger 编译错，此模式规避）。每 task Step 3 首句「先 Read <真实签名>」是硬要求。
- **Codex 68/72 退回项处置**：① `<稳定标识>` placeholder 消（Task2 改意图+makeShardKeyer）；② Task1 runMediaRetention 3 参/Logger 真签名/isHealthy 保 timer 生命周期/metric 模块级所有权——改为「先核签名」+定死语义 ✅；③ throwingDb 改**可配置** `throwingDb({on})` 逐文件按原语义迁移（非全抛破坏后两类）✅；④ Task4 cleanupTokens route helper 加逐 shard try/catch 隔离/runDataRetentionOnce 类型+ToolInvocations 批次预算+pruneInvocationsBefore 只返 number 不假称 mayHaveMore——见 Task4 修 ✅；⑤ Task5 aggregateShards 双泛型 TShard/TData + kernel query 全链(constant+factory+export) ✅；⑥ Task6 真 endpoint(admin/vault/keys/:keyRef/rotate 等) ✅；⑦ observability **真 defer**(Plan 2 完成后另起 spec+plan，非只声明) ✅。
- **Placeholder 扫描**：无 `<...>` 占位、无二选一；剩余的「先 Read <签名>」是**主动核验指令**（非占位——正是自核模式的核心）；测试锚含真 fixture/endpoint/断言值。
- **类型一致**：各 worker flushOnce/flush 返回含 shardErrors；MetricsQueryService 聚合返回 {data,degraded,shardErrors}；worker ctor 全收 resolver。
- **诚实性**：inventory 校准（Task6）逐 edge、有测才 verified、绝不 mass-upgrade，对齐 Plan 1b/1c 铁律。
- **fail-closed 不放开**：全程不碰 assertShardingActivationAllowed（Plan 3）。
