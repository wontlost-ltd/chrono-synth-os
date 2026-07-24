# 租户分片 Phase 0 · Plan 2（route 直查下沉 + 全局 worker/timer/metrics fan-out）设计

**Goal:** 消除分片后「全局 worker/timer 只处理 home shard = 静默漏」与「route 内联 tenant-scoped 直查走 host db = 错 shard」两类 sink，让跨租户扫描经 `resolver.allShardDbs()` 逐 shard fan-out、租户级直查经 `dbForTenant`、平台表经 `coordinatorDb`。**最高优先 = GDPR MediaRetention**（分片后非-home shard 过期媒体永不物理删除+合规漂移）。

**背景**：Plan 0（隔离盘点门）+1（buildResolver 注入链）+1b（buildAppServices resolver 化）+1c（Auth mixed-scope）已完成。Plan 2 处理 Plan 0 inventory 剩余的 `per-shard-worker`（9 flow edge）+ route `requires-resolver-rewire`/`terminal-escape` 真·内联直查子集。**不放开 fail-closed**（Plan 3）；多-shard 行为全靠 `FakeMultiShardResolver` 单测。

## 设计决策（fan-out 模式，非新架构——照抄已有 3 先例）

**已有 fan-out 先例**（Plan 2 直接照抄，不自创）：
- `BillingOutbox`（`src/billing/billing-outbox.ts`）：`fromResolver(resolver)` + flush 遍历 `allDbs()` + **`shardErrors` 逐 shard try/catch 隔离**（某 shard 抛不阻塞其他）+ metrics 记 shard 错误。
- `QuotaManager`（`src/multi-tenant/quota-manager.ts`）：`fromResolver`/`fromUnitOfWork` 双入口 + `pruneUsageBefore` fan-out + `mayHaveMore` 续批。
- `PersonaCoreService`（`src/persona-core/persona-core-service.ts`）：`fromResolver`（forTenant+allDbs）。

**四类处置**（每 sink 按其扫描面归类）：
1. **跨租户扫描 → `allShardDbs()` fan-out**：worker 对每个 shard db 各跑一遍清理/枚举，**逐 shard try/catch 隔离**（照 BillingOutbox 的 shardErrors），聚合结果（count SUM / rows concat / errors 收集）。某 shard 失败不阻塞其他 shard、不整体崩。
2. **租户级直查 → `dbForTenant(tenantId)`**：route 内联 tenant-scoped SQL 用 request.tenantId 选对 shard（SQL 仍带 WHERE tenant_id）。
3. **平台/请求-infra 表 → `coordinatorDb()`**：无 tenant_id 归属的平台表（webhook_events）。
4. **单 shard 已足 / 已 fan-out → 不改**：BillingOutbox timer、QuotaUsageRetention（已 fromResolver）。

**fan-out 隔离铁律**：跨租户 worker 的 fan-out 循环必须**逐 shard 隔离**——单 shard db 抛错（连接失败/损坏）时 catch 记录该 shard 错误 + 继续下一 shard，绝不因一个 shard 挂掉导致其他 shard 的 GDPR 擦除/结算/清理被跳过。返回结构含 per-shard 结果 + 错误列表（照 BillingOutbox `shardErrors`）。

**单库零回归**：`SingleDbResolver.allShardDbs() = [db]`，fan-out 循环跑一次 = 等价现状。所有现有 worker/timer/metrics 测试仍绿。

## 范围（精确工作面）

### A. 跨租户 worker fan-out（`allShardDbs()`）
1. **MediaRetentionWorker（GDPR，最优先）** — ctor 收 resolver，`flushOnce` 对 `allShardDbs()` 各 `runMediaRetention(db,...)`；逐 shard 隔离；聚合删除计数。GDPR 漏擦是最严重后果。
2. **DualWriteFlushWorker** — 对 `allShardDbs()` 各 flush persona ledger outbox；⚠️ ledger 目标库须与源 shard 一致（不能跨 shard 写 ledger）。
3. **SettlementReconciliationWorker** — 对 `allShardDbs()` 各 `new SettlementReconciliationService(db).reconcileTenants()`（每 shard 枚举其租户）。
4. **RuntimeRecoveryWorker（最小改）** — ctor 从裸 db 换注入 resolver（不再包 SingleDbResolver），底层 `recoverTimedOutRuntimeSessions` 的 `source.allDbs()` fan-out 自动生效。
5. **ToolInvocationsRetentionWorker** — ToolPermissionService 的 prune 跨租户 → 对 `allShardDbs()` 各 prune（ToolPermissionService 加 fromResolver 或 worker 直接遍历 shard——选侵入小的）。
6. **observability worker**（`main-observability-worker.ts` 独立进程）— 各 shard 各 drain outbox + 各 rollup。

### B. timer fan-out/拆分
7. **retention timer**（app.ts:950-981）— 跨租户表（usage_records/billing_outbox/idempotency_keys）对 `allShardDbs()` 各 prune；webhook_events（平台表）→ `coordinatorDb()`。
8. **cleanupExpiredTokens timer** — 对 token 表落 shard 的情况 fan-out（核对 token 表落 shard 还是 coordinator——AuthService.cleanupExpired 已用 coordinatorDb，须与 Plan 1c 的 refresh_token 落 shard 语义一致）。

### C. metrics route scatter-gather（`allShardDbs()` SUM/concat）
9. **MetricsQueryService**（metrics.ts + metrics-query-service.ts）— 加 resolver 注入，5 项跨租户聚合改 scatter-gather：population diversity（各 shard decision_style concat 后合并）/ billing outbox backlog（SUM）/ observability summary（rollup SUM）/ queue backlog（SUM）/ tenant usage（各 shard 各租户行 concat）。进程级内存 counter 不改。

### D. route 内联直查下沉（`dbForTenant`）
10. **decisions.ts / onboarding.ts** — 删 `sharedDb = deps.db ?? os.getDatabase()`，route 内 tenant-scoped 查改 `resolver.dbForTenant(request.tenantId)`（subscriptions/decision_cases/decision_runs/onboarding_sessions）。
11. **admin-deployment.ts / onboarding-v2.ts** — route 加 resolver 注入，tenant_key_versions/persona_versions 直查改 `dbForTenant`。
12. **companion 系列（carrier，评估推 Plan 3）** — companion route 的 store carrier（持 sharedDb+tenantId）若侵入小可 Plan 2 下沉，否则明确推 Plan 3（大 carrier 依赖 getTenantOS 分片）。

### 不含（Plan 3）
- TaskQueue shard 归属（queue_tasks 每 shard 一队列+worker，非本 Plan）。
- OS 内核大 carrier（PrivacyService/AvatarAutorunFacade/companion getOS）的 typed bundle 分片。
- 放开 fail-closed + 真 2-shard PG 集成验收。

## 验收（每项 FakeMultiShardResolver 2-shard 单测）
- **fan-out 正确性**：各 shard 独立 seed 过期数据 → worker 跑后各 shard 数据都被清（聚合删除计数 = 各 shard 之和）；仅 home shard 清=漏（旧行为）会被断言抓。
- **per-shard 隔离**：`throwingDb()` 桩注入某 shard → 断言该 shard 记 error、其余 shard 仍清理（不整体崩）。
- **数据落对 shard**：route 直查 dbForTenant 后行 tenant_id 对称落对 shard、其他 shard 无。
- **metrics 聚合**：两 shard 各有租户/backlog → metrics 返回 = 两 shard 之和（仅 home shard 会漏）。
- **GDPR 专项**：MediaRetention 各 shard 过期媒体都被物理擦除 + 擦除器调用（非-home shard 不漏擦）。
- **单库零回归**：SingleDbResolver 下所有现有 worker/timer/metrics 测试绿。

## 迁移/破坏性
- 无新迁移（纯路由改造）。
- worker ctor 签名从裸 db/tx 改收 resolver——app.ts 装配点同步（照 reservationRecoveryWorker 的 captureResolver 参照系）。
- inventory 逐 edge 校准：per-shard-worker/route 直查 edge 真 fan-out+2-shard 测覆盖 → planned→verified；未覆盖保持 planned（诚实，非 mass-upgrade）。
- fail-closed 不放开（Plan 3）。
