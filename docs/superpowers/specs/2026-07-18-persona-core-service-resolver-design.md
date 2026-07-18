# PersonaCoreService 双入口化（聚合根 facade 单点解析 + 向下传）设计

> **状态**：设计已定（Codex 78→退回，采纳 6 项修正），待 writing-plans。
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

**3. 统一 public wrapper + `InTx(tx, ...)` primitive 契约（Codex 采纳——替代原含糊二分）**

Codex 抓到原「写方法加 tx 参 vs 公共方法双入口」二分**含糊且危险**：`openGovernanceCase`（governance-service.ts:185 **自开 `this.tx.transaction()`**）既是公共入口、又被 marketplace 的 `disputeTask`（marketplace:1164 `governanceHook.openGovernanceCase`）在其事务内调——**嵌套事务陷阱**（SQLite 内层 BEGIN 报错；**PG 更危险：内层取独立 client/txId 独立提交，外层回滚撤不回内层 = 真部分提交**，已亲验 postgres-database.ts:243-246 每 transaction pool.connect 取专用 client）。

**统一规则（spec 定死，不留给 plan）：**
```
// 公共边界：解析租户 + 创建事务
publicOp(input) {
  const db = this.source.forTenant(input.tenantId);   // 唯一解析点
  return db.transaction(() => this.opInTx(db, input));
}
// 事务内 primitive：显式收 tx，禁止解析 source、禁止调 transaction()
opInTx(tx, input) { tx.execute(...); this.ctx.someHook.otherOpInTx(tx, ...); }
```
- **既被公共入口调、又被别的事务内调的方法**（`openGovernanceCase`/`insertMemory`/`insertWalletTransaction` 等）：**提供一对入口**——`openGovernanceCase(input)`（公共，解析+开事务→调 InTx）+ `openGovernanceCaseInTx(tx, input)`（primitive，收 tx 不自开事务）。marketplace 事务内改调 `...InTx(tx, ...)` 复用外层 tx。
- **typed hook 接口加 InTx 变体**：`memoryHook.insertMemoryInTx(tx,...)`/`governanceHook.insertGovernanceEventInTx(tx,...)`/`openGovernanceCaseInTx(tx,...)`/`walletHook.insertWalletTransactionInTx(tx,...)`——hook 转发链全程传 tx。
- **只读公共方法**（listPersonas/getPersonaDetail 等）：直接 `this.source.forTenant(tenantId)` 解析读，不人为造事务。

**4. 事务闭包内【全部】db 访问用显式 UoW（Codex 采纳——红线扩大，非仅「写方法」）**
Codex 抓到原「只改写方法」范围过窄——事务闭包内深层访问仍会捕获旧 this.tx：
- `PersonaMemoryService.getCognitive()`（每次 new `PersonaCognitiveMemoryGraph` 内部用 tx）、`projectKnowledgeItem()`（认知投影写）；
- audit helper（`recordBusinessAuditLog(this.tx, ...)`）；context callback 回调 facade 查询/写 helper。
**红线**：facade 事务闭包内的**一切** db 读写/helper/hook/认知投影/审计，全用那个显式传入的 UoW，不得触碰构造期 this.tx。plan 须产出**完整调用矩阵**（方法 × 公共入口/facade 事务内调/子服务事务内调/自开事务 → 目标形态 public|InTx|只读），防 44 方法 + hooks 漏改。

**5. 构造期副作用 `ensureAuditLogColumns(tx)`（Codex 采纳——原 spec 漏了）**
facade 构造器 `:354 ensureAuditLogColumns(tx)` 是构造期 schema 副作用。source 化后 fromResolver 无单一 tx。**决策：从 service 构造器移除**——schema 列保证归**迁移系统**（DDL 归 migration，不在 service 层按 shard fan-out DDL）。plan 核实该表列是否已在迁移中：是→删构造期调用；否→补迁移再删。

**6. recoverTimedOutRuntimeSessions（cross-tenant fan-out，逐 shard 隔离——Codex 采纳改隔离）**
marketplace 层遍历 `allShardDbs()`，每 shard 各自跑 `pcoreQueryTimedOutRuntimeSessions({now,limit})` + 逐行 retry/timeout。
- **失败隔离策略改为逐 shard 隔离**（Codex 采纳，非原 fail-fast）：目标是恢复卡死运行态 session（非删可有可无历史垃圾），一个坏 shard 不该阻止健康 shard 恢复；fail-fast 受遍历顺序影响、持续故障致后续 shard 长期饥饿；操作天然按 shard 独立无跨 shard 原子需求。返回扩展为 `{ scanned, recovered, timedOut, shardErrors: {shard,error}[] }`（同 BillingOutbox flush 形状——收入/恢复类都用隔离；与 QuotaManager prune 的 fail-fast 区分：prune 是纯清理垃圾，漏一轮真无害）。worker 调用方读 shardErrors 做日志。

## 构造点迁移（按声明静态类型，原子提交保编译）

7 生产构造点（全 `fromResolver(new SingleDbResolver(x), ...)`，x 均声明 IDatabase）：
- `memory-facade.ts:100`、`app.ts:444`（bulkImport）、`admin-templates.ts:32`、`persona-core.ts:348`（多参：encryption/timeout/encryptionResolver）、`tasks.ts:14`（`db ? ... : null` 三元）、`personas.ts:32`（`os.getDatabase()`）、`runtime-recovery-worker.ts:87`（worker per-tick）。
- 测试构造点 → `fromUnitOfWork`。
- **别名检查**：`grep` + typecheck 兜底（前片教训，如有 `PersonaCoreService as X` 别名 grep 抓不到，靠 TS2673）。plan 阶段 `grep -rn "new PersonaCoreService(" src` + 别名 import 检查完整清单。

## 验收探针（FakeMultiShardResolver）

`src/test/unit/persona-core-service-sharding.test.ts`：

1. **per-tenant 分流（对称）**：tA→shard1、tB→shard2；各 `createPersona`；断言 shard1 db 查得 tA 的 persona_core 行、查不到 tB，shard2 反之（对称）。
2. **跨子服务事务同 db（核心）**：调跨子服务事务方法（`createPersona`——tx.transaction 内既写 persona_core（facade）又 memoryService.insertMemoryInTx）；断言该 tenant 的 persona 行 + memory 行 + 认知投影行**落同一 shard**。
3. **原子回滚故障注入（Codex 采纳——证「同事务」非仅「同 shard」）**：facade 写 persona → 子服务写 memory 成功 → **子服务写完后注入异常** → 断言 persona/wallet/knowledge/memory/认知投影/audit **全部不存在**（整体回滚，证真同一事务非仅同 shard）。SQLite + PG 各至少一条（PG 尤须验，因嵌套会独立提交）。
4. **深层 tx 捕获变异（Codex 采纳）**：不只变异 `insertMemory` 直接 execute——还变异 `getCognitive()`/`projectKnowledgeItem` 用旧 `this.tx`（构造期 db），断言探针 2/3 应红（认知投影裂脑：persona 落 dbForTenant shard、认知投影落构造期 db）。证「事务闭包内全部访问用显式 UoW」红线被测。
5. **typed hook 覆盖**：至少 marketplace→wallet、governance→memory、marketplace→governance、facade→memory 各一条跨 hook 事务落同 shard + 回滚。
6. **嵌套事务变异（Codex 采纳）**：把某 `InTx` 方法变异为内部再调 `transaction()`——SQLite 应失败；PG 须证外层回滚后无内层残留提交。
7. **recoverTimedOut fan-out + 部分失败隔离**：两 shard 各预置超时 session → 都被恢复、聚合求和；再一 shard 用 throwingDb → 不整体抛、shardErrors 记它、健康 shard 仍恢复。
8. **encryptionResolver canonical tenantId（Codex 采纳）**：加密配置解析与 db 解析用同一 canonical tenantId；探针验跨租户不串加密配置（shard 对 + 加密配置对）。
9. **UoW 模式**：fromUnitOfWork(db)；createPersona + 子服务写落该 db、原子回滚。
10. **单库零回归**：fromResolver(new SingleDbResolver(db))；跨子服务事务方法行为与改造前等价。

## 红线（不变量）

1. **零回归**：单库（SingleDbResolver）+ UoW 模式 db 副作用等价现状；全量 unit fail=0。
2. **跨子服务事务边界铁律（本片安全命脉）**：一次 facade 事务方法内，facade 写 + 所有子服务写落**同一物理连接同一事务**——facade 入口解析一次 db 向下传，**禁止子服务内部各自解析/开嵌套事务**。
3. **per-tenant 经 forTenant（facade 入口单点解析）；cross-tenant（recoverTimedOut）经 allDbs fan-out**。
4. **UoW 模式 forTenant 忽略 tenantId 恒返 tx**（结构上不脱离事务）；allDbs=[tx]。
5. **事务闭包内全部 db 访问收显式 tx**（不仅写方法——含 getCognitive/projectKnowledgeItem/audit/hook），不用构造期 this.tx（避免落错 shard/裂脑）。
6. **dbForTenant 确定性**：同 tenantId 恒同 db（依赖 resolver 契约 + 连接池 connStr 去重）——跨子服务同 tenantId 解析一致是不裂脑的前提。
6b. **public wrapper + InTx primitive 契约**：公共入口解析租户+开事务→调 InTx；InTx 收 tx、禁止解析 source、禁止自开 transaction（结构性禁止嵌套事务——PG 嵌套会独立提交致部分提交）。既公共又被事务内调的方法提供一对入口。
6c. **canonical tenantId 不变量（Codex 采纳）**：进入公共 facade 方法后固定 canonical tenantId；db 解析、encryptionResolver 加密配置解析、全部下游输入用同一值，禁止子服务从实体/hook 返回值重新推导 tenantId（防加密配置串租户）。
6d. **ensureAuditLogColumns 移除**：schema 列归迁移系统，从 service 构造器移除（DDL 不在 resolver/service 层 fan-out）。
7. **无适配层**（IDatabase extends SyncWriteUnitOfWork）。
8. **inventory 更新**：PersonaCoreService 相关的 `longlived-root-capture` 条目（personas.ts/admin-templates.ts/memory-facade.ts）——改双入口后是否仍命中 ratchet？plan 核实（大概率仍捕获 sharedDb/os.getDatabase() 在别处，条目保留；PersonaCoreService 本身改持 source 不新命中）。`check:db-access` 继续通过。
9. **构造点分类以声明静态类型为准**；别名靠 typecheck 兜底。

## 验收标准

- `npm run typecheck` exit 0（权威无残留含别名）；`npm run build` 成功。
- 探针全绿（5 类，尤其「跨子服务事务同 db」）+ 变异证明（forTenant 固定→分流红；子服务用旧 this.tx→跨子服务落不同 shard 红）。
- 全量 unit fail=0（零回归铁证）。
- `npm run check:db-access` exit 0。
- 交叉审查（生成者≠审查者）：Codex 审 spec（重点审跨子服务事务边界方案、子服务传 tx 的颗粒度、recoverTimedOut fail-fast vs 隔离、级联复杂度是否可控）。
