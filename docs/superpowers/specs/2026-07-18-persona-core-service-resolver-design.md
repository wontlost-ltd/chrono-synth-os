# PersonaCoreService 双入口化（聚合根 facade 单点解析 + 向下传）设计

> **状态**：设计已定，待 Codex 交叉审查 → writing-plans。
> **归属**：#3 租户分片 Phase 0 —— 「12 访问点接线」sub-phase 的 persona 块**第一片**（PersonaTemplateService + syncBuiltins 归后续独立子片）。
> **前置**：QuotaManager 双入口 + fan-out 范本、计量/账单四件套（PR #314）；`TenantDbResolver`/`SingleDbResolver`/`FakeMultiShardResolver` 已就位。

## 背景与问题

PersonaCoreService 是 persona 域的**聚合根 facade**：构造器把单一 `tx: SyncWriteUnitOfWork` 分发给 4 个子服务（`PersonaMemoryService`/`PersonaWalletService`/`PersonaGovernanceService`/`PersonaMarketplaceService`），各自存成 `private readonly tx` 字段（构造期绑死）。它有 7 个生产构造点，**全是裸 root db**（`os.getDatabase()` 或 app.ts 根 db 传递），per-request 对 root db 跑租户查询——多库下静默错-shard，与前几片同类缺口，但复杂度高一个量级。

**与前四片的本质区别（侦察实证）：**
- **5 类级联**：facade + 4 子服务，子服务间通过 facade 构造的 typed hook 互调（marketplace→wallet+memory+governance，governance→memory）。
- **21 处 `this.tx.transaction()`** + **跨子服务共享事务边界**：如 `createPersona` 的 `this.tx.transaction(() => { this.tx.execute(createPersona); this.tx.execute(createWallet); this.memoryService.insertMemory(...) })`——facade 事务包裹 + 子服务内部写，**当前不裂脑纯因 facade.tx === 子服务.tx（构造期同一引用）**。
- **44+ per-tenant 方法 + 1 cross-tenant**：`recoverTimedOutRuntimeSessions`（无 tenantId，SQL 无 tenant_id 过滤，全表跨租户扫 `runtime_sessions`）。

## 本片范围（YAGNI）

**只做**：PersonaCoreService（含 4 子服务）双入口化 + recoverTimedOut fan-out + 7 构造点原子迁移 + 探针。

**不做**（后续独立子片）：
- **PersonaTemplateService**（级联依赖 PersonaCoreService；`instantiate()` 跨两 tx 三段写；`syncBuiltins` 内置模板分片归属——`list/get` 单-SQL `WHERE tenant_id=? OR tenant_id='__builtin__'` 决定**内置模板须每 shard 一份 fan-out**，协调库方案做不到跨库 OR。这是独立架构决策，归 persona 块第二片）。
- app.ts 穿真 ShardRouter 到 route 层；default 租户路径统一。

## 设计路径（用户裁决：(a) facade 单点解析 + 向下传子服务；子服务写方法加 tx 首参）

评估三路径无银弹（详见 brainstorm）：(c) 上游 per-request 覆盖不了 cross-tenant recoverTimedOut + 改 6 route 几十 handler；(d′) facade 缓存树改 44 方法取源 + UoW key 尴尬。选 **(a)**——模式最一致，dbForTenant 确定性化解跨子服务裂脑，recoverTimedOut 在 marketplace 自然 fan-out。

### 核心机制

**1. facade 双入口**
```
interface PersonaCoreSource {
  forTenant(tenantId: string): SyncWriteUnitOfWork;
  allDbs(): SyncWriteUnitOfWork[];   // recoverTimedOut fan-out 用
}
class PersonaCoreService {
  private constructor(private readonly source: PersonaCoreSource, encryption?, runtimeSessionTimeoutMs?, encryptionResolver?, clock?) { ... }
  static fromResolver(resolver: TenantDbResolver, encryption?, ..., clock?): PersonaCoreService { ... }
  static fromUnitOfWork(tx: SyncWriteUnitOfWork, encryption?, ..., clock?): PersonaCoreService { ... }
}
```
- `fromResolver`：`forTenant: (t) => resolver.dbForTenant(t)`、`allDbs: () => resolver.allShardDbs()`。
- `fromUnitOfWork`：`forTenant: () => tx`、`allDbs: () => [tx]`。
- 保留 encryption/runtimeSessionTimeoutMs/encryptionResolver/clock 位（PersonaCoreService 的既有依赖）。

**2. facade per-tenant 方法：入口解析 db，向下传**
```
// 改造前：this.tx.transaction(() => { this.tx.execute(...); this.memoryService.insertMemory({...}) })
// 改造后：
someMethod(tenantId: string, ...) {
  const db = this.source.forTenant(tenantId);
  db.transaction(() => {
    db.execute(...);
    this.memoryService.insertMemory(db, {...});   // 子服务写方法加 db 首参
  });
}
```
- 原 `this.tx.xxx(...)` → `db.xxx(...)`；原 `this.tx.transaction(fn)` → `db.transaction(fn)`。
- **单一解析点**：facade 方法入口解析一次 db，整个方法（含事务内的子服务调用）共用这个 db → 同一物理连接、同一事务、**无嵌套事务**（SQLite 平坦 BEGIN 不可嵌套的陷阱由此规避）。
- dbForTenant 确定性（同 tenantId 恒返同 db + 连接池按 connStr 去重）→ 即使不显式传 db、子服务各自 forTenant(同 tenantId) 也解析到同一实例；但**显式传 tx 首参更安全**（杜绝子服务内部误开嵌套事务），故采用显式传递。

**3. 子服务写路径方法加 `tx: SyncWriteUnitOfWork` 首参**
- 被 facade 事务内调的子服务方法（`insertMemory`/`insertGovernanceEvent`/`projectKnowledgeItem`/marketplace 的 wallet/memory/governance hook 转发等）签名加 `tx` 首参，方法体用传入 tx 而非 `this.tx`。
- 子服务**自己的公共 per-tenant 方法**（非被 facade 事务内调、route 直接调子服务的，如有）：也双入口化或由上游解析传下——plan 阶段逐方法归类（大多数子服务方法是被 facade 调的，独立公共入口少）。
- 子服务构造是否还持 `this.tx`：plan 定——倾向**子服务也双入口/持 source**，但被 facade 事务内调的路径一律走「传入 tx」优先，避免双解析。最简形态：子服务方法全部改为「显式收 tx 参数」，子服务不再持 db 字段（无状态化门面）——但这要改子服务全部方法签名。plan 权衡「只改写路径方法 vs 全无状态化」的颗粒度。

**4. recoverTimedOutRuntimeSessions（cross-tenant fan-out）**
marketplace 层遍历 `allShardDbs()`，每 shard 各自跑 `pcoreQueryTimedOutRuntimeSessions({now,limit})` + 逐行 retry/timeout，聚合 `{scanned, recovered, timedOut}` 求和。
- **失败隔离策略**：它是恢复清理（非收入上报），倾向 **fail-fast**（同 QuotaManager prune——某 shard 抛错整体抛、下轮 timer 重来，漏一轮无害）。plan 确认（与 BillingOutbox 的逐 shard 隔离是有意区分：prune/recover 清理类 fail-fast，flush 收入类隔离）。

## 构造点迁移（按声明静态类型，原子提交保编译）

7 生产构造点（全 `fromResolver(new SingleDbResolver(x), ...)`，x 均声明 IDatabase）：
- `memory-facade.ts:100`、`app.ts:444`（bulkImport）、`admin-templates.ts:32`、`persona-core.ts:348`（多参：encryption/timeout/encryptionResolver）、`tasks.ts:14`（`db ? ... : null` 三元）、`personas.ts:32`（`os.getDatabase()`）、`runtime-recovery-worker.ts:87`（worker per-tick）。
- 测试构造点 → `fromUnitOfWork`。
- **别名检查**：`grep` + typecheck 兜底（前片教训，如有 `PersonaCoreService as X` 别名 grep 抓不到，靠 TS2673）。plan 阶段 `grep -rn "new PersonaCoreService(" src` + 别名 import 检查完整清单。

## 验收探针（FakeMultiShardResolver）

`src/test/unit/persona-core-service-sharding.test.ts`：

1. **per-tenant 分流（对称）**：tA→shard1、tB→shard2；各 `createPersona`；断言 shard1 db 查得 tA 的 persona_core 行、查不到 tB，shard2 反之（对称）。
2. **跨子服务事务同 db（核心，前四片没有的）**：调一个跨子服务事务方法（如 `createPersona`——它 tx.transaction 内既写 persona_core（facade）又 memoryService.insertMemory）；断言该 tenant 的 persona 行 + memory 行**落在同一 shard**（证 facade 单点解析向下传，子服务没用旧 this.tx 落别处）。**变异**：若子服务用旧 `this.tx`（构造期 db）而非传入 tx → memory 行会落构造期 db 而非 dbForTenant 的 shard → 此探针红。
3. **recoverTimedOut fan-out**：两 shard 各预置超时 runtime_session；调 recoverTimedOutRuntimeSessions；断言两 shard 的都被恢复、聚合 scanned/recovered 为和。
4. **UoW 模式**：fromUnitOfWork(db)；createPersona + 子服务写落该 db。
5. **单库零回归**：fromResolver(new SingleDbResolver(db))；跨子服务事务方法行为与改造前等价。

## 红线（不变量）

1. **零回归**：单库（SingleDbResolver）+ UoW 模式 db 副作用等价现状；全量 unit fail=0。
2. **跨子服务事务边界铁律（本片安全命脉）**：一次 facade 事务方法内，facade 写 + 所有子服务写落**同一物理连接同一事务**——facade 入口解析一次 db 向下传，**禁止子服务内部各自解析/开嵌套事务**。
3. **per-tenant 经 forTenant（facade 入口单点解析）；cross-tenant（recoverTimedOut）经 allDbs fan-out**。
4. **UoW 模式 forTenant 忽略 tenantId 恒返 tx**（结构上不脱离事务）；allDbs=[tx]。
5. **子服务写方法收显式 tx 参数**，不用构造期 this.tx 落写（避免落错 shard）。
6. **dbForTenant 确定性**：同 tenantId 恒同 db（依赖 resolver 契约 + 连接池 connStr 去重）——跨子服务同 tenantId 解析一致是不裂脑的前提。
7. **无适配层**（IDatabase extends SyncWriteUnitOfWork）。
8. **inventory 更新**：PersonaCoreService 相关的 `longlived-root-capture` 条目（personas.ts/admin-templates.ts/memory-facade.ts）——改双入口后是否仍命中 ratchet？plan 核实（大概率仍捕获 sharedDb/os.getDatabase() 在别处，条目保留；PersonaCoreService 本身改持 source 不新命中）。`check:db-access` 继续通过。
9. **构造点分类以声明静态类型为准**；别名靠 typecheck 兜底。

## 验收标准

- `npm run typecheck` exit 0（权威无残留含别名）；`npm run build` 成功。
- 探针全绿（5 类，尤其「跨子服务事务同 db」）+ 变异证明（forTenant 固定→分流红；子服务用旧 this.tx→跨子服务落不同 shard 红）。
- 全量 unit fail=0（零回归铁证）。
- `npm run check:db-access` exit 0。
- 交叉审查（生成者≠审查者）：Codex 审 spec（重点审跨子服务事务边界方案、子服务传 tx 的颗粒度、recoverTimedOut fail-fast vs 隔离、级联复杂度是否可控）。
