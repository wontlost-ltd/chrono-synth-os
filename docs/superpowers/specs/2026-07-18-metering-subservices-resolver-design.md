# 计量子服务双入口化（TokenBudget/CostTracker/UsageTracker）设计

> **状态**：设计已定（Codex 复审 86→采纳 5 处收口），待 writing-plans。
> **归属**：#3 租户分片 Phase 0 —— 「12 访问点接线」sub-phase 的第二批子服务（第一批 QuotaManager 已合入 PR #314）。
> **前置**：QuotaManager 双入口模式（PR #314）已立范本；`TenantDbResolver`/`SingleDbResolver`/`FakeMultiShardResolver` 已就位。

## 背景与问题

上一子片把 `QuotaManager` 改成「双入口」范本：`fromResolver(resolver)`（route 长期服务，per-tenant→`dbForTenant`、cross-tenant→`allShardDbs` fan-out）/ `fromUnitOfWork(tx)`（已绑事务的调用链固定用该 tx）。本批把**同一模式**套到三个计量子服务。

侦察确证三者**全 per-tenant 方法、零 cross-tenant 方法**——比 QuotaManager 还简单（无 fan-out）。它们与 QuotaManager 在同一批 route 的注册期被并排构造（`memory-facade.ts:101-104` 里 QuotaManager 已 `fromResolver(new SingleDbResolver(...))`，紧邻的这三个仍是旧式裸构造）。

## 本批范围（YAGNI）

**只做**：`TokenBudget` / `CostTracker` / `UsageTracker` 三个子服务的双入口化 + 探针测试 + 全部构造点原子迁移。三者同构 QuotaManager，一个 spec/plan，每件独立 task。

**不做**（各自后续独立 brainstorm）：
- `BillingOutbox`（`flush()` 是 async 跨租户轮询 + `app.ts:867` 定时器多 shard 下漏 flush 会漏计收入 + config/clock 依赖）——第二批，独立设计。
- `PersonaCoreService`（聚合根，构造期建 4 子服务级联）/ `PersonaTemplateService`（级联依赖 + `syncBuiltins` 分片归属未决架构决策，设计文档遗漏）——第三批，最重，独立设计。

## 核心模式（照 QuotaManager，比它更简单）

三者所有公共方法都 per-tenant（首参 `tenantId`），**无 cross-tenant 方法**。改造：私有构造器 + 两静态工厂 + 内部 source 抽象，per-tenant 方法经 `this.source.forTenant(tenantId).execute/queryOne/queryMany(...)`。**无 fan-out**（QuotaManager 有 pruneUsageBefore fan-out，这三个没有——source 只需 `forTenant`，不需要 `allDbs`）。

因 `IDatabase extends SyncWriteUnitOfWork`（`src/storage/database.ts:27`），resolver 返回的 IDatabase 直接当 SyncWriteUnitOfWork 用，无适配层。

### 内部 source 抽象（比 QuotaManager 的 QuotaSource 更薄）

```
interface MeterSource {
  forTenant(tenantId: string): SyncWriteUnitOfWork;
}
```
- resolver 模式：`forTenant: (t) => resolver.dbForTenant(t)`。
- UoW 模式：`forTenant: () => tx`（忽略 tenantId 恒返固定 tx）。
不需要 `allDbs()`（无 cross-tenant 方法）。若嫌为三个类各定义一遍啰嗦，可提取一个共享的最小 `MeterSource`/工厂 helper —— 但 YAGNI，三者内联各自的两工厂即可（与 QuotaManager 风格一致，不新增跨文件抽象；plan 阶段若发现三份逐字重复再决定是否提取，遵循「重复三次再通用化」）。

## 各子服务改造

### CostTracker（`src/intelligence/cost-tracker.ts`）——最干净
- 现构造：`constructor(db?: IDatabase)`。
- 双入口后：`private constructor(source: MeterSource)` + `static fromResolver(resolver)` / `static fromUnitOfWork(tx)`。
- 方法（全 per-tenant，首参 tenantId）：`record`/`getMonthlySummary`/`getRecent` → 内部 `this.source.forTenant(tenantId)`。
- **无-db 第三态砍掉**：现 `db?` 可选，但已 grep 确认**所有生产点都传 db**（memory-facade:102/decisions:68/onboarding:71），无-db 态生产无人用。工厂 resolver/tx 必填。测试若依赖无-db，改传 `fromUnitOfWork(内存db)`。

### TokenBudget（`src/intelligence/token-budget.ts`）——保 config 首参；**纯读服务（无 db 写）**
- 现构造：`constructor(config?: Partial<TokenBudgetConfig>, db?: IDatabase)`。
- 双入口后：`static fromResolver(config, resolver)` / `static fromUnitOfWork(config, tx)`（**config 位保留**）。
- **已核实事实（Codex + 亲验）：TokenBudget 无任何 db 写方法**。`getUsage`（私有）经 `this.tx.queryOne(llmQueryPeriodTotal(...))` **读** `llm_usage` 表（该表由 `CostTracker.record` 写）。checkBudget/checkAlert/getSummary 全走 `getUsage` **读**。`recordUsage` **只写内存 cache**（`Map<tenantId, UsageCache>`），不碰 db。
- 改造：
  - `checkBudget`/`checkAlert`/`getSummary`（读路径）→ 内部 `this.source.forTenant(tenantId).queryOne(...)`（**读**对应 shard）。
  - `recordUsage`（纯内存）→ **保持原样不碰 source**（红线 2：纯内存方法不得为形式统一伪解析 db）。
- 无-db 第三态砍掉（生产点 memory-facade:101/decisions:67/onboarding:70 全传 db，亲验无生产/测试依赖无-db 态）。

### UsageTracker（`src/billing/usage-tracker.ts`）——声明放宽
- 现构造：`constructor(tx: SyncWriteUnitOfWork)`（声明窄，但生产实传多为 IDatabase）。
- 双入口后：`static fromResolver(resolver)` / `static fromUnitOfWork(tx)`。
- 方法（全 per-tenant）：`record`/`getUsage`/`getSummary`。
- **注意 usage_records 的清理**：侦察发现清理逻辑**不在 UsageTracker 类内**（是 `app.ts:856` 独立 `pruneTable` 闭包裸 SQL）——本批不碰它（那是后续「裸 SQL 访问点」子片的事）。UsageTracker 自身无 cross-tenant 方法，纯 per-tenant。

## 有意的公共 API 破坏（Codex 采纳）

三个类是导出的公共类，构造器私有化是**有意的编译期 API 破坏**（消费者不再能 `new`，必须走工厂）。仓内全部构造点原子迁移保编译；仓外消费者（若有）按此迁移映射：

```
new TokenBudget(config, db)  →  TokenBudget.fromUnitOfWork(config, db)   // 已绑事务
                             或  TokenBudget.fromResolver(config, new SingleDbResolver(db))
new CostTracker(db)          →  CostTracker.fromUnitOfWork(db) / fromResolver(new SingleDbResolver(db))
new UsageTracker(tx)         →  UsageTracker.fromUnitOfWork(tx) / fromResolver(...)
```

不保留无-db 第三态：它让 db 缺失静默退化为「零用量」，会掩盖配置错误（fail-silent 反模式）。

## 构造点迁移（按声明静态类型分类，原子提交保编译）

判据（同 QuotaManager）：声明 `IDatabase`→`fromResolver(new SingleDbResolver(x))`；声明**仅** `SyncWriteUnitOfWork`→`fromUnitOfWork(x)`。

**已核实的分类表：**

| 子服务 | fromResolver（声明 IDatabase）生产点 | fromUnitOfWork（声明仅 SyncWriteUnitOfWork）生产点 | 测试点 |
|---|---|---|---|
| CostTracker | memory-facade:102、decisions:68、onboarding:71 | 无 | model-router.test:192（+按需） |
| TokenBudget | memory-facade:101、decisions:67、onboarding:70 | 无 | model-router.test:136/150/167 |
| UsageTracker | memory-facade:104(sharedTx)、life-simulations:41(optTx)、onboarding:76、decisions:71 | **billing-route-facade:77**（`tx: SyncWriteUnitOfWork`，`:74`） | model-router:292、conversation-billing-usage:71、billing-uow-entrance:32/33、billing-usage-outbox:43/55、billing-api:133 |

TokenBudget/CostTracker 私有化构造器后，config 位在 fromResolver/fromUnitOfWork 保留。测试构造点全部内存 db → `fromUnitOfWork(db)`（单库语境，最贴近原持单一 db，改动最小）。**plan 阶段用 `grep -rn "new TokenBudget(\|new CostTracker(\|new UsageTracker(" src` 复核完整清单，逐点分类，漏一个编译红。**

## 验收脚手架（复用上片）

`FakeMultiShardResolver`（`src/test/support/fake-multi-shard-resolver.ts`，上片已建）直接复用。**一个文件 `src/test/unit/metering-subservices-sharding.test.ts`，三个 describe**（CostTracker/UsageTracker 用写路由探针，TokenBudget 用读路由探针）。

### CostTracker / UsageTracker（写路由探针）
1. **per-tenant 分流（对称）**：tA→shard1、tB→shard2；各自 `record(...)`；断言 shard1 db 查得到 tA 的行且查不到 tB、shard2 查得到 tB 且查不到 tA（**对称**——上片教训：不对称断言漏「固定返回恰好等于 tA 目标」的 bug）。
2. **UoW 模式**：`fromUnitOfWork(db)` 写落该 db。
3. **单库零回归**：`fromResolver(new SingleDbResolver(db))` 与改造前等价。

### TokenBudget（读路由探针——它无 db 写方法，Codex 采纳的确定契约）
TokenBudget 只**读** `llm_usage`（CostTracker 写的表），故探针验「按 tenantId 从对应 shard **读**对了」：
1. **预置**（读前先写）：shard1 的 `llm_usage` 预置 tA 数据（如 total_tokens=11），shard2 预置 tB 数据（**不同值** total_tokens=22）；两 shard 不复制同一 tenant。
2. **读路由**：同一 `TokenBudget.fromResolver(config, resolver)`，`getSummary(tA)` 读出 11、`getSummary(tB)` 读出 22（用 `getSummary`——返回精确 used 值；不用 `checkBudget`——布尔区分弱）。
3. **变异**：`dbForTenant` 恒返 shard1 → `getSummary(tB)` 读到 0（非 22）→ 测试失败。
4. **cache 防假阳性**（TokenBudget 有 `Map<tenantId,UsageCache>` 首读缓存）：预置 db 数据**在首次读之前**完成；每 tenant 只触发一次首读或每测试新建实例；**不要先调 recordUsage**（污染 cache）。
5. `recordUsage` 只测「tenantId 维度内存 cache 隔离」（行为回归），**不算 shard 分流探针**（不碰 resolver）。

**无 fan-out/fail-fast/去重断言**（三者无 cross-tenant 方法）。

## usage_records 清理的多-shard 风险（登记，归后续子片）

`usage_records` 旧行清理**不在 UsageTracker 类内**——是 `app.ts:856` 独立 `pruneTable('usage_records', ...)` 闭包裸 SQL，捕获单个 `db`。**多 shard 启用后只清理该单库、其余 shard 的 usage_records 持续累积**（保留失效 + 存储膨胀）——与 BillingOutbox 定时器同类风险。本批不碰（归后续「裸 SQL/跨租户维护」子片），但**显式登记为多-shard 启用前阻塞风险**：真正 activate 分片前必须完成该清理 fan-out。本批只「铺路」，不宣称 retention 已具备多-shard 正确性。

## 红线（不变量）

1. **零回归**：单库（SingleDbResolver）+ UoW 模式与改造前逐字等价；全量 unit fail=0。
2. **实际访问 db 的 per-tenant 路径必经 forTenant**：所有**真正读写 db** 的带 tenantId 方法经 `this.source.forTenant(tenantId)`，不残留直接持 db。**纯内存方法（TokenBudget.recordUsage）不得为形式统一伪解析 db**（Codex 采纳：伪路由降低数据结构诚实性）。
3. **UoW 模式固定 tx**：`forTenant` 忽略 tenantId 恒返 tx，不重新解析（结构上不可能脱离事务）。
4. **无 cross-tenant/fan-out**：三者无 allShardDbs 调用（它们没有跨租户方法）；若 plan 发现漏判的 cross-tenant 方法，退回补 fan-out 设计。
5. **无适配层**：直接用 IDatabase extends SyncWriteUnitOfWork。
6. **inventory 不动**：三者不命中 ratchet 拿-db 模式；route 的 longlived-root-capture 条目保留；`check:db-access` 继续通过。
7. **验收真证分流**：探针用独立物理 db 断言（对称），非「不报错」；变异证明（forTenant 固定→分流测试红）。
8. **构造点分类以声明静态类型为准**：UsageTracker 的 billing-route-facade:77 走 fromUnitOfWork（声明仅 SyncWriteUnitOfWork），其余全 fromResolver。

## 验收标准

- `npm run typecheck` exit 0；`npm run build` 成功。
- 探针测试全绿（每子服务 per-tenant 分流对称 + UoW + 零回归）。
- 全量 unit fail=0（零回归铁证）。
- `npm run check:db-access` exit 0（inventory 条数不变）。
- 无 `new TokenBudget(`/`new CostTracker(`/`new UsageTracker(` 外部残留（构造器私有后）。
- 交叉审查（生成者≠审查者）：含变异测试证探针非重言式（forTenant 恒固定 → 对称分流断言应变红）。
