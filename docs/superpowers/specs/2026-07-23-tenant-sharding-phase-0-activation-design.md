# 租户分片 Phase 0 全量激活设计

> 状态：第 2 轮修订（采纳 Codex 独立复审 58/100 退回——初版「低风险 7 文件」被推翻，恢复为高风险组合根/生命周期重构 + sink 级盘点前置）。待 Codex 再审 → 用户审阅 → writing-plans。
> 日期：2026-07-23
> 关联：分片设计总览 `2026-07-17-tenant-sharding-design.md`（Phase 0 契约在此定）；`shard-router-design.md`（引擎设计）；规模化缺口 #3；PR #314（子服务双入口化，已合入 main）。
> 范围：`src/server/app.ts`（组合根装配 resolver）、7 个 `sharedDb` 直用文件、`src/server/routes/metrics.ts` + `src/observability/`（fan-out）、`src/storage/factory.ts`（放开 fail-closed）、`src/config/schema.ts`（shard map 校验）、`src/storage/db-access-inventory.ts`（接线完成后重分类）。

## 1. 目标（一句话）

把分片引擎从「就位未激活」（`createDatabase` fail-closed 拒绝任何非空 `db.shards`）变为**可真多-shard 运行**：所有「显式 tenant_id 访问」经统一的 `TenantDbResolver.dbForTenant(tenantId)` 路由到正确 shard；跨租户聚合经 `allShardDbs()` fan-out；平台表经 `coordinatorDb()`；然后放开 fail-closed，用真 2-shard PG 验收「两租户落不同 shard、各自读写不串、default 落 home shard、metrics 汇总正确」。

## 2. 关键发现（改变风险判断——核验真实代码）

**已就位的地基（局部低风险）**：
- **计量子服务已 shard-ready**（PR #314 双入口化）：`TokenBudget/CostTracker/UsageTracker/QuotaManager/BillingOutbox` 的 `fromResolver(resolver)` 内部是 `{ forTenant: (t) => resolver.dbForTenant(t) }`——**运行时按 tenantId 解析 db**（`token-budget.ts:59` 实证）。它们唯一问题是被喂 `new SingleDbResolver(sharedDb)`，而非共享 `ShardRouter`。**但这只是 5 个子服务，不能外推到「所有长期服务已就位」。**
- **`TenantOSFactory` 主路由点已 resolver 化**：`getTenantOS` 走 `new TenantDatabase(this.resolver.dbForTenant(tenantId), tenantId)`（`tenant-os-factory.ts:111`）。
- **`ShardRouter` 引擎完整**（`shard-router.ts`）：per-connStr 缓存、幂等 close、init 失败回收、`default→homeShardId`、`allShardDbs()` 去重。

**⚠️ 修正（Codex 独立复审 58/100 退回，核验真实代码确认——初版「低风险 7 文件」判断被推翻）**：Phase 0 **仍是高风险的组合根/生命周期重构**，不能降级为「穿 resolver + 改 7 个 sharedDb 文件」。file 级 ratchet **不是完整性 oracle**（inventory 自己承认 `db-access-inventory.ts:8-12`：只挡文件级新增拿点，**不覆盖构造器注入的 db sink**）。核验发现三类被 file 级 ratchet/inventory 漏掉或错分类的**构造期固定-host-db sink**，多 shard 下全部错-shard（致命）：
1. **`buildAppServices`（`app-services.ts:1`）用启动期 host db 构造 ~15 个长期服务**（Identity/Avatar/Collaboration/MobileDevice/UserProfile/Organization/TenantProfile/SCIM/AdminControlPlane/ApiKey/Config/KnowledgeSource），被 per-tenant route 长期复用却钉死 host db。inventory 把它错分类为 `explicit-per-request`「接收已解析 db」（`db-access-inventory.ts:69`）——实际传的是启动期 host db，此分类错误掩盖一整组 sink。
2. **`TaskQueue`（`task-queue.ts:75`）构造期固定 db**，`enqueue(tenantId,...)` 把任意租户写该固定库，dequeue/complete 按 taskId 操作——**不能靠 enqueue 时 dbForTenant 修好**（worker 必须知道 taskId 在哪 shard）。inventory 唯一 `global-worker` 条目是 metrics route，`TaskQueue` 无独立条目。同款还有 `AvatarAutorunStore`/`KnowledgeSourceStore`/`AvatarService`（`app.ts:399-401` 注入 queueDb）。
3. **`LegalHoldService`（`legal-hold-service.ts:82`）构造期裸 IDatabase** + `WHERE tenant_id=?`（`:177`），经 `PrivacyService.eraseData`（`privacy-service.ts:505`）注入 root db——多 shard 下 legal hold 在租户 shard、erase 到 home shard 查不到 → **不只数据分裂，是功能语义反转（错误擦除/漏挡擦除）**。inventory 登记了 privacy-service root capture 但没把 legal-hold-service 作为 sink 登记。

**故真实工作量 = 5 计量子服务（易）+ 7 个 route `sharedDb` 文件（中）+ 组合根 ~15 个 buildAppServices 长期服务 + TaskQueue/worker shard 归属设计 + LegalHold 等间接 sink（重）**。**前置 = 把 inventory 从 file 级升级为 constructor-injected sink 级盘点**（见 §3 A0），否则「无未接线拿点」无法证明、放开 fail-closed 就是带漏洞放开。

## 3. 三块范围（A / B / C）

### A0. 前置：sink 级盘点（Codex 退回核心——放开前必须完成）

file 级 ratchet 挡不住构造器注入 sink。**先把 inventory 从 file 级升级为 constructor-injected DB-sink 级盘点**，再动接线——否则「无遗漏」不可证。

- **新增 sink 级契约**：枚举每个「构造期接 `IDatabase`/`SyncWriteUnitOfWork` 且内部跑 `WHERE tenant_id=?`（或按 tenantId 语义读写）的类」——不只 `os.getDatabase()`/`sharedDb` 文本，而是**数据流 source→sink**。至少覆盖：`buildAppServices` 的全 ~15 成员（逐个定性：真 per-request 无状态？还是长期 host-db sink？）、`TaskQueue` 及 `app.ts:399-401` 注入 queueDb 的 store、`LegalHoldService` 及经 PrivacyService 注入 root db 的间接 sink。
- **升级 ratchet**：`check-db-access-ratchet.mjs` 从「文件是否在 inventory」加一条断言——inventory 每个 `tenant-isolated`/`longlived-root-capture` sink 标注其 db 来源（resolver / coordinator / 已下沉），且新增未标注 sink → 红。（AST 级完整覆盖是后续；本 Phase 至少把三类已知 sink 纳入显式清单 + 逐项验收。）
- **产物**：更新后的 `db-access-inventory.ts`（sink 级，纠正 `buildAppServices` 错分类）+ 每个 sink 的处置结论（resolver 化 / coordinator / per-shard worker / known-limitation）。**这是 Plan 1 的第一步，不是文档，是可执行清单 + ratchet 加固。**

### A. 注入链统一：一个 resolver 穿全链

**组合根 `app.ts` 建唯一 `TenantDbResolver`**（按 config 分单/多库）：

```typescript
// app.ts（装配处，约 line 294-300 附近）
const hostDb = deps.db ?? deps.os.getDatabase();
// 单库（现状 / 测试）：SingleDbResolver(hostDb)——零回归。
// 多库（config.db.shards 非空）：ShardRouter，home shard 显式 seed = host os 的 db（见 §4 可执行契约）。
const resolver: TenantDbResolver = buildResolver(config, hostDb, deps.os);
```

- `buildResolver`（新，`src/storage/build-resolver.ts`）：
  - `config.db.shards` 空 → `new SingleDbResolver(hostDb)`（等价现状）。
  - 非空 → `new ShardRouter({...})`，且**通过可执行契约保证 home shard db === hostDb 同一实例**（见 §4——不是 connStr 字符串比较，是显式 seed 或 buildDb 对 home connStr 返回 hostDb）。
- 这**一个** `resolver` 实例穿进：`new TenantOSFactory(resolver, ...)` + 每个 `registerXxxRoutes(app, os, config, db?, tenantFactory?, resolver)`（route 签名加 `resolver` 可选参，缺省 `new SingleDbResolver(os.getDatabase())` 保测试/直调兼容）+ **`buildAppServices` 改接 `resolver` 而非裸 db**（其长期服务按成员定性 A0 结论各自 resolver 化 / coordinator 化）。
- **替换所有 `new SingleDbResolver(sharedDb)` 局部构造**（decisions/onboarding/chat/perceive/perceive-stream/learn-github 等 7+ 处）为传入的共享 `resolver`。子服务 `fromResolver(config, resolver)` 从此按 tenantId 路由。

> 注：route 已有 `db?`/`tenantFactory?` 可选参惯例（app.ts 装配时穿）；`resolver` 同款加为可选参，缺省 `new SingleDbResolver(os.getDatabase())`（保测试/直调兼容），app.ts 装配时穿真 resolver。

### B. inventory 各类接线到正确入口

按 `db-access-inventory.ts` 的 8 类逐类接线（ratchet 是完整性 oracle）：

| 类 | 数量 | 接线到 | 具体动作 |
|---|---|---|---|
| `tenant-isolated` | 7 | `dbForTenant` | 多经 TenantOSFactory 已路由；route 内 `new XxxStore(sharedDb, tenantId)` → `new XxxStore(resolver.dbForTenant(tenantId), tenantId)` |
| `longlived-root-capture` | 13 | `dbForTenant`（子服务）+ route 内直用改 resolver | A 段穿 resolver 覆盖子服务；route 内 `sharedDb.prepare(...WHERE tenant_id=?)`（decisions/onboarding subscriptions/BYOK 读）→ `resolver.dbForTenant(tenantId).prepare(...)` |
| `explicit-per-request` | 6 | `dbForTenant` | handler 内一次性取 db，换源 |
| `platform-table` | 1 | `coordinatorDb` | 无 tenant_id 全局表 → 协调库 |
| `root-only` | 5 | `coordinatorDb` | 确无租户归属 → 协调库 |
| `global-worker` | 1（inventory 现有）+ **TaskQueue（新增）** | `allShardDbs` per-shard 或 coordinator | 见下「TaskQueue shard 归属」——不能靠 enqueue dbForTenant 修好 |
| `module-singleton` | 1 | 单列评估 | 模块级单例 db 引用——评估是否可 resolver 化，不能则 known-limitation |
| **buildAppServices 长期服务（A0 纠正错分类）** | ~15 | 逐成员定性 | 见下 |
| **构造器注入间接 sink（A0 新增）** | LegalHold 等 | dbForTenant 下沉 | 见下 |

**具名验收点**：
- `buildAppServices` ~15 成员（`app-services.ts:1`）**逐个定性**：无状态 per-request（改成方法接 `dbForTenant(tenantId)`）vs 长期 sink（构造改接 resolver，内部 per-tenant 解析）。Identity/Avatar/Collaboration/MobileDevice/UserProfile/Organization/TenantProfile/SCIM/AdminControlPlane/ApiKey/Config/KnowledgeSource 都要各自定性 + 验收，**不是一句「接收已解析 db」带过**（那是 inventory 错分类）。
- **`TaskQueue`（`task-queue.ts:75`）shard 归属设计（架构决策，非机械改）**：`enqueue(tenantId)` 写固定库、dequeue/complete 按 taskId——多 shard 下 worker 必须知道 taskId 在哪 shard。三选一（Plan 里定并测）：① **每 shard 一个 queue + 每 shard 一个 worker**（enqueue → `dbForTenant(tenantId)`，worker 遍历 `allShardDbs` 各拉各的；最自然，任务天然随租户 shard）；② 协调库统一队列（所有 shard 共用一队列，payload 带 tenantId，执行时 `dbForTenant`）；③ taskId→shard 定位表。**推荐 ①**（任务本就属某租户，随其 shard 最一致）。同款 `AvatarAutorunStore`/`KnowledgeSourceStore`/`AvatarService`（`app.ts:399-401`）随此决策定性。
- **`LegalHoldService`（`legal-hold-service.ts:82`）+ PrivacyService 间接 sink**：构造改接 `resolver`（或 `eraseData`/`exportData` 内 `resolver.dbForTenant(tenantId)` 建 LegalHoldService）——多 shard 下 legal hold 与 erase 必须查**同一** shard，否则功能语义反转（错误擦除）。**2-shard 集成测试专门验**：租户在 shard-1 放 legal hold → eraseData 该租户 → 断言 hold 真拦住（不是因错-shard 查不到 hold 而误擦）。
- `memory-facade.ts:221`：绕 TenantDatabase 的 id-based `UPDATE memory_nodes` → `resolver.dbForTenant(tenantId)`（仍 id-based 绕 WHERE-rewrite，但落对 shard）。
- `metrics.ts:43`：`new MetricsQueryService(os.getDatabase())` 跨租户读 → §5 fan-out。

### C. 放开 fail-closed + 真 2-shard 验收

- **放开门槛（收紧——Codex 退回）**：不是「7 文件 + ratchet 绿」。必须：① A0 sink 级盘点完成，`buildAppServices` 全成员、TaskQueue/worker、LegalHold 等间接 sink **逐项有处置结论且已下沉**；② sink 级 ratchet 绿（每 sink 标注 db 来源，无未标注）；③ 真 2-shard 集成测试全过（含 legal-hold 语义反转专项、TaskQueue per-shard）；④ default=home 同实例契约测试过。**任一未完成 → 保持 fail-closed 不放开**（约束 1：宁可不放开也不带漏洞放开）。
- **createDatabase 与 resolver 建立的边界**：`createDatabase` 仍只建**单个 host db**（home shard 的物理库 + 跑迁移）；多 shard 的其余 shard 由 `ShardRouter.buildDb` + `initialize()` 建+迁移。guard 从「拒非空 shards」改为「非空 shards 时要求 app.ts 已装配 ShardRouter」——即把运行时约束从 createDatabase 上移到组合根装配完整性。
- 真 2-shard PG 验收（集成测试，见 §7）。

## 4. default 租户不变量（关键，采纳「host os 即 home shard」）

现状 23 处 `getOS()`：`if (tid !== 'default') return factory.getTenantOS(tid); return os;`——default 返回裸 host `os`（绑 host db），其他租户走 factory。

**不改这 23 处热路径**。而是在组合根钉死不变量：**host `deps.os` 的 db 与 `ShardRouter` 的 home shard db 是同一个 `IDatabase` 实例**（`ShardRouter.dbForTenant('default')` 已钉 `homeShardId`）。

**⚠️ 可执行契约（采纳 Codex #4——connStr 字符串相同 ≠ 同实例）**：`ShardRouter` 的 per-connStr 缓存只去重**它自己 `buildDb` 建的**实例；hostDb 在 router 外由 `createDatabase` 建，即使 home connStr 字符串相同，router 空缓存仍会 `buildDb` 建**第二个**实例（两个池指同库=竞态/双 close）。且 `deps.db` 可绕过 `createDatabase`（`app.ts:294`），config connStr 比较也证明不了注入的 db 对应该 DSN。故不变量必须是**注入式而非比较式**：
- **`ShardRouter` 加 `seedDbs?: Record<connStr, IDatabase>` 构造参**（或 `homeDb: IDatabase`）：`buildResolver` 把已建的 `hostDb` 显式 seed 进 router 的 `byConnStr`（键 = home shard connStr），使 `dbForTenant('default')`/home shard 命中缓存直接返 hostDb **同一实例**——不再另建。
- **关闭 ownership 显式化**：hostDb 由谁 close（os vs router）单点定；seed 进来的 db 标记为「外部拥有，router 不 close」，避免双 close。
- **多 shard 下拒绝无法验证 identity 的 `deps.db` 注入**：`shards` 非空 + 传了 `deps.db` 但无法确认它就是 home shard db → 启动拒（fail-closed）。

如此 default（裸 os）与 factory（`resolver.dbForTenant('default')`）两路径**证实指向同一实例**，无需碰 23 处热路径。

## 5. 跨租户 fan-out（metrics + global-worker）

分片后单 shard 只见本 shard 租户，跨租户聚合静默错。改 scatter-gather：

- `MetricsQueryService` 从 `new MetricsQueryService(os.getDatabase())` 改为接 `resolver.allShardDbs()`——对每个 shard db 各查一遍，**协调层合并**：
  - population diversity（跨租户 `decision_style` 群体统计）：各 shard 收集 decision_style 行 → 合并后算多样性（不是各 shard 算完再平均——那口径错）。**⚠️ O(n²) 边界（Codex #4）**：`personality-diversity.ts:70` 生成全部两两距离，fan-out 后合并 n 仍是全平台租户数 → 时间/内存 O(n²)。本 Phase 定：**保留现有 population 上限语义 + 若合并后行数超阈值则采样**（阈值/采样在 Task 定义并测），不无界全量拉。
  - rollup SUM / tenant usage COUNT：各 shard SUM/COUNT → 相加。**`getTenantUsage` 现有 `limit=200`（`metrics-query-service.ts:116`）**：各 shard 独立 limit 后拼接 ≠ 全局 top-200 → 须**全局排序 merge 后截断**（各 shard 拉 top-200 → 合并排序 → 取全局 200），Task 定义并测。
- `global-worker` + `TaskQueue`（见 §3-B TaskQueue 归属决策）：改 per-shard 各跑一遍（`for (const db of resolver.allShardDbs())`）。
- **单库下 `allShardDbs()` 返 `[db]`**，fan-out 退化为单库查询，零回归。

## 6. 配置契约（`config/schema.ts`——已存在，纠正 spec 与真实形状不一致）

**真实 schema（`schema.ts:22-24`，非 spec 初版写的 flat `Record<shardId, connStr>`）**：
```typescript
shards: z.record(z.string(), z.object({ connectionString: z.string() })).optional(),   // Record<shardId, {connectionString}>
coordinator: z.object({ connectionString: z.string() }).optional(),
homeShardId: z.string().optional(),
```
而 `ShardRouterConfig.shards` 是 flat `Record<shardId, string>`（`shard-router.ts:18`）。**`buildResolver` 负责把 config 的 `{connectionString}` 形状映射为 ShardRouter 的 flat-string 形状** + 从 `coordinator.connectionString` 取 `coordinatorConnStr` + 从 `homeShardId` 取 home。
- **校验**（schema refine 或 buildResolver 启动校验，给清晰错误）：`shards` 非空时 `homeShardId` 必填且 ∈ shards；`homeShardId` 缺 → 启动拒。
- **default=home 同实例不用 connStr 比较**（§4：改注入式 seed，不是校验 connStr 相等）。
- 单库（`shards` 空）：现有 `db.connectionString`/`db.path` 路径不变。

## 7. 可验证性（真 2-shard 验收是核心）

- **2-shard 隔离（集成，真 PG 或 2 个内存 sqlite 模拟 shard）**：config 配 2 shard，租户 A 哈希落 shard-0、租户 B 落 shard-1（构造已知落点的 tenantId）→ A 写记忆 → 断言 shard-1 库查不到 A 的记忆、shard-0 查得到；B 反之。**跨 shard 不串**。
- **default 落 home shard**：default 写数据 → 断言落 home shard db（= host db），非其他 shard。
- **子服务 per-tenant 路由**：TokenBudget/QuotaManager 对 A、B 各计量 → 断言各自落各自 shard（不串账）。
- **fan-out 正确**：A 在 shard-0、B 在 shard-1 各有 decision_style → metrics population diversity 断言 = 2（跨 shard 合并），非各 shard 看到的 1。
- **单库零回归**：`shards` 空时全链行为与现状 `assert.deepEqual` 等价（SingleDbResolver 路径）——**现有全套测试仍绿**是硬门。
- **legal-hold 语义反转专项（关键，Codex #4）**：租户在 shard-1 放 legal hold → `eraseData` 该租户 → 断言 hold **真拦住**擦除（回归形态：错-shard 查不到 hold → 误擦；此测试须在「LegalHold 未接 resolver」的变异下变红）。
- **TaskQueue per-shard**：租户 A（shard-0）/B（shard-1）各 enqueue → 断言各自任务落各自 shard，worker 遍历 allShardDbs 都能取到、不串。
- **sink 级 ratchet 完整性**：`check-db-access-ratchet.mjs` 绿——每个 sink 标注 db 来源（resolver/coordinator/已下沉），新增未标注 sink → 红（升级后的 sink 级断言，非 file 级）。
- **default=home 同实例**：断言 `resolver.dbForTenant('default')` 与 host `os.getDatabase()` 是**同一实例引用**（`===`），非 connStr 相等。
- **单库零回归**：`shards` 空时全链行为与现状 `assert.deepEqual` 等价——**现有全套测试仍绿**是硬门。
- **fail-closed 放开后仍守**：`shards` 非空但装配不完整（未 seed home db / sink 未全下沉）→ 仍拒启动。

## 8. 全局约束（每个实现任务隐含遵守）

1. **隔离铁律不可破**：任一 per-tenant 访问漏接 resolver = 静默错-shard 数据分裂。ratchet + 2-shard 集成测试是双重网。**宁可 fail-closed 不放开，也不带漏接线放开**。
2. **单库零回归**：`shards` 空时全链等价现状，现有全测试绿是硬门（SingleDbResolver 三方法返同一 db）。
3. **default = home shard 不变量（注入式，非比较式）**：组合根把 host db **显式 seed** 进 ShardRouter 使 home shard 命中同一实例（§4）；测试断言 `===` 同实例，不靠 connStr 字符串相等。
4. **fan-out 口径正确**：跨租户聚合的合并语义（diversity 合并行后算、SUM/COUNT 相加）在 Task 定义并测——不是各 shard 算完平均。
5. **无分布式事务**：已核实无跨租户单事务写（总览确认），fan-out 只读、worker per-shard——不引入 2PC。
6. **中文注释**（项目规范）；改动经 `test:golden` 全门（含 ratchet + parity + route-schema 快照）。
7. **迁移在每 shard 跑**：`ShardRouter.buildDb` 建 shard db 时跑同款 DSL 迁移（每 shard 独立 `schema_migrations`）——不新增迁移，复用现有迁移在多库各跑一遍。

## 9. 分片（供 writing-plans——比初版大，诚实分 4 plan）

- **Plan 0（A0 sink 级盘点，前置）**：升级 `db-access-inventory.ts` 到 constructor-injected sink 级（纠正 `buildAppServices` 错分类，逐个成员定性）+ 登记 TaskQueue/AvatarAutorunStore/KnowledgeSourceStore/LegalHoldService 等 sink + 每 sink 处置结论 + 升级 ratchet 到 sink 级断言。**纯盘点 + ratchet，不改运行逻辑**。是后续放开的完整性前提。
- **Plan 1（A 注入链统一）**：`buildResolver`（config `{connectionString}` 形状 → ShardRouter flat + seed hostDb 同实例）+ app.ts 装配唯一 resolver + route 签名加 `resolver` 参 + 替换 7 处 `new SingleDbResolver(sharedDb)` + **`buildAppServices` 改接 resolver（长期服务成员按 Plan 0 定性各自 resolver/coordinator 化）** + 计量子服务经 resolver。fail-closed 仍挡，单库零回归 + default=home 同实例断言。
- **Plan 2（B route 内直用 + 间接 sink + fan-out）**：7 个 `sharedDb` 文件 route 内直用 → `dbForTenant`（含 memory-facade:221）；**LegalHoldService 经 resolver 下沉（+ 语义反转专项测试）**；metrics fan-out（population diversity 采样边界 + tenant usage 全局 top-200 merge）；global-worker per-shard。仍 fail-closed 挡。
- **Plan 3（TaskQueue shard 归属 + C 放开 + 2-shard 验收）**：TaskQueue 按 §3-B 决策（推荐每 shard 一队列+worker）+ 同款 store；config schema 校验；fail-closed guard 上移到装配完整性（seed 完整 + sink 全下沉才放开）；真 2-shard 集成测试全套（隔离/default 同实例/子服务/fan-out/legal-hold 语义/TaskQueue per-shard）；放开生产多库。

## 10. 非目标（YAGNI）

- 不做租户搬迁（rebalance/迁移到新 shard）——那是 Phase 1（总览里的 GDPR-import 去脱敏复用）；本 Phase 只做「新租户按哈希落 shard + 各 shard 内正确读写」。
- 不做协调库独立部署——`coordinatorDb` 单库下 = host db，多库下可 = home shard 或独立库（config 决定），本 Phase 不强制独立协调库。
- 不做 **AST 级**自动 source/sink 追踪——本 Phase 把 ratchet 从 file 级升到**显式 sink 级清单 + 逐项断言**（Plan 0），三类已知构造器注入 sink 纳入；全自动 AST 追踪是后续增强。
- 不改 default 租户的 23 处热路径（§4 靠不变量而非改路径）。
- 不引入分布式事务（§8.5）。
