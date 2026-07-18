# PersonaTemplateService 双入口化设计

> **状态**：设计已定（Codex 86→采纳 3 收紧+2 文案），待 writing-plans。
> **归属**：#3 租户分片 Phase 0 —— persona 块**第二片**（依赖第一片 PersonaCoreService 已双入口化，PR #314）。
> **前置**：PersonaCoreService 双入口（Task 1-5 完成）；`TenantDbResolver`/`SingleDbResolver`/`FakeMultiShardResolver` 就位。

## 背景与问题

PersonaTemplateService（`src/enterprise/persona-template-service.ts`）管理 persona 模板：CRUD（list/get/create/update/delete）+ `syncBuiltins`（启动期刷内置模板）+ `instantiate`（从模板建 persona）。构造 `(tx: SyncWriteUnitOfWork, personaCoreService: PersonaCoreService)`——**级联依赖已双入口化的 PersonaCoreService**。3 生产构造点全裸 root db。

**比 persona 块第一片（PersonaCoreService）轻一个量级**（已核实）：单类、无 4 子服务级联、CRUD 全单条写（无跨子服务事务）。

## 本片范围

**只做**：PersonaTemplateService 双入口化 + syncBuiltins fan-out + instantiate 级联协调 + 3 构造点迁移 + 探针。

**不做**：app.ts 穿真 ShardRouter；default 路径统一。

## 核心机制（3 种方法形态）

### CRUD（per-tenant）——最简
`list`/`get`/`create`/`update`/`delete` 全 per-tenant（首参 tenantId），用 `this.tx`。改造：入口 `const db = this.source.forTenant(tenantId); db.execute/queryOne/queryMany(...)`。
- `list`/`get`/`create`：单条 execute/query，无需事务。
- **`update`/`delete` 是「先 get 读 + 再 execute 写」（已核实，非单条）**：Codex 采纳纠正——有既有 TOCTOU 窗口（读校验 isBuiltIn 与写非同事务）。**保持既有非原子语义（零回归不加事务）**；但双入口化须保证 get（读）与 execute（写）**用同一 db**（入口 `const db=source.forTenant(tenantId)` 解析一次，get 和 execute 都用它——同 tenantId 同 db，不裂脑）。改造要点：`update`/`delete` 入口解析一次 db，内部 `this.get` 也走该 db（避免 get 用一个 db、execute 用另一个）。
> list/get 的 SQL 是单-SQL `WHERE tenant_id=? OR tenant_id='__builtin__'`（读本租户 + 内置哨兵）——这要求内置模板与租户模板**在同一 shard**（见 syncBuiltins fan-out）。

### syncBuiltins（cross-tenant fan-out，每 shard 一份——用户裁决的架构决策）
`syncBuiltins` 无 tenantId，循环 upsert `BUILTIN_TEMPLATE_SEEDS`（`BUILTIN_TENANT_ID='__builtin__'` 哨兵）。

**架构决策（设计文档遗漏，用户采纳）：内置模板每 shard 一份**。因 list/get 单-SQL `WHERE tenant_id=? OR tenant_id='__builtin__'` 在单个 db 连接读两个命名空间——多库下若内置只在协调库，租户 shard 上那条 `OR '__builtin__'` 查不到（跨库 OR 做不到）。故 syncBuiltins 遍历 `allShardDbs()` **每 shard 刷全部内置 seed**（upsert 幂等，升级时 fan-out 重刷所有 shard）。协调库单份方案被否（要改 list/get 为应用层跨库合并，改动/风险大）。

**失败策略（用户裁决：逐 shard 尝试 + 任一失败则抛）**：syncBuiltins 是**启动期一次性 seed**（非周期 worker）——某 shard 缺内置模板=该 shard 租户功能缺损。遍历所有 shard 都尝试（别因第一个失败漏后面），聚合 errors（含**可定位 shard 身份 + 根因**）；**若任一 shard 失败则最终抛**（启动期须显式知道，非静默隔离）。与 recoverTimedOut/BillingOutbox 的运行时逐 shard 隔离**有意区分**：那些是周期运行时（隔离让健康 shard 继续），syncBuiltins 是启动 seed（全成功或报错）。

**部署可用性决策（Codex 采纳——明确「启动硬失败」的运维语义）**：多 shard 下 `syncBuiltins()` 抛错会在 app/路由组装期**阻止整个服务启动**（一个 shard 暂时不可达=整个服务起不来）。这是 correctness-first 的有意取舍（避免部分租户在缺 builtin 状态对外服务），但须配套：部署层**自动重试**（启动失败重启 pod）、**告警定位**（错误含 shard 身份）、**启动超时预算**、恢复流程文档。**升级半成功可重跑收敛**（upsert 幂等：第一次部分成功抛出后，已刷 shard 是新版、未刷是老版；故障恢复后重跑 syncBuiltins→全 shard 收敛到新版）。**已知限制**：upsert 不删——若未来**删除**某 builtin seed，单纯 upsert 无法清除各 shard 旧模板（需另行设计清理，非本片范围，登记）。

**两个 syncBuiltins 启动调用点**（app.ts:446 + admin-templates.ts:37，已核实）：真 resolver 接线后两处都会 fan-out（重复刷但幂等，无正确性问题；本片单库下等价现状）。

### instantiate（级联，与 PersonaCoreService 协调）
`instantiate` 三段（已核实，**无外层事务包裹**）：
1. `this.get(tenantId, templateId)` 读模板（this.tx）
2. `this.personaCoreService.createPersona({tenantId,...})` 建 persona（PersonaCoreService 的 source，已双入口）
3. `recordBusinessAuditLog(this.tx, ...)` 写审计（this.tx）

**非原子=既有语义（零回归不修）**：三段无 `tx.transaction` 包裹，createPersona 成功但 audit 失败会留无审计的 persona——本就如此，本片不改（同 PersonaCoreService 片的 D6-D8 既有缺口处理原则）。

**级联协调（不裂脑，关键）**：改造后入口 `const db = this.source.forTenant(input.tenantId)` 用于 get 模板 + audit。createPersona 委托 `this.personaCoreService`——**PersonaTemplateService 与它持有的 PersonaCoreService 共享同一 resolver**。instantiate 里 `this.source.forTenant(tenantId)`（模板/audit）与 createPersona 内部 `personaCoreService.source.forTenant(同tenantId)`（persona）**独立解析但同 resolver + 同 tenantId → dbForTenant 确定性 → 同 db 实例 → 落同一 shard**。非原子但不裂脑（模板/persona/audit 同 shard）。

## 签名变更：双入口

```
interface TemplateSource { forTenant(tenantId: string): SyncWriteUnitOfWork; allDbs(): SyncWriteUnitOfWork[]; }
class PersonaTemplateService {
  private constructor(private readonly source: TemplateSource, private readonly personaCoreService: PersonaCoreService) { registerCoreSelfExecutors(); }
  static fromResolver(resolver: TenantDbResolver, personaCoreService: PersonaCoreService): PersonaTemplateService { ... }
  static fromUnitOfWork(tx: SyncWriteUnitOfWork, personaCoreService: PersonaCoreService): PersonaTemplateService { ... }
}
```
- `fromResolver`：`forTenant: (t) => resolver.dbForTenant(t)`、`allDbs: () => resolver.allShardDbs()`。
- `fromUnitOfWork`：`forTenant: () => tx`、`allDbs: () => [tx]`。
- personaCoreService 仍构造注入（调用点先建 PersonaCoreService.fromResolver(r) 再建 PersonaTemplateService.fromResolver(r, thatCore)——**传同一 r**）。

## 构造点迁移（无别名，按声明类型 + typecheck 兜底）

**2 生产 + 1 测试构造点**（已核实无别名；Codex 采纳纠正「3 生产」为 2 生产+1 测试）：
- 生产（2）`fromResolver(sharedResolver, personaCoreService)`：`app.ts:445`（bulkImport）、`admin-templates.ts:34`。
- 测试（1）`fromUnitOfWork(db, personaCoreService)`：`persona-template-service.test.ts:32`。

**强制组合装配协议（Codex 采纳——同 resolver 从「调用纪律」升级为难误用协议）**：两处生产构造点必须**先建一个 resolver 变量、再依次建 core + template 传同一变量**，禁止两边分别内联 `new SingleDbResolver(...)`：
```
const resolver = new SingleDbResolver(tx);          // 单一 resolver 变量
const core = PersonaCoreService.fromResolver(resolver, ...);
const templates = PersonaTemplateService.fromResolver(resolver, core);  // 传【同一】resolver + 该 core
```
理由：两个 SingleDbResolver 只有包同一 tx 才安全；**两个真 ShardRouter 即使配置相同也不共享连接池实例缓存**（各自 buildDb 出不同 db 实例）→ instantiate 里 template 和 core 会落不同 db 实例（虽同 connStr 但不同连接）→ 破坏「同一 db 引用」。故必须传**同一 resolver 实例**。plan 阶段核实两生产点都遵此协议。
方法调用方（admin-templates 的 syncBuiltins/list/get/instantiate）**不改**（实例已 fromResolver，方法自动生效）。

## 验收探针（FakeMultiShardResolver）

`src/test/unit/persona-template-service-sharding.test.ts`：

1. **CRUD per-tenant 分流对称**：tA→shard1、tB→shard2；各 `create`；断言 shard1 的 persona_templates 查得 tA 模板、查不到 tB，shard2 反之（对称）。
2. **syncBuiltins 每 shard 一份（核心）**：两 shard 的 resolver；`syncBuiltins()`；断言**两个 shard 的 persona_templates 都有全部 BUILTIN_TENANT_ID 模板**；再 `list(tA)`（tA→shard1）+ `list(tB)`（tB→shard2）各能查到内置模板（证每 shard 都有内置，单-SQL OR 查询成立）。
3. **instantiate 级联同 shard（核心，证 template/core resolver 一致）**：PersonaTemplateService.fromResolver(r, PersonaCoreService.fromResolver(**同 r**))；`instantiate({tenantId: tA, templateId, ...})`（tA→shard1）；断言 shard1 有：模板（get 读到）+ 新建 persona_core 行 + audit_log 行——**全落 shard1 同一 shard**（证 template.source 和 core.source 解析一致）。**变异**：若 PersonaTemplateService 用与 PersonaCoreService **不同**的 resolver（或 template 落 shard1、core 落别处）→ persona 行落错 shard → 此探针红。
4. **syncBuiltins 任一 shard 失败则抛（坏 shard 居中）**：三 shard，**中间**一个 throwingDb；`syncBuiltins()`；断言**整体抛**（非静默隔离）+ **前后健康 shard 都被尝试**（坏 shard 前的已刷、遍历未因居中失败就停）+ 聚合 errors 含可定位 shard 身份。
5. **syncBuiltins 升级半成功→重跑收敛（Codex 采纳）**：先一 shard throwingDb 致 `syncBuiltins()` 抛（部分 shard 已刷）；换掉坏 shard 为正常 db（模拟恢复）；**重跑 `syncBuiltins()`**；断言不抛 + **全 shard 内置模板一致**（upsert 幂等收敛）。
6. **UoW 模式**：fromUnitOfWork(db, core)；CRUD + instantiate 落该 db。
7. **单库零回归**：fromResolver(new SingleDbResolver(db), core)；CRUD/syncBuiltins/instantiate 行为与改造前等价。
8. **update/delete TOCTOU 既有语义回归**：update/delete 的 get（读）+ execute（写）落**同一 db**（同 tenantId 解析一次）；断言行为与改造前等价（既有非原子窗口保留，不裂脑）。

**变异证明**：instantiate 探针 3 用**与 PersonaCoreService 不同的 resolver** 构造 PersonaTemplateService（违反组合装配协议）→ 重跑 → persona 落 core 的 shard、模板/audit 落 template 的 shard → 探针 3「全落同一 shard」变红。证组合装配协议的必要性被测。

## 红线（不变量）

1. **零回归**：单库（SingleDbResolver）+ UoW 模式 db 副作用逐字等价现状（含 instantiate 非原子=既有语义，不趁机加外层事务）；全量 unit fail=0。
2. **CRUD 经 forTenant**（单条写无需事务）；**syncBuiltins 经 allDbs fan-out**（每 shard 一份）；**instantiate 的模板/audit 经 forTenant**、persona 委托 personaCoreService。
3. **级联同 resolver（强制组合装配）**：两生产构造点先建单一 resolver 变量、再传给 core + template（禁两边分别 new resolver）——两个真 ShardRouter 不共享连接池缓存会落不同 db 实例。update/delete 的 get+execute 也用同一入口解析的 db。
4. **syncBuiltins 失败则抛 + 部署可用性**：逐 shard 尝试聚合 errors（含 shard 身份），任一失败最终抛（启动 seed 语义）；启动硬失败须配部署自动重试/告警；升级半成功靠 upsert 幂等重跑收敛。**已知限制**：删 builtin seed 单纯 upsert 不清旧（后续另设计，登记）。
5. **UoW 模式 forTenant 忽略 tenantId 恒返 tx**。
6. **内置模板每 shard 一份**：不改 list/get 单-SQL `OR '__builtin__'` 查询模型。
7. **无适配层**（IDatabase extends SyncWriteUnitOfWork）。
8. **inventory**：personas/admin-templates 的 longlived-root-capture 条目核验（PersonaTemplateService 改双入口后是否仍命中 ratchet，条目保留）；`check:db-access` 通过。
9. **构造点分类以声明类型为准**；无别名但仍 typecheck 兜底。

## 验收标准

- `npm run typecheck` exit 0；`npm run build` 成功。
- 探针全绿（6 类，尤其 syncBuiltins 每 shard 一份 + instantiate 级联同 shard）+ 变异（template/core 不同 resolver→级联落错 shard 红）。
- 全量 unit fail=0。
- `npm run check:db-access` exit 0。
- 交叉审查（生成者≠审查者）：Codex 审 spec（重点：syncBuiltins fan-out 每 shard 一份的正确性 + 升级同步语义、instantiate 级联同 resolver 不裂脑的保证、syncBuiltins 失败则抛 vs 隔离的取舍、CRUD 无事务是否真安全）。
