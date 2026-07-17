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
  const shardErrors: { error: string }[] = [];
  for (const db of this.source.allDbs()) {          // 顺序 await（见下"顺序 vs 并发"）
    try {
      const r = await this.flushOneDb(db, batchSize); // = 现有 flush 单-db 逻辑
      processed += r.processed;
      failed += r.failed;
    } catch (err) {                                   // 该 shard 整体挂（db 连接等）
      shardErrors.push({ error: err instanceof Error ? err.message : String(err) });
      // 不 rethrow——继续 flush 其余 shard（收入上报隔离）
    }
  }
  return { processed, failed, shardErrors };
}
```

- `flushOneDb(db, batchSize)`：**提取现有 flush 单-db 逻辑**（requeueStale → queryPending → 逐行 claim/reportUsage/markSent|markFailed），把 `this.tx` 换成参数 `db`。内部逐行 try/catch 不变（单行失败不误伤同 shard 其他行）。
- 返回类型 `{ processed, failed }` → `{ processed: number; failed: number; shardErrors: { error: string }[] }`。**破坏性变更**，调用方仅定时器（app.ts:867，`.catch()` 里现只 warn）——改为顺带 warn shardErrors。
- **顺序 await（非并发）**：outbox 是慢而稳的后台 worker（60s 间隔 + unref 定时器，延迟不敏感）；顺序天然限流避免同时对 Stripe 发 N×batchSize 请求触发 429。YAGNI——真到大 N 性能问题再优化。spec 记录此取舍。

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

`app.ts:867`：`new BillingOutbox(tx, config)` → `BillingOutbox.fromResolver(new SingleDbResolver(tx), config)`（`tx = db` IDatabase；单库等价现状，allDbs=[db]，分片激活后换真 resolver 自动 fan-out）。定时器 `.catch()` 顺带处理 `shardErrors`：flush resolve 后若 `shardErrors.length > 0` 则 warn 每个（当前静默——多 shard 下让运维可见哪个 shard 的 outbox 卡住）。

## 构造点迁移（按声明静态类型，原子提交保编译）

**已核实的全部构造点**（grep + 别名双查；enqueue/flush **方法调用方不改**——双入口只改构造点，实例已是 fromResolver 的方法调用自动生效）：

| 分类 | 构造点 |
|---|---|
| fromResolver（声明 IDatabase） | memory-facade:105（config 三元）、life-simulations:42（optTx 三元）、decisions:73、onboarding:77、**app.ts:867（定时器，别名 `P1dBillingOutbox`）** |
| 测试 fromUnitOfWork（内存 db） | billing-uow-entrance:41/42/51/73 |

**无 billing-route-facade 构造点**（BillingOutbox 不在 façade 里）。**别名 import**：`app.ts:120 BillingOutbox as P1dBillingOutbox`——grep `new BillingOutbox(` 抓不到 `new P1dBillingOutbox(`，**靠 `npm run typecheck`（TS2673）权威兜底**（前片教训）。

## 验收探针（复用 FakeMultiShardResolver）

**关键约束（已核实）**：`reportUsage` 是模块 import 直调、**不可注入**，无 Stripe secretKey 会抛「Stripe secretKey 未配置」。现有 outbox 测试从不真调 flush。故探针**用失败路径验 fan-out/隔离**（不碰真 Stripe、不需给生产加注入 seam——YAGNI）：无 key → 每行 reportUsage 抛 → markFailed（flush 内部 try/catch 不抛出），但**fan-out 遍历 + 逐 shard 隔离逻辑照跑**。

`src/test/unit/billing-outbox-sharding.test.ts`（无 stripe.secretKey 的 config）：

1. **enqueue per-tenant 分流（对称）**：tA→shard1、tB→shard2；各 `enqueue`；断言 shard1 的 billing_outbox 有 tA 行、无 tB 行；shard2 反之（对称）。用 `BillingOutbox.fromUnitOfWork(sN, config).pendingCount()` 或直接查行数验。
2. **flush fan-out（失败路径证遍历）**：两 shard 各 enqueue 一条 pending；`flush()`（无 Stripe key）；断言 `failed` = 两 shard 之和（证 fan-out 访问了**所有** shard 的 pending——若只 flush 一个 shard，failed 只会是单 shard 数）。
3. **shard 整体隔离（核心）**：三 shard，中间一个用 `throwingDb`（execute 抛）；其余两 shard 各有 pending；`flush()`；断言 **不整体抛**、`shardErrors.length === 1`（记录挂掉的 shard）、**其余两 shard 的 pending 仍被 flush**（其行 status 变 failed，证「一个 shard 挂不拖累其他」）。
4. **pendingCount/failedCount fan-out 求和**：两 shard 各预置若干 pending/failed 行；断言 count = 两 shard 之和。
5. **UoW 模式**：`fromUnitOfWork(db, config)`；enqueue 落该 db、flush 单次遍历（allDbs=[db]）、pendingCount 单 db。
6. **单库零回归**：`fromResolver(new SingleDbResolver(db), config)` 行为与改造前等价。

变异证明：把 flush 的 fan-out 改成只 `allDbs()[0]` → 探针 2（fan-out）应红（failed 只剩单 shard 数）；把逐 shard try/catch 改成 rethrow（fail-fast）→ 探针 3（隔离）应红（整体抛、其余 shard 未 flush）。

## 红线（不变量）

1. **零回归**：单库（SingleDbResolver）+ UoW 模式与改造前逐字等价；全量 unit fail=0。
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
