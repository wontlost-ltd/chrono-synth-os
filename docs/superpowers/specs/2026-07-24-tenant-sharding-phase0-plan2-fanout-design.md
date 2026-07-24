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

**GDPR fan-out 合规契约（第 2 轮定死，Codex #1——隔离不崩 ≠ 静默漏擦）**：MediaRetention 的 shard 隔离必须 **isolate + retry + alert**，非只记 info 日志：① 单 shard 失败 → catch 记 `shardErrors` + 保留媒体引用供下周期重试（现有行为）；② **失败必须升级为可观测信号**——每个 shard 擦除失败 metric（`meterShardEraseFailure`，照 BillingOutbox 的 `meterShardFlushErrors`）+ `logger.error`（非 info）；③ **连续失败治理**：worker 暴露 degraded 状态（`isHealthy()` 在有 shard 持续失败时返 false 供健康探针/告警），timer/装配层消费 `shardErrors` 决定告警。合规底线：绝不「fan-out 跑完返成功但某 shard 的 GDPR 数据从未擦除且无人知」。验收测须断言 shard 失败时 error 被记录 + metric 触发 + isHealthy 反映。

**DualWrite ledger 亲和性（第 2 轮定死，Codex #2——防跨 shard 串写）**：`flushOutbox(db, ledger)` 的 `db`（outbox 源）与 `ledger`（`SqliteEventLedger`）当前都绑同一 `opts.db`。fan-out **必须在循环内为每个 shard 现构造 `new SqliteEventLedger(shardDb)`**（源库与 ledger 库同一 shardDb），绝不复用一个中心 ledger（否则跨 shard 写 ledger + 删源 shard outbox = 数据串写/丢失）。定死：`for (const shardDb of resolver.allShardDbs()) { const ledger = new SqliteEventLedger(shardDb); await flushOutbox(shardDb, ledger); }`。验收测须断言 shard A 的 outbox 只 flush 到 shard A 的 ledger、无跨 shard 串写。

**Token 落 shard fan-out（第 2 轮定死，Codex #3——致命 bug 修复）**：refresh_tokens 表落**各租户 shard**（Plan 1c Task 7 `authCmdCreateRefreshToken` 经 `dbForTenant(tenantId)` 写 shard；只有 locator `recordActiveLookup` 落 coordinator 目录）。但 `AuthService.cleanupExpired(this.resolver.coordinatorDb())` 只清 coordinator——**多库下永不清 shard 上的过期 token**（真 bug）。修：`cleanupExpiredTokens` 改 `for (const shardDb of resolver.allShardDbs()) AuthService.cleanupExpired(shardDb)`（逐 shard 隔离聚合）；被清 token 的 locator（coordinator 目录项）由 Plan 1c 的 removeLookup 在 revoke/logout 时清 + 过期 token 的目录孤儿项属 M4 类卫生（不影响正确性，shard 已删 token→refresh 落 shard 查 null 拒）。验收测：token 落 s1，cleanup fan-out 后 s1 过期 token 被清（coordinatorDb-only 会漏）。

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

### C. metrics route scatter-gather（`allShardDbs()`，第 2 轮定死合并算法 Codex #4/#5/#6）
9. **MetricsQueryService**（metrics.ts + metrics-query-service.ts）— 加 resolver 注入，5 项跨租户聚合改 scatter-gather，**每项合并算法定死**：
   - **population diversity**：各 shard 取**原始 decision_style 行 concat** → **协调层全局重算**多样性度量（**非**各 shard 局部分数 SUM——多样性不可加）。
   - **billing outbox backlog**：各 shard count **SUM**。
   - **observability summary**：各 shard rollup——count 类 **SUM**，**`updated_at` 取各 shard 的 MAX**（非 SUM），outbox backlog SUM。
   - **queue backlog**：各 shard count by status **SUM**（临时——TaskQueue 分片归 Plan 3，Plan 2 先按现 queue_tasks 表 fan-out SUM，Plan 3 改队列归属后再调整；边界见「不含」）。
   - **tenant usage**：各 shard 各租户行 concat → **全局 merge + sort + limit（retentionMs 窗口）**（非各 shard 各自 limit 后拼）。
   - **partial shard failure 显式暴露（Codex #6）**：MetricsQueryService 现把查询异常转零/空——scatter-gather 必须**显式暴露** partial shard failure（返回结构含成功 shard 聚合 + 失败 shard 列表 / 或整体标 degraded），绝不把某 shard 失败静默当零（否则 metrics 报假低值误导容量决策）。
   - 进程级内存 counter（billingMetrics/llmMetrics 等）不改。

### D. route 内联直查下沉（`dbForTenant`）
10. **decisions.ts / onboarding.ts** — 删 `sharedDb = deps.db ?? os.getDatabase()`，route 内 tenant-scoped 查改 `resolver.dbForTenant(request.tenantId)`（subscriptions/decision_cases/decision_runs/onboarding_sessions）。
11. **admin-deployment.ts / onboarding-v2.ts** — route 加 resolver 注入，tenant_key_versions/persona_versions 直查改 `dbForTenant`。
12. **companion 系列 → 明确归 Plan 3（第 2 轮定死，Codex #7——不推给实现者）**：companion route 的 store carrier（`ResponseTemplateStore`/`CompanionRelationshipStore`/`CompanionIdentityStore`/`MemoryTranslationStore`/`CompanionMoodStore` 持 sharedDb+tenantId）依赖 `getOS()`/`getTenantOS` 的 OS 内核 carrier 分片——与 PrivacyService/AvatarAutorunFacade 同属 OS 大 carrier，**统一归 Plan 3**（typed bundle 分片），Plan 2 不动。perceive.ts/perceive-stream.ts 的 `sharedDb.execute(perceptionEventInsert)` 同理（perception carrier）归 Plan 3。**Plan 2 的 route 直查 = decisions/onboarding/admin-deployment/onboarding-v2 四个真·内联 tenant SQL，companion/perceive 明确不含。**

### 不含（Plan 3）
- **TaskQueue shard 归属**（queue_tasks 每 shard 一队列+worker）——Plan 2 的 metrics queue backlog **临时**按现 queue_tasks 表 fan-out SUM（queue 表现单库共享），Plan 3 改队列归属后 backlog 语义随之调整。**临时边界**：Plan 2 不改 TaskQueue 本身的 enqueue/dequeue 路由（那是 Plan 3），只让 metrics 读 backlog fan-out——若 Plan 3 前 queue_tasks 仍单库则 fan-out SUM 等价单库 count（零回归）。
- OS 内核大 carrier（PrivacyService/AvatarAutorunFacade/companion getOS/perceive）的 typed bundle 分片。
- 放开 fail-closed + 真 2-shard PG 集成验收。

## 验收（每项 FakeMultiShardResolver 2-shard 单测）
- **fan-out 正确性**：各 shard 独立 seed 过期数据 → worker 跑后各 shard 数据都被清（聚合删除计数 = 各 shard 之和）；仅 home shard 清=漏（旧行为）会被断言抓。
- **per-shard 隔离**：`throwingDb()` 桩注入某 shard → 断言该 shard 记 error、其余 shard 仍清理（不整体崩）。
- **GDPR 合规专项（强化）**：MediaRetention 各 shard 过期媒体都被物理擦除 + 擦除器调用；**shard 失败时断言 error 被记（非 info）+ meterShardEraseFailure metric 触发 + isHealthy 反映 degraded**（不静默漏擦）。
- **DualWrite ledger 无串写**：shard A 的 outbox flush 只落 shard A 的 ledger（断言循环内每 shard 现构造 ledger），shard B 的 ledger 无 A 的事件。
- **Token fan-out**：refresh_token 落 s1，cleanupExpiredTokens fan-out 后 s1 过期 token 被清（coordinatorDb-only 旧行为会漏 s1，断言抓）。
- **数据落对 shard**：route 直查 dbForTenant 后行 tenant_id 对称落对 shard、其他 shard 无。
- **metrics 聚合 + partial failure**：两 shard 各有租户/backlog → metrics 返回 = 两 shard 正确合并（diversity 全局重算/updated_at MAX/usage 全局 sort+limit）；某 shard throwingDb → 断言返回结构显式标 partial failure（非静默当零）。
- **单库零回归**：SingleDbResolver 下所有现有 worker/timer/metrics 测试绿。

## 迁移/破坏性
- 无新迁移（纯路由改造）。
- worker ctor 签名从裸 db/tx 改收 resolver——app.ts 装配点同步（照 reservationRecoveryWorker 的 captureResolver 参照系）。
- inventory 逐 edge 校准：per-shard-worker/route 直查 edge 真 fan-out+2-shard 测覆盖 → planned→verified；未覆盖保持 planned（诚实，非 mass-upgrade）。
- fail-closed 不放开（Plan 3）。
