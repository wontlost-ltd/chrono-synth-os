# BillingOutbox 双入口化（async fan-out + 收入上报隔离）设计

> **状态**：设计已定，待 Codex 交叉审查 → writing-plans。
> **归属**：#3 租户分片 Phase 0 —— 「12 访问点接线」sub-phase 的第三批子服务（计量/账单四件套的最后一个，唯一 (B) 有 fan-out）。
> **前置**：QuotaManager 双入口 + fan-out fail-fast 范本（PR #314）；计量三件套双入口（PR #314）；`TenantDbResolver`/`SingleDbResolver`/`FakeMultiShardResolver` 已就位。

## 背景与问题

BillingOutbox 是 Stripe 计量发件箱：`enqueue` 把计量事件持久化到 `billing_outbox` 表，`flush`（60s 定时器调）批量异步上报 Stripe 并 markSent/markFailed。侦察确证它是四件套里**唯一 (B)——有 cross-tenant 方法需 fan-out**：

- **`enqueue(tenantId, ...)`**：per-tenant 写（首参 tenantId）→ `dbForTenant`。
- **`flush(batchSize)` async、无 tenantId、全表 outbox worker**：`boutboxCmdRequeueStale`/`boutboxQueryPending`/`boutboxCmdClaim`/`markSent`/`markFailed` 全**不按 tenantId 过滤**（已核实 `billing-outbox-queries.ts`：pending/count 参数无 tenantId）；每行含 `row.customer_id` 直接调 Stripe `reportUsage`（与 tenantId 无关）→ 每 shard 独立 flush 自己的 outbox 是正确的。cross-tenant → `allShardDbs()` fan-out。
- **`pendingCount`/`failedCount`（无 tenantId 全表）** → `allShardDbs()` fan-out 求和。

**真正确性风险（本片核心动机）**：`app.ts:867` 的 60s 定时器 `billingOutbox.flush()` 现持单库 db（`tx = db`）。多 shard 下若不 fan-out，只 flush 一个 shard → **其余 shard 的 billing_outbox 事件永不上报 Stripe = 收入漏计**。

## 本片范围（YAGNI）

**只做**：BillingOutbox 双入口化（enqueue→dbForTenant、flush/count→allShardDbs fan-out）+ 定时器接线持 resolver + 探针测试 + 构造点原子迁移。

**不做**（后续）：Persona 两件套（第四批，聚合根级联 + syncBuiltins 架构决策）；app.ts 穿真 ShardRouter 到 route 层；usage_records 清理定时器 fan-out（前片已登记为多-shard 启用前阻塞风险）。

## 核心模式（三个范式）

### 范式 A：per-tenant（enqueue）
`enqueue(tenantId, ...)` → `this.source.forTenant(tenantId).execute(boutboxCmdEnqueue(...))`。
> 模块级 `fallbackSeqCounter`（进程全局幂等键后缀，与 db 无关）保持原样——它是 idempotency_key 派生用，非 db 状态，fan-out 无影响。

### 范式 B：cross-tenant async fan-out（flush）——**逐 shard 隔离尽力**（用户裁决）
flush 是 async 收入上报 worker（内部对每行已 try/catch）。fan-out 时**某 shard 整体故障不拖累其他 shard 上报**（有意偏离 QuotaManager prune 的 fail-fast——prune 是清理漏一轮无害；flush 是收入上报，一个 shard 挂不该延迟其他 shard 的付费事件上报）：

```
async flush(batchSize = 50): Promise<FlushResult> {
  let processed = 0, failed = 0;
  const shardErrors: { shard: string; error: string }[] = [];   // 含 shard 身份（Codex 采纳）
  const dbs = this.source.allDbs();
  for (let i = 0; i < dbs.length; i++) {            // 顺序 await（见下"顺序 vs 并发"）
    try {
      const r = await this.flushOneDb(dbs[i]!, batchSize); // = 现有 flush 单-db 逻辑
      processed += r.processed;
      failed += r.failed;
    } catch (err) {                                   // 该 shard 整体挂（db 连接等）
      shardErrors.push({ shard: String(i), error: err instanceof Error ? err.message : String(err) });
      // 不 rethrow——继续 flush 其余 shard（收入上报隔离）
    }
  }
  return { processed, failed, shardErrors };
}
```

- `flushOneDb(db, batchSize)`：**提取现有 flush 单-db 逻辑**（requeueStale → queryPending → 逐行 claim/reportUsage/markSent|markFailed），把 `this.tx` 换成参数 `db`。内部逐行 try/catch 不变（单行失败不误伤同 shard 其他行）。**requeueStale 每 shard 各自执行正确**（processing 状态 + 行 ID 都属各物理库，无跨 shard 协调）。
- 返回类型 `{ processed, failed }` → `FlushResult = { processed: number; failed: number; shardErrors: { shard: string; error: string }[] }`。这是**可观察 API 形状变化**（现调用方只忽略返回值不会运行时破坏），调用方仅定时器（见定时器接线）。
- **shardErrors 含 shard 身份**（Codex 采纳）：当前 resolver 接口不暴露 shard ID，故用**稳定索引**（allDbs 顺序位）作可定位标识；spec 明标此为索引级身份（非 connStr），够运维定位「第 N 个 shard 卡住」。
- **batchSize 语义变化**（Codex 采纳，写进契约）：从「本次 flush 总上限」变「**每 shard 上限**」，单轮全局最多 `uniqueShardCount × batchSize`。有意选择（各 shard 独立进度），契约明示。
- **顺序 await（非并发）**：outbox 是慢而稳的后台 worker（60s 间隔 + unref 定时器，延迟不敏感）；顺序天然限流避免同时对 Stripe 发 N×batchSize 请求触发 429。YAGNI——真到大 N 性能问题再优化。
- **被放大的既有风险（留痕，非本片修）**：(a) `setInterval` 无 in-flight guard，多 shard 顺序执行更易超 60s 致 flush 重叠——乐观 claim 能挡普通重叠/多实例竞争，但概率上升；(b) 若单次 Stripe 请求 > STALE_PROCESSING_MS(5min)，下轮 requeueStale 可能重认领仍在执行的行，Stripe idempotency key 降低重复计费风险但不为零。二者是既有设计，fan-out 只增重叠概率、未引入新 claim 正确性问题。

### 范式 C：cross-tenant fan-out 求和（pendingCount/failedCount）
```
pendingCount(): number { return this.source.allDbs().reduce((s, db) => s + <单db pendingCount>, 0); }
```
failedCount 同。（同步，无 async——它们只查询不调 Stripe。）

## 签名变更：双入口

`QuotaManager` 的 QuotaSource（`forTenant` + `allDbs`）形状正好适用（BillingOutbox 两种方法都要）：

```
interface OutboxSource {
  forTenant(tenantId: string): SyncWriteUnitOfWork;  // enqueue 用
  allDbs(): SyncWriteUnitOfWork[];                    // flush/count fan-out 用
}
class BillingOutbox {
  private constructor(private readonly source: OutboxSource, private readonly config: AppConfig, private readonly clock: Clock = realClock) {
    registerCoreSelfExecutors();
  }
  static fromResolver(resolver: TenantDbResolver, config: AppConfig, clock?: Clock): BillingOutbox { ... }
  static fromUnitOfWork(tx: SyncWriteUnitOfWork, config: AppConfig, clock?: Clock): BillingOutbox { ... }
}
```
- config/clock 位保留（BillingOutbox 独有的额外依赖）。
- UoW 模式：`forTenant: () => tx`、`allDbs: () => [tx]`——flush 单次不真 fan-out（allDbs=[tx] 遍历一次），行为等价现状。
- 因 `IDatabase extends SyncWriteUnitOfWork`，无适配层。内联 OutboxSource（不跨文件抽象，YAGNI）。

## 定时器接线（用户裁决：本片接线持 resolver）

`app.ts:867`：`new BillingOutbox(tx, config)` → `BillingOutbox.fromResolver(new SingleDbResolver(tx), config)`（`tx = db` IDatabase；单库等价现状，allDbs=[db]，分片激活后换真 resolver 自动 fan-out）。

**定时器处理 shardErrors（Codex 采纳——必须处理 resolved-result，非仅 `.catch()`）**：shardErrors 在 flush **正常 resolve** 时返回（异常已被逐 shard 隔离吞掉），故现有 `.catch()` 抓不到——必须在 `.then(result => ...)`（或 async 定时器包装 await）里处理：
```
void billingOutbox.flush().then((result) => {
  if (result.shardErrors.length > 0) {
    for (const e of result.shardErrors) {
      logger.warn('Billing', `计量发件箱 shard ${e.shard} flush 失败: ${e.error}`);
    }
    billingMetrics.meterShardFlushErrors += result.shardErrors.length;  // 可告警计数（防坏 shard 静默欠账）
  }
}).catch((err) => logger.warn('Billing', `计量发件箱刷新失败: ...`));  // 保留（防非隔离的意外抛）
```
加 `billingMetrics.meterShardFlushErrors` 计数（模块级，同 meterEventsProcessed 款）——**防「坏 shard 永远静默失败无人发现」的反例**（Codex 指出）：结构化日志 + 可告警计数指标，同一 shard 连续失败能被监控聚合。

## 构造点迁移（按声明静态类型，原子提交保编译）

**已核实的全部构造点**（grep + 别名双查；enqueue/flush **方法调用方不改**——双入口只改构造点，实例已是 fromResolver 的方法调用自动生效）：

**6 个生产构造点**（Codex 复审纠正——原漏 app.ts:448、错标 :867 为别名）：

| 分类 | 构造点 |
|---|---|
| fromResolver（声明 IDatabase） | memory-facade:105（config 三元）、life-simulations:42（optTx 三元）、decisions:73、onboarding:77、**app.ts:448（别名 `P1dBillingOutbox`，`config.stripe.enabled` 三元）**、**app.ts:867（普通 `BillingOutbox`，定时器）** |
| 测试 fromUnitOfWork（内存 db） | billing-uow-entrance:41/42/51/73 |

**app.ts 有两个 BillingOutbox 构造点**（已核实）：`:448 const p1dBillingOutbox = config.stripe.enabled ? new P1dBillingOutbox(tx, config) : undefined`（**别名** `BillingOutbox as P1dBillingOutbox`，app.ts:120）+ `:867 const billingOutbox = new BillingOutbox(tx, config)`（**普通名**，定时器；见下定时器接线）。两者 `tx = db` IDatabase → 均 fromResolver。**无 billing-route-facade 构造点**（BillingOutbox 不在 façade 里）。grep `new BillingOutbox(` 抓不到 :448 的 `new P1dBillingOutbox(`——**靠 `npm run typecheck`（TS2673）权威兜底**（前片教训）。enqueue/flush 方法调用方（model-router/decisions/life-simulations）**不改**（双入口只改构造点，实例方法自动生效——前提是全部 6 个构造点都迁移，尤其别漏 :448）。

## 验收探针（复用 FakeMultiShardResolver）

**关键约束（已核实）**：`reportUsage` 是模块 import 直调、**不可注入**，无 Stripe secretKey 会抛「Stripe secretKey 未配置」。现有 outbox 测试从不真调 flush。故探针**用失败路径验 fan-out/隔离**（不碰真 Stripe、不需给生产加注入 seam——YAGNI）：无 key → 每行 reportUsage 抛 → markFailed（flush 内部 try/catch 不抛出），但**fan-out 遍历 + 逐 shard 隔离逻辑照跑**。

`src/test/unit/billing-outbox-sharding.test.ts`（无 stripe.secretKey 的 config）：

1. **enqueue per-tenant 分流（对称）**：tA→shard1、tB→shard2；各 `enqueue`；断言 shard1 的 billing_outbox 有 tA 行、无 tB 行；shard2 反之（对称）。用 `BillingOutbox.fromUnitOfWork(sN, config).pendingCount()` 或直接查行数验。
2. **flush fan-out（失败路径证遍历）**：两 shard 各 enqueue 一条 pending；`flush()`（无 Stripe key → reportUsage 抛 → markFailed）；断言 `failed` = 两 shard 之和（证 fan-out 访问了**所有** shard 的 pending——若只 flush 一个 shard，failed 只会是单 shard 数）。
   > **成功路径（markSent/processed 聚合）未覆盖**（Codex 采纳记录）：reportUsage 不可注入、无 Stripe stub seam，本片不为此加生产注入接口（超范围）。失败路径已证 fan-out 拓扑正确（遍历所有 shard、failed 跨 shard 聚合）；processed 聚合走同一 for 循环累加逻辑，与 failed 对称，拓扑上不会单独错。**风险留痕**：若后续建 Stripe fake，补两 shard 成功后的 processed 聚合 + sent 状态断言。
3. **shard 整体隔离（核心）**：三 shard，中间一个用 `throwingDb`（execute 抛）；其余两 shard 各有 pending；`flush()`；断言 **不整体抛**、`shardErrors.length === 1` 且 `shardErrors[0].shard === '1'`（索引身份，记录挂掉的 shard）、**其余两 shard 的 pending 仍被 flush**（证「一个 shard 挂不拖累其他」）。
   > **markFailed 状态语义（Codex 纠正）**：`markFailed` SQL 是 `status = CASE WHEN attempts+1 >= maxAttempts THEN 'failed' ELSE 'pending' END`——**首次失败（attempts 0→1 < 5）回 `pending` 非 `failed`**。故断言「其余 shard 被 flush」须二选一：(a) 普通 attempts=0：断言其行 `attempts` 增 1、`last_error` 非空、status 回 `pending`（证被处理过）；(b) 预置 `attempts=4`：断言 flush 后 status=`failed`。用 (a)（更贴近真实首次失败路径，无需预置）。
4. **pendingCount/failedCount fan-out 求和**：两 shard 各预置若干 pending/failed 行；断言 count = 两 shard 之和。
5. **UoW 模式**：`fromUnitOfWork(db, config)`；enqueue 落该 db、flush 单次遍历（allDbs=[db]）、pendingCount 单 db。
6. **单库零回归**：`fromResolver(new SingleDbResolver(db), config)` 行为与改造前等价。

变异证明：把 flush 的 fan-out 改成只 `allDbs()[0]` → 探针 2（fan-out）应红（failed 只剩单 shard 数）；把逐 shard try/catch 改成 rethrow（fail-fast）→ 探针 3（隔离）应红（整体抛、其余 shard 未 flush）。

## 红线（不变量）

1. **零回归**：单库（SingleDbResolver）+ UoW 模式下 **db 副作用与计数语义（processed/failed）等价现状**（flush 返回形状加了 shardErrors 字段，故非「逐字」等价——单库下 shardErrors 恒为空数组，processed/failed 与旧 `{processed,failed}` 相同）；全量 unit fail=0。
2. **enqueue 经 forTenant**；**flush/count 经 allDbs fan-out**——不残留直接持单 db。
3. **flush 逐 shard 隔离**：某 shard 整体抛不 rethrow、记 shardErrors、继续其余 shard（与 QuotaManager prune 的 fail-fast 是**有意语义差异**，spec 具名）。
4. **UoW 模式 forTenant 忽略 tenantId 恒返 tx**（结构上不脱离事务）；allDbs=[tx]。
5. **顺序 await 非并发**（Stripe 限流；outbox 慢而稳）。
6. **无适配层**；模块级 fallbackSeqCounter/billingMetrics 保持原样（进程全局，非 db 状态）。
7. **inventory 不动**：BillingOutbox 不命中 ratchet；route/定时器的既有归类保留；`check:db-access` 继续通过。
8. **构造点分类以声明静态类型为准**：5 生产 fromResolver（含 app.ts:867 别名 P1dBillingOutbox）+ 测试 fromUnitOfWork；别名靠 typecheck 兜底。
9. **探针失败路径不碰真 Stripe**：无 secretKey config，验 fan-out/隔离的遍历逻辑（非 Stripe 集成）。

## 验收标准

- `npm run typecheck` exit 0（权威无残留含别名）；`npm run build` 成功。
- 探针全绿（6 类 + 2 变异证明）。
- 全量 unit fail=0（零回归铁证）。
- `npm run check:db-access` exit 0（inventory 条数不变）。
- 定时器接线：`app.ts:867` 走 fromResolver、catch 处理 shardErrors。
- 交叉审查（生成者≠审查者）：Codex 审 spec；实现后含变异测试证探针非重言式（fan-out→只碰首 db 应红、隔离→改 rethrow 应红）。
