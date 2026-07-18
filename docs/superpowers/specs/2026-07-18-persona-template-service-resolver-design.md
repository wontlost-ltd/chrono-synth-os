# PersonaTemplateService 双入口化设计

> **状态**：设计已定，待 Codex 交叉审查 → writing-plans。
> **归属**：#3 租户分片 Phase 0 —— persona 块**第二片**（依赖第一片 PersonaCoreService 已双入口化，PR #314）。
> **前置**：PersonaCoreService 双入口（Task 1-5 完成）；`TenantDbResolver`/`SingleDbResolver`/`FakeMultiShardResolver` 就位。

## 背景与问题

PersonaTemplateService（`src/enterprise/persona-template-service.ts`）管理 persona 模板：CRUD（list/get/create/update/delete）+ `syncBuiltins`（启动期刷内置模板）+ `instantiate`（从模板建 persona）。构造 `(tx: SyncWriteUnitOfWork, personaCoreService: PersonaCoreService)`——**级联依赖已双入口化的 PersonaCoreService**。3 生产构造点全裸 root db。

**比 persona 块第一片（PersonaCoreService）轻一个量级**（已核实）：单类、无 4 子服务级联、CRUD 全单条写（无跨子服务事务）。

## 本片范围

**只做**：PersonaTemplateService 双入口化 + syncBuiltins fan-out + instantiate 级联协调 + 3 构造点迁移 + 探针。

**不做**：app.ts 穿真 ShardRouter；default 路径统一。

## 核心机制（3 种方法形态）

### CRUD（per-tenant 单条写/读）——最简
`list`/`get`/`create`/`update`/`delete` 全 per-tenant（首参 tenantId），全用 `this.tx` 单条 execute/queryOne/queryMany。改造：入口 `const db = this.source.forTenant(tenantId); db.execute/queryOne/queryMany(...)`。**无需事务**（单条写原子）——比 PersonaCoreService 简单，无 InTx primitive 复杂度。
> list/get 的 SQL 是单-SQL `WHERE tenant_id=? OR tenant_id='__builtin__'`（读本租户 + 内置哨兵）——这要求内置模板与租户模板**在同一 shard**（见 syncBuiltins fan-out）。

### syncBuiltins（cross-tenant fan-out，每 shard 一份——用户裁决的架构决策）
`syncBuiltins` 无 tenantId，循环 upsert `BUILTIN_TEMPLATE_SEEDS`（`BUILTIN_TENANT_ID='__builtin__'` 哨兵）。

**架构决策（设计文档遗漏，用户采纳）：内置模板每 shard 一份**。因 list/get 单-SQL `WHERE tenant_id=? OR tenant_id='__builtin__'` 在单个 db 连接读两个命名空间——多库下若内置只在协调库，租户 shard 上那条 `OR '__builtin__'` 查不到（跨库 OR 做不到）。故 syncBuiltins 遍历 `allShardDbs()` **每 shard 刷全部内置 seed**（upsert 幂等，升级时 fan-out 重刷所有 shard）。协调库单份方案被否（要改 list/get 为应用层跨库合并，改动/风险大）。

**失败策略（用户裁决：逐 shard 尝试 + 任一失败则抛）**：syncBuiltins 是**启动期一次性 seed**（非周期 worker）——某 shard 缺内置模板=该 shard 租户功能缺损。遍历所有 shard 都尝试（别因第一个失败漏后面），聚合 errors；**若任一 shard 失败则最终抛**（启动期须显式知道，非静默隔离）。与 recoverTimedOut/BillingOutbox 的运行时逐 shard 隔离**有意区分**：那些是周期运行时（隔离让健康 shard 继续），syncBuiltins 是启动 seed（全成功或报错）。

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

3 构造点（已核实无别名）：
- 生产 `fromResolver(new SingleDbResolver(tx), personaCoreService)`：`app.ts:445`（bulkImport，紧邻 bulkImportPersonaCoreService）、`admin-templates.ts:34`（紧邻 personaCoreService）。两处 tx=声明 IDatabase；两处的 personaCoreService 是同函数刚建的 PersonaCoreService.fromResolver(同 resolver)——**核实调用点传的 resolver 与 PersonaCoreService 用的是同一个**（否则级联落不同 shard）。
- 测试 `fromUnitOfWork(db, personaCoreService)`：`persona-template-service.test.ts:32`。
方法调用方（admin-templates 的 syncBuiltins/list/get/instantiate）**不改**（实例已 fromResolver，方法自动生效）。

## 验收探针（FakeMultiShardResolver）

`src/test/unit/persona-template-service-sharding.test.ts`：

1. **CRUD per-tenant 分流对称**：tA→shard1、tB→shard2；各 `create`；断言 shard1 的 persona_templates 查得 tA 模板、查不到 tB，shard2 反之（对称）。
2. **syncBuiltins 每 shard 一份（核心）**：两 shard 的 resolver；`syncBuiltins()`；断言**两个 shard 的 persona_templates 都有全部 BUILTIN_TENANT_ID 模板**；再 `list(tA)`（tA→shard1）+ `list(tB)`（tB→shard2）各能查到内置模板（证每 shard 都有内置，单-SQL OR 查询成立）。
3. **instantiate 级联同 shard（核心，证 template/core resolver 一致）**：PersonaTemplateService.fromResolver(r, PersonaCoreService.fromResolver(**同 r**))；`instantiate({tenantId: tA, templateId, ...})`（tA→shard1）；断言 shard1 有：模板（get 读到）+ 新建 persona_core 行 + audit_log 行——**全落 shard1 同一 shard**（证 template.source 和 core.source 解析一致）。**变异**：若 PersonaTemplateService 用与 PersonaCoreService **不同**的 resolver（或 template 落 shard1、core 落别处）→ persona 行落错 shard → 此探针红。
4. **syncBuiltins 任一 shard 失败则抛**：三 shard，一个 throwingDb；`syncBuiltins()`；断言**整体抛**（非静默隔离——启动 seed 语义）+ 抛前健康 shard 已尝试（聚合 errors 含坏 shard）。
5. **UoW 模式**：fromUnitOfWork(db, core)；CRUD + instantiate 落该 db。
6. **单库零回归**：fromResolver(new SingleDbResolver(db), core)；CRUD/syncBuiltins/instantiate 行为与改造前等价。

## 红线（不变量）

1. **零回归**：单库（SingleDbResolver）+ UoW 模式 db 副作用逐字等价现状（含 instantiate 非原子=既有语义，不趁机加外层事务）；全量 unit fail=0。
2. **CRUD 经 forTenant**（单条写无需事务）；**syncBuiltins 经 allDbs fan-out**（每 shard 一份）；**instantiate 的模板/audit 经 forTenant**、persona 委托 personaCoreService。
3. **级联同 resolver 不裂脑**：PersonaTemplateService 与 personaCoreService 共享同一 resolver → 同 tenantId 同 db → 模板/persona/audit 落同一 shard。
4. **syncBuiltins 失败则抛**：逐 shard 尝试聚合 errors，任一失败最终抛（启动 seed 语义，非运行时隔离）。
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
