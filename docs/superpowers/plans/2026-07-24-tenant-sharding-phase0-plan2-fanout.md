# 租户分片 Phase 0 · Plan 2（fan-out）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development 逐 task 实现。步骤用 checkbox（`- [ ]`）跟踪。
>
> spec `docs/superpowers/specs/2026-07-24-tenant-sharding-phase0-plan2-fanout-design.md`（Codex 64→87→95 通过）。

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

- Worker fan-out：`src/perception/media/media-retention-worker.ts`（+ media-ref-store 若需）、`src/workers/dual-write-flush-worker.ts`、`src/billing/settlement-reconciliation-worker.ts`、`src/persona-core/runtime-recovery-worker.ts`、`src/agent/tool-invocations-retention-worker.ts`、`src/main-observability-worker.ts`。
- Timer：`src/server/app.ts`（retention timer :950-981、cleanupExpiredTokens :941-948）、`src/identity/auth-service.ts`（cleanupExpiredTokens fan-out）。
- Metrics：`src/server/routes/metrics.ts`、`src/observability/metrics-query-service.ts`。
- Route 直查：`src/server/routes/decisions.ts`、`onboarding.ts`、`admin-deployment.ts`、`onboarding-v2.ts`。
- 装配：`src/server/app.ts`（worker ctor 传 resolver）。
- inventory：`src/storage/db-access-inventory.ts` + `src/test/unit/db-access-inventory-completeness.test.ts`。
- 测试：每 worker 一个 `*-sharding.test.ts`（照 billing-outbox-sharding.test.ts 脚手架）。

---

## Task 1: MediaRetentionWorker GDPR fan-out + 健康状态机（最优先）

**Files:**
- Modify: `src/perception/media/media-retention-worker.ts`（ctor 收 resolver + flushOnce fan-out + 健康状态机 + metric）
- Modify: `src/server/app.ts:609-611`（装配传 resolver）
- Modify: `src/observability/`（暴露 `meterShardEraseFailure` + degraded gauge 到 metrics surface——找 billing meter 现有落点照抄）
- Test: `src/test/unit/media-retention-sharding.test.ts`（新建）

**Interfaces:**
- Consumes: `TenantDbResolver.allShardDbs()`、`runMediaRetention(db, eraser, ...)`（media-ref-store）、`SqliteEventLedger` 无关。
- Produces: `MediaRetentionWorker` ctor `(resolver, mediaEraser, logger, config)`；`flushOnce(): { totalErased; shardErrors: Array<{ shardKey; error }> }`；`isHealthy(): boolean`（健康状态机）；per-shard 失败状态 Map（key=稳定物理库标识）。

- [ ] **Step 1: 写 GDPR fan-out + 健康状态机测（红）**

`media-retention-sharding.test.ts`（FakeMultiShardResolver 2 shard + throwingDb 桩）：
1. **fan-out 擦除**：s0/s1 各 seed 过期 media ref → flushOnce → 两 shard 过期 media 都被 `runMediaRetention` 擦 + 擦除器对两 shard 都调；totalErased=两 shard 之和。
2. **仅 home 会漏（旧行为）**：断言若只跑 allShardDbs()[0] 则 s1 漏——用聚合计数证真 fan-out。
3. **shard 抛错隔离 + 健康**：throwingDb 注 s1 → flushOnce 记 shardErrors[s1] + s0 仍擦 + `meterShardEraseFailure` 触发 + logger.error(非 info) + `isHealthy()===false`。
4. **failed>0 路径**：擦除器对 s1 的对象擦除抛（runMediaRetention 内部捕获返 failed>0，不进 shard catch）→ 断言仍记 meterShardEraseFailure + logger.error + isHealthy false。
5. **恢复**：s1 修好，下一轮 failed===0 无异常 → 断言该 shard 失败状态清除；两 shard 都好 → isHealthy true。

- [ ] **Step 2: 跑测确认失败** — `npx tsx --test src/test/unit/media-retention-sharding.test.ts`，Expected FAIL（ctor 裸 tx）。

- [ ] **Step 3: 改 MediaRetentionWorker**

ctor 收 resolver。flushOnce：
```
const shardErrors = [];
for (const shardDb of resolver.allShardDbs()) {
  const shardKey = <稳定物理库标识>;  // 非数组下标——用 db 实例身份/connStr
  try {
    const r = await runMediaRetention(shardDb, this.eraser, ...);
    if (r.failed > 0) { this.recordFailure(shardKey); meterShardEraseFailure(shardKey); logger.error(...); }
    else this.recordSuccess(shardKey);
    totalErased += r.erased;
  } catch (e) { shardErrors.push({shardKey, error:e}); this.recordFailure(shardKey); meterShardEraseFailure(shardKey); logger.error(...); }
}
return { totalErased, shardErrors };
```
`isHealthy()` = per-shard 失败状态 Map 全空。`recordFailure/recordSuccess` 维护 per-shard {consecutiveFailures, lastFailureAt}。暴露 `meterShardEraseFailure` metric 到 metrics surface（找现有 billing meter 暴露点照抄）+ degraded gauge。

- [ ] **Step 4: 跑测确认通过** — Expected PASS。

- [ ] **Step 5: 装配 + 全门** — app.ts:609 传 resolver（captureResolver('media-retention')）。`npm run test:golden` EXIT 0。

- [ ] **Step 6: Commit**

```bash
git add src/perception/media src/server/app.ts src/observability src/test/unit/media-retention-sharding.test.ts
git commit -m "feat(shard): MediaRetentionWorker GDPR allShardDbs fan-out + 健康状态机(抛错/failed>0 立即 degraded,meterShardEraseFailure 暴露 metrics)

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

- [ ] **Step 3: 改 worker**

```
for (const shardDb of resolver.allShardDbs()) {
  const shardKey = <稳定标识>;
  try { const ledger = new SqliteEventLedger(shardDb); const r = await personaCoreDualWrite.flushOutbox(shardDb, ledger); totalFlushed+=r.flushed; totalFailed+=r.failed; }
  catch (e) { shardErrors.push({shardKey, error:e}); logger.error(...); }
}
```
删原 ctor 的 `this.ledger = new SqliteEventLedger(opts.db)`（改循环内构造）。

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

## Task 4: ToolInvocations + retention timer + cleanupExpiredTokens + observability worker fan-out

**Files:**
- Modify: `src/agent/tool-invocations-retention-worker.ts`（worker 遍历 allShardDbs 各 new ToolPermissionService(shardDb)）
- Modify: `src/identity/auth-service.ts`（cleanupExpiredTokens fan-out allShardDbs）
- Modify: `src/main-observability-worker.ts`（各 shard 各 drain outbox + rollup）
- Modify: `src/server/app.ts:749-757,941-948,950-981`（tool worker + cleanupTokens timer + retention timer 传 resolver）
- Test: `src/test/unit/retention-timers-sharding.test.ts`（新建）

**Interfaces:**
- ToolInvocations: worker `for (const shardDb of resolver.allShardDbs()) new ToolPermissionService(shardDb).pruneInvocationsBefore(...)` 逐 shard 隔离聚合。
- cleanupExpiredTokens: `cleanupExpiredTokens()` 改 `let total=0; for (const shardDb of this.resolver.allShardDbs()) total += AuthService.cleanupExpired(shardDb); return total;`（逐 shard 隔离）。
- retention timer: 跨租户表（usage_records/billing_outbox/idempotency_keys）对 allShardDbs 各 prune；webhook_events（平台表）→ coordinatorDb。
- observability worker（`main-observability-worker.ts` 独立进程）: `ObservabilityPipelineService` drain outbox + rollup 对 allShardDbs 各跑一遍（各 shard 各 drain 自己的 observability outbox + 各 rollup），逐 shard 隔离。ctor/装配收 resolver（独立进程入口按现有 db 构造改 resolver 构造）。

- [ ] **Step 1: 写四处 fan-out 测（红）**

（2 shard）① ToolInvocations：s0/s1 各 seed 过期 tool invocation → prune → 两 shard 都清。② cleanupExpiredTokens：refresh_token 落 s1 过期 → cleanup fan-out → s1 token 清（coordinatorDb-only 旧行为漏 s1，断言抓）。③ retention timer：usage_records/billing_outbox 各 shard 过期行 → 两 shard 都清；webhook_events → coordinatorDb 清。④ observability：s0/s1 各 seed pending observability event → drain → 两 shard outbox 都 drain + 各 rollup（仅 home drain 会漏 s1，断言抓）。throwingDb 注 s1 → 各处隔离。

- [ ] **Step 2: 跑测确认失败** — Expected FAIL。
- [ ] **Step 3: 改四处** — 按 Interfaces。cleanupExpiredTokens 需 AuthService 持 resolver（Plan 1c 已 resolver 化，确认）。observability worker 是独立进程入口，装配层改 resolver 构造（若独立进程无 resolver 则从 config buildResolver）。
- [ ] **Step 4: 跑测确认通过** — Expected PASS。
- [ ] **Step 5: 装配 + 全门** — app.ts 三处 + observability 入口传 resolver。`npm run test:golden` EXIT 0。
- [ ] **Step 6: Commit**

```bash
git add src/agent/tool-invocations-retention-worker.ts src/identity/auth-service.ts src/main-observability-worker.ts src/server/app.ts src/test/unit/retention-timers-sharding.test.ts
git commit -m "feat(shard): ToolInvocations+cleanupTokens+retention timer+observability worker fan-out(token 落 shard 修 coordinatorDb-only 漏清 bug)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: MetricsQueryService scatter-gather + partial failure

**Files:**
- Modify: `src/observability/metrics-query-service.ts`（5 项聚合 scatter-gather + 合并算法 + partial failure）
- Modify: `src/server/routes/metrics.ts`（加 resolver 注入 + 返回 {data,degraded,shardErrors}）
- Modify: `src/server/app.ts:887`（registerMetricsRoutes 传 resolver）
- Test: `src/test/unit/metrics-sharding.test.ts`（新建）

**Interfaces:**
- MetricsQueryService ctor 收 resolver（或 fromResolver）；每聚合方法遍历 allShardDbs 逐 shard 查 + 合并 + 收集 shardErrors。
- 合并算法（spec 定死）：diversity 原始 styles concat→`personalityDiversity(全部 styles)`；billing/queue count SUM；observability count SUM + `updated_at` MAX；tenant usage 全局 merge+sort+limit。
- 返回 `{ data, degraded: shardErrors.length>0, shardErrors }`。

- [ ] **Step 1: 写 metrics 聚合 + partial failure 测（红）**

（2 shard）s0/s1 各有租户/backlog/style → ① diversity=两 shard 全部 styles 全局重算（非局部分数 SUM，断言值 = 合并样本的 personalityDiversity）；② billing backlog=SUM；③ observability rollup count SUM + updated_at=两 shard MAX；④ tenant usage=两 shard 租户全局 merge+sort+limit（非各 shard 各 limit）；⑤ throwingDb 注 s1 → 返回 degraded:true + shardErrors 含 s1 + data 是 s0 部分聚合（非静默当零）。

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
- Modify: `src/server/routes/admin-deployment.ts`、`onboarding-v2.ts`（加 resolver 注入 + 直查改 dbForTenant）
- Modify: `src/server/app.ts`（四 route registrar 传 resolver）
- Modify: `src/storage/db-access-inventory.ts` + `src/test/unit/db-access-inventory-completeness.test.ts`
- Test: `src/test/unit/route-direct-query-sharding.test.ts`（新建）+ 现有 decisions/onboarding route 测回归

**Interfaces:**
- decisions/onboarding：删 `const sharedDb = deps.db ?? os.getDatabase()`，route 内 tenant-scoped 查（subscriptions/decision_cases/decision_runs/onboarding_sessions）改 `resolver.dbForTenant(request.tenantId)`（SQL 仍带 WHERE tenant_id）。
- admin-deployment/onboarding-v2：route 加 resolver 参，tenant_key_versions/persona_versions 直查改 dbForTenant。

- [ ] **Step 1: 写 route 直查落对 shard 测（红）**

（2 shard）租户 A 映射 s1 → 经 decisions/onboarding route 建 decision_case/onboarding_session → 断言行落 **s1**（`dbForTenant(A)`）+ **s0 无**；admin-deployment tenant_key_versions/onboarding-v2 persona_versions 同理落对 shard。

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

- **Spec 覆盖**：GDPR MediaRetention(Task1)/DualWrite(Task2)/Settlement+RuntimeRecovery(Task3)/ToolInvocations+cleanupTokens+retention timer+observability worker(Task4)/metrics scatter-gather(Task5)/route 直查(Task6) — spec 范围 A/B/C/D 全覆盖，observability worker 已并入 Task 4。
- **Codex writing-plans note**：per-shard 健康用稳定物理库标识非数组下标（Task1/各 worker shardKey）✅；meterShardEraseFailure 按失败 shard-run 计数（Task1）✅。
- **Placeholder 扫描**：无 TBD；observability worker fan-out 已并入 Task 4（四处 fan-out）。
- **类型一致**：各 worker flushOnce/flush 返回含 shardErrors；MetricsQueryService 聚合返回 {data,degraded,shardErrors}；worker ctor 全收 resolver。
- **诚实性**：inventory 校准（Task6）逐 edge、有测才 verified、绝不 mass-upgrade，对齐 Plan 1b/1c 铁律。
- **fail-closed 不放开**：全程不碰 assertShardingActivationAllowed（Plan 3）。
