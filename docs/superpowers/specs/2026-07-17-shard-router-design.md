# ShardRouter 实现设计（#3 Phase 0 第一子片）

**日期:** 2026-07-17
**范围:** `src/storage/shard-router.ts`（新）、`src/storage/shard-hash.ts`（新，确定性模哈希纯函数）、`src/config/schema.ts`（db.shards/db.coordinator 可选扩展）、`src/storage/factory.ts`（建 shard db）、`src/multi-tenant/tenant-os-factory.ts`（一处接线：`this.db` → resolver）
**关联:** #3 租户分片；实现 Phase -1（PR #313，已合 main）定的 `TenantDbResolver` 契约；依赖 #4 编译锁 per-persona（已合）
**状态:** Phase 0 的**第一子片**——只做路由引擎（ShardRouter）。后续子片：12 项子服务生命周期重构 / metrics fan-out（Phase 2）/ 迁移（Phase 3）。

## 背景与问题

Phase -1（已合 main）交付了 `TenantDbResolver` 契约 + `SingleDbResolver` 单库适配器 + DB-访问点盘点 allowlist + ratchet。契约定了，但**真 shard 路由（一致性哈希 + per-shard 连接池 + 多 shard 配置）尚未实现**——`SingleDbResolver` 三方法都返回同一 db。

本子片实现 `ShardRouter implements TenantDbResolver`：按 tenantId **确定性模哈希**路由到对应 shard 的 `IDatabase`。**默认单 shard，数据路径 + DB 身份等价现状（经全量回归验证），零回归**；配了多 shard 则本片 fail-closed 拒绝启动（见范围边界）。

**范围边界（已与用户确认 + Codex 退回后收紧）：** 本片只做路由引擎。TenantOSFactory 内**数据访问改一处**（`new TenantDatabase(this.db, tenantId)` → `resolver.dbForTenant(tenantId)`），但**装配面不止一处**（Codex 更正）：`createApp:280 new TenantOSFactory(...)` + `main.ts`/`main-desktop.ts` 生产入口 + 直接构造工厂的测试都要迁移到注入 resolver。盘点里 **12 项 `longlived-root-capture`**（Codex 更正数字：jwtKeyStore 是 platform-table→coordinator，不算）+ 其余 explicit-per-request/module-singleton/global-worker 访问点**本片不接**（下一子片接线）。

**⚠️ 致命风险 → fail-closed 护栏（Codex 退回核心，必须加）：** 若有人配 `db.shards` 两个 shard,TenantOSFactory 内核路径走对 shard,但那 12 处访问点仍走 host db → **同一 tenant 的数据静默分裂到两库**(decisions 的 subscriptions/BYOK、privacy 导出、memory-facade confidence 写等)。仅文档写「本片不足以正确多 shard」**不构成运行时约束**。故本片**必须加启动期 fail-closed**（镜像 `main.ts:61-66` 的 port-0 guard 模式）：

> **任何非空 `db.shards`（含恰好 1 个 shard）在生产装配都启动期直接 `throw`（拒绝启动）。** —— Codex 第 2 轮更正：只拒 `>1` 有漏洞——配 1 个 shard 时,那个 shard 的 `IDatabase` 与 root/host db 是**不同实例**,TenantOSFactory 会走 shard db,而未接线的 12 项访问点仍走 host db → 单 shard 下也静默分裂。故护栏收紧到「非空 shards 即拒」。解除条件 = 全 inventory（12 项 + 其余类别）接线 + 跨真实 route/service 的 2-shard 验收通过,不是模糊的「访问点改完」,更不能用 ratchet/路由器单测替代此护栏。**测试通过注入 config 直接构造 ShardRouter 验证引擎（绕过生产 guard）,生产入口一律拒非空 shards。**

即：本片 `ShardRouter` 作为**可单测的引擎**合入(2-shard 单测证明路由逻辑对)，但**生产多 shard activation 被 fail-closed 挡住**——单库缺省路径正常,多 shard 配置在下一子片接线完成前无法启用。这把「静默错-shard」从可能变为不可能。

## 组件与数据流

### 1. `ShardRouter`（`src/storage/shard-router.ts`，实现 `TenantDbResolver`）

- 构造：`new ShardRouter(shards, coordinatorConnStr, buildDb)` —— `shards: Record<shardId, connStr>`；`buildDb: (connStr) => IDatabase`（注入建库函数，便于测试用内存 db）。
- 构造须含 **显式 `homeShardId`**（Codex：不用 `sortedShardIds()[0]`——新增字典序更小的 shard 会漂移 home，是不稳定契约）：`new ShardRouter({ shards, coordinatorConnStr, homeShardId, buildDb })`。`homeShardId` 来自 config，须 ∈ shards 的 key（否则 fail-closed）。
- `dbForTenant(tenantId)`：`shardIdForTenant(tenantId, sortedShardIds())` → `poolFor(shardId)`。**`default` 特判**：恒返回 `poolFor(homeShardId)`（显式配置，对应 Phase 1 default 归位前置）。
- `coordinatorDb()`：返回协调库 db（懒建缓存）。**注**：若 coordinator connStr 与某 shard 相同,须复用同一 IDatabase 实例(不建重复池/防重复 close)。
- `allShardDbs()`：返回所有 shard 的 db（供后续 fan-out；触发全部懒建）。
- `poolFor(shardId)`：首次访问懒建 `buildDb(shards[shardId])`（内含同步跑迁移），**按 shardId 键缓存**（`Map<shardId, IDatabase>`）——同 shard 的多租户共享一池，**不按 tenant 缓存**（硬约束：防连接爆）。**注（Codex）**：`IDatabase` 是同步接口,懒建里的迁移会**同步阻塞首个触达该 shard 的请求**（PG 主线程 facade 同步等待,单次 30s 超时）；本片提供 `initialize()` 方法预建+预迁移所有配置 shard,生产装配调它启动期预热,懒建保留作测试/未预热路径。
- `close()`：关所有缓存的 shard db + 协调库。**owner + 关闭链（Codex 致命2）**：`ShardRouter` 是这些池的唯一 owner；须在 app shutdown 接 `router.close()`（现有 `createApp` onClose 只 `tenantFactory.clear()`,不关 router 池 → 会泄漏）；且**避免 SingleDbResolver/root OS 与 router 双关同一 db**（单库路径下 root OS 已 close 那个 db,router 不得再 close）。

### 2. 确定性模哈希路由（`src/storage/shard-hash.ts`，纯函数）

- `shardIdForTenant(tenantId: string, shardIds: readonly string[]): string` = `fnv1a64(tenantId) % shardIds.length` → `shardIds[idx]`。
- **命名诚实（Codex）**：这是**确定性模哈希**,**不是一致性哈希**——增/删 shard 会重映射**大部分** tenant（`% N` 无 minimal-disruption 性质）。本片 shard 集合是**静态配置、不动态增删**（rebalance 是 Phase 3),故模哈希够用;spec/命名不称「一致性哈希」,并明写「shard 集合变更 = 需 Phase 3 迁移编排,不是本片能安全做的」。若未来要动态增删节点,再上 rendezvous hashing / hash ring。
- **抽公用 `fnv1a64(s): bigint` 纯函数**（不 reach 内核私有 `decision-style-perturbation.ts` 的 `hashSeed`）。
- **FNV 语义锁定（Codex）**：#311 的 hashSeed 按 JS `charCodeAt`（UTF-16 码元）哈希,**非** UTF-8 byte 标准 FNV-1a。本片新 `fnv1a64` 若声称「复用 #311 算法」,须逐字符保持同语义,并用 **golden vector**（ASCII / BMP 中文 / 代理对 emoji tenantId）锁定输出,防日后漂移。
- **确定性**：同 tenantId + 同 shardIds → 同 shardId（可复现,无 `Math.random`）。`shardIds` 须**稳定排序**（`sortedShardIds()`）后再取模,否则 config key 顺序变会重路由。

### 3. 配置扩展（`src/config/schema.ts`）

- `db.shards?: Record<string, { connectionString: string }>`（可选）+ `db.coordinator?: { connectionString: string }`（可选）+ `db.homeShardId?: string`（可选,default 租户的 home shard,须 ∈ shards key）。
- **缺省（无 shards）→ 单库**：工厂用 `SingleDbResolver(createDatabase(config))`，行为不变（向后兼容零回归）。
- **任何非空 `db.shards`（≥1）→ 生产启动期 fail-closed `throw`**（Codex 第 2 轮：不是 >1,是非空即拒——单 shard 也会因 shard db≠host db 致未接线访问点分裂）。即本片**不放开**任何生产 shard activation——`ShardRouter` 引擎合入 + 可单测（测试注入 config 直构,绕过 guard），但生产配了 shards 会被拒。下一子片接线完成 + 2-shard 验收后才解除。
- shards=1 也拒（Codex：单 shard db≠host db 仍分裂）;ShardRouter 的单/多 shard 路径由**单测注入 config 直构**验证,不经生产 guard。homeShardId 不 ∈ shards → fail-closed。

### 4. 建 shard db（`src/storage/factory.ts`）

- 抽一个 `createShardDb(connStr, pool): IDatabase` —— 建 `PostgresDatabase` 池 + `runDslPostgresMigrations`（每 shard 独立跑同一套迁移，和现单库一致）。协调库同样建 + 迁移。
- `createDatabase(config)`（现有单库入口）不动——缺省路径仍走它。

### 5. 接线（TenantOSFactory 内数据访问一处 + 装配面多处）

- 工厂持有的 `private readonly db: IDatabase`（`:53`）改为 `private readonly resolver: TenantDbResolver`。
- `createTenantOS`（`:111`）：`new TenantDatabase(this.resolver.dbForTenant(tenantId), tenantId)`。
- 工厂构造方注入 resolver（单库注 `SingleDbResolver`，多库注 `ShardRouter`）——由上层（`createApp`/`main`）按 config 决定。

### 数据流
```
TenantOSFactory.createTenantOS(tenantId)
  → resolver.dbForTenant(tenantId)              // SingleDbResolver(单库) 或 ShardRouter(多库)
      → shardIdForTenant(tenantId, sortedIds)   // FNV64 % N；default→homeShard
      → poolFor(shardId)                        // 按 shardId 懒建缓存 IDatabase
  → new TenantDatabase(shardDb, tenantId)       // WHERE tenant_id=? 注入不变
```

## 关键决策

| 决策 | 选择 | 理由 |
| --- | --- | --- |
| A. shard 映射来源 | **纯哈希，不建 `tenant_shard` 表** | 表是给迁移/rebalance（Phase 3）用的（「表覆盖哈希」）；本片不做迁移，纯哈希足够。Phase -1 spec 说「表权威、哈希缺省」——本片只落缺省。YAGNI：不建没有写入方的表。 |
| B. 连接池生命周期 | 懒建 + **按 shardId 永缓存** | 同 shard 多租户共享一池，池数=shard 数；按 tenant 缓存会连接爆（Phase -1 硬约束）。 |
| C. 迁移 | 每 shard db 建时独立跑同一套迁移 + 协调库也跑 | 和现单库一致；本片建池即最新，不做跨 shard 迁移编排（运维/后续）。 |
| D. default 租户 | 钉**显式配置的** `homeShardId`（不用 sortedShardIds[0]——新增字典序更小 shard 会漂移,Codex） | 对应 Phase 1 default 归位前置；`dbForTenant('default')` 明确落 home shard。 |
| 路由哈希 | 64 位 FNV-1a **确定性模哈希**（抽公用纯函数,不 reach 内核私有;golden vector 锁定） | 静态 shard 集合下够用;非一致性哈希(增删 shard 大部分重映射,rebalance 是 Phase 3);无 Math.random、可复现。 |
| E. 多 shard 启用（Codex 致命1） | **启动期 fail-closed**：shard>1 拒绝启动 | 12 项访问点未接线前放开多 shard = 静默错-shard；护栏是运行时约束,非文档承诺。 |
| F. 池 owner/关闭（Codex 致命2 + 第 2 轮补） | ShardRouter 唯一 owner,app shutdown 接 `router.close()`；**幂等 close**（共享实例只关一次）；**init 失败回收**（`initialize()` 中途失败须关已建的池,不半泄漏）；main/main-desktop/createApp 共用**唯一启动 assembler/validator** | 现有 onClose 只 clear 租户 OS,不关 router 池 → 泄漏；防与 root OS 双关同一 db；防三个入口各写一套装配致 guard 漏挂。 |
| G. 启动预热 | `initialize()` 预建+预迁移所有 shard | 懒建的同步迁移会阻塞首个请求（PG 主线程同步等待,30s 超时）。 |

## 不变量（测试必须覆盖）

1. **哈希稳定可复现**：同 tenantId + 同 shardIds → 恒同 shardId（跑多次一致）；`shardIds` 排序后取模（config key 顺序变不影响路由）。
2. **default 钉 home shard**：`dbForTenant('default')` 恒返回**显式配置的** `homeShardId` 的 db（新增字典序更小 shard 不漂移）。
3. **池按 shardId 去重缓存**：同 shard 的多个租户 → 同一个 db 实例（`strictEqual`）；不同 shard → 不同 db 实例。
4. **【核心】2-shard 路由真分叉**：配两个（内存 SQLite）shard，**先用 `shardIdForTenant` 计算、从两个 shard 各挑一个真落该 shard 的 tenantId**（不假设任意字符串会分叉——用哈希算出来选），断言这两个 tenantId 的 `dbForTenant` 返回**不同** db 实例（引用比较）；且 `dbForTenant` 对同一 tenantId 恒返回其 shard 的同一 db。
5. **单库等价现状（零回归）**：无 shards 配置时工厂用 `SingleDbResolver`，`dbForTenant` 恒返回同一 db；全量回归零回归。
6. **close 关全部**：`ShardRouter.close()` 关所有缓存 shard db + 协调库（不泄漏连接）。
7. **懒建**：未访问的 shard 不建池（`poolFor` 首次访问才 `buildDb`）；`initialize()` 后所有配置 shard 已建（不阻塞首个请求）。
8. **【安全护栏】任何非空 shards fail-closed（Codex 第 2 轮收紧）**：生产装配（main/main-desktop/createApp 共用的唯一启动 validator）见**非空** `db.shards`（含 1 个）→ **在建任何池/worker 之前** `throw` 拒绝；homeShardId ∉ shards → `throw`。此 guard 是自动化测试覆盖项（不变量 8/9/10 均须落测试,非仅文字）：测单-shard-不同-root 也被拒、生产入口 guard 生效、共享实例只 close 一次。
9. **close 唯一 owner 不双关**：单库路径下 root OS close 那个 db,ShardRouter 不重复 close 同一实例（coordinator==某 shard 时复用同实例）。
10. **FNV golden vector**：`fnv1a64` 对 ASCII/BMP 中文/代理对 emoji 三类 tenantId 有锁定的 golden 输出（防算法漂移）。

## 明确不做（YAGNI）

- 不建 `tenant_shard` 表（Phase 3 迁移才需要写入方）。
- 不接盘点里 12 项 `longlived-root-capture` 访问点（下一子片：子服务生命周期重构）。
- 不做 metrics fan-out（Phase 2）。
- 不做 rebalance/迁移/跨 shard 迁移编排（Phase 3 + 运维）。
- 不改 `createDatabase` 单库入口（缺省路径不动）。
- 不改 `TenantDatabase` 的 WHERE 注入。

## 本地验证

- **单测** `src/test/unit/shard-router.test.ts` + `shard-hash.test.ts`：覆盖不变量 1-4/6/7，用注入的 `buildDb`（返回内存 SQLite）+ 2-shard 配置。
- **单库等价** `src/test/unit/`：无 shards 时工厂用 SingleDbResolver 的路径 + 全量 unit 回归（不变量 5，零回归）。
- `npm run typecheck` + `npm run build` + `node scripts/check-db-access-ratchet.mjs`（新增 shard-router.ts/shard-hash.ts 须归类——它们是分片基建，排除或归 root-only，随 Phase -1 ratchet 纪律）。
- 失败即止。

## 风险

- **中-高**（Codex 退回后重估）。核心风险是「多 shard 半截启用致静默错-shard」——本片用**启动期 fail-closed**（shard>1 拒绝启动）把它从可能变为不可能,这是解除退回的关键护栏。次要：单库缺省零回归（默认路径 = SingleDbResolver，数据路径+DB 身份等价,全量回归验证）；连接池泄漏用 owner+shutdown 接 `router.close()` 挡；`shardIds` 未排序重路由用「排序后取模」挡。**本片单独不足以「正确多 shard」**（12 项访问点未接）——有意的分片交付,fail-closed 保证不能被半截启用。
- 跨审：本 spec 交 Codex 交叉审查（Claude 生成 → Codex 审）。

## 交叉审查记录（CLAUDE.md 互审规范）

- **生成:** Claude；**审查:** Codex（独立，非自审）；报告 `.claude/review-report-shard-router.md`。
- **Codex 首轮:** 68/100，**退回**。两个致命（安全攸关）+ 若干技术更正,全部独立核实成立。
- **主 AI 决策（<80 且退回 → 按 CLAUDE.md 确认退回并修）:** 接受退回。逐条独立核实（`decisions.ts:93-99` 实证注册期 host db + 请求 tenantId 查=静默错-shard；`app.ts:280` 实证非唯一接线；`main.ts:61-66` 实证有 fail-closed guard 模式可镜像）。已全面修订：
  1. 【致命1·已修】多 shard 半截启用静默错-shard → **加启动期 fail-closed 护栏**（shard>1 拒绝启动,决策 E + 不变量 8）；本片 ShardRouter 引擎合入+可单测,但生产多 shard activation 被挡,下一子片接线完成+2-shard 验收才解除。
  2. 【致命2·已修】连接池关闭链不完整 → ShardRouter 唯一 owner + app shutdown 接 `router.close()` + 防与 root OS 双关（决策 F + 不变量 9）。
  3. 【更正·已修】「一致性哈希」名不副实 → 改「确定性模哈希」,写清 shard 集合静态、增删=Phase 3 迁移。
  4. 【更正·已修】default=sortedShardIds[0] 不稳定 → 改**显式 `homeShardId` 配置**（决策 D + 不变量 2）。
  5. 【更正·已修】「唯一一处接线」→ 数据访问一处 + 装配面多处（createApp/main/测试）。
  6. 【更正·已修】「字节等价」→「数据路径+DB 身份等价,经全量回归验证」。
  7. 【更正·已修】13 项 → 12 项（jwtKeyStore 是 platform-table）。
  8. 【更正·已补】FNV UTF-16 charCode 语义须 golden vector 锁定（不变量 10）；懒建同步迁移阻塞首请求 → `initialize()` 预热（决策 G + 不变量 7）。
- **结论：修订后待 Codex 复审**（两个致命的根因——静默错-shard 用 fail-closed 变为不可能、池泄漏用 owner+close 链堵住——已处理）。

- **第 2 轮复审（Codex，确认修订）：78/100，仍退回。** 抓到决定性残留：**单-shard activation 漏洞**——原 fail-closed 只拒 `>1`,但配 1 个 shard 时那个 shard db 与 host db 是不同实例,TenantOSFactory 走 shard db 而未接线的 12 项走 host db → 单 shard 下也静默分裂。**主 AI 独立核实确认**（spec 原 `:47` 确写「shards=1 允许」+ `createShardDb` 建的是新实例）,Codex 对。已收紧：
  1. 【致命1 残留·已修】fail-closed 从「shards>1 拒」改为「**任何非空 shards（含 1）在建任何池/worker 前拒**」（背景段 + 决策 E + config + 不变量 8）；测试注入 config 直构验证引擎,绕过生产 guard。
  2. 【补】main/main-desktop/createApp 共用**唯一启动 assembler/validator**（防三入口各写装配致 guard 漏挂,决策 F）。
  3. 【补】幂等 close（共享实例只关一次）+ init 失败回收（决策 F + 不变量 9）。
  4. 【补】不变量 8/9/10 须落**自动化测试**（单-shard-不同-root 被拒 / 生产入口 guard / 共享实例关一次），非仅文字。
  - 命名（确定性模哈希）/显式 homeShardId/12 项/UTF-16 golden 等第 1 轮修订,Codex 确认已基本解决。
- **结论：修订后待 Codex 第 3 轮复审**（单-shard 洞已用「非空即拒」堵死,静默错-shard 现在真的从可能变为不可能）。
