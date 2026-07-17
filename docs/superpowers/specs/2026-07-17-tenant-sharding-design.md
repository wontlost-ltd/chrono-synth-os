# 租户分片设计（application-level tenant→shard routing）

**日期:** 2026-07-17
**范围:** `src/storage/`（factory + shard router）、`src/multi-tenant/`（tenant-os-factory 路由点）、`src/config/schema.ts`（shard map 配置）、`src/server/routes/metrics.ts` + `src/observability/`（fan-out）、`src/privacy/`（迁移复用）、协调库 schema
**关联:** 规模化缺口 #3；依赖 #4（编译锁去全局化，PR #312）——分片后每 shard 内部仍需 per-persona 锁才不被大租户串行卡死
**状态:** 多阶段**设计总览**（Phase 0-3 的架构 + 接口契约 + 依赖顺序）。**本文件不直接可实现**——每个 Phase 落地前须各自出一份详细 spec + plan（本总览定契约与边界，细节在各 Phase spec）。Phase 0 优先。

## 背景与问题

当前所有租户共享**一个** Postgres 实例：`createDatabase(config)`（`storage/factory.ts:13`）建单个 `PostgresDatabase`（单 `pg.Pool`，`postgres-database.ts:197`），`TenantOSFactory` 把它包进 `TenantDatabase(this.db, tenantId)`（`tenant-os-factory.ts:111`）注入 `WHERE tenant_id = ?`。单实例撑不到 6e9 persona 的行数/连接规模，`tenantId` 逻辑上是天然分片键却只当 WHERE 过滤用。

**部分好消息（已核实）：** `tenantId` 在 `server/plugins/tenant.ts:29` 单点解析；`IDatabase` 是**同步接口**（`prepare/exec/transaction/transactionRollback/queryOne/queryMany/execute/close`，无 async——SQLite/PG 都在运行时拒绝 Promise 事务回调）。所以 shard 可以在**构造时同步解析一次**，不引入 async 查询。

**关键更正（Codex 交叉审查退回，独立核实确认）：`TenantDatabase` 不是唯一的租户 DB 访问包装。** `TenantDatabase(db, tenantId)`（`tenant-os-factory.ts:110`）自动注入 `WHERE tenant_id=?` 只覆盖走它的路径；但有**一整类路由/服务直接拿裸 host DB（`os.getDatabase()`）并显式写 `... WHERE tenant_id = ?`**——不经 TenantDatabase 包装。已确认 ≥7 处：`decisions.ts:64,93`（`sharedDb=os.getDatabase()` 后 `SELECT ... FROM subscriptions WHERE tenant_id=?`）、`onboarding.ts:68`、`admin-templates.ts`、`privacy.ts`、`companion/{perceive,perceive-stream,chat}.ts`。**这类路径不会因 `TenantOSFactory` 分片而自动去正确 shard——多 shard 下会读写 host DB（错 shard）。** 故「只改 TenantOSFactory 一处路由」不足以正确分片：必须先盘清所有拿 DB 的路径，并让**每一条显式 tenant_id 访问都经统一的 `dbForTenant(tenantId)` 解析器**取正确 shard。这直接催生下面的 Phase -1。

**坏消息（agent 深掘出的三个硬问题）：**
1. **`default` 租户结构上不可分片**：20+ 路由硬编码 `tid !== 'default' → tenantFactory；否则 → 裸 host os`（`memory-facade.ts:108`、`companion/chat.ts:112`、`operations.ts:18` 等）。`default` 绕过 `TenantOSFactory`、直接绑 host DB，且它是所有未认证/companion 用户的共享桶（最热租户），却是唯一结构上挪不动的租户。
2. **跨租户聚合要 fan-out**：`/metrics` 用裸 `os.getDatabase()` 跨所有租户读（population diversity O(n²) 全量 `decision_style`、rollup SUM、tenant usage），分片后只见本 shard 的租户 → 数字静默错误。3 张平台表无 tenant_id（`event_ledger_authority` 单例、`event_ledger_consumer_checkpoints` 全局 offset、`schema_migrations` 每实例）。若干后台 worker 跨租户迭代（settlement/dual-write-flush/evidence-collector）。
3. **迁移会漏密钥**：唯一现成的租户搬迁原语是 GDPR export/import（`privacy-service.ts:434/760`，FK 有序、事务、覆盖全部租户表），但它**故意脱敏密钥**（`api_key_hash`/`llm_provider_credentials.api_key_encrypted`/OAuth token/`object_key`）——迁移用它，租户到新 shard 会 API key 全废。

**低风险确认（agent 核实）：** 无任何跨租户单事务写（compile lease/earning/workforce/marketplace 全是单租户事务，org 在租户内，wake handler drop 跨租户事件）。故**不需要分布式 2PC**——跨租户只有只读 metrics fan-out + 跨租户迭代 worker（各自 per-shard 跑即可）。

## 总体架构

**一句话：** 在 `createDatabase`/`TenantOSFactory` 之间插一个 `ShardRouter`，按 `tenantId` 一致性哈希查 `tenant_shard` 映射表 → 返回该 shard 的 `IDatabase`（per-shard 连接池，按 shard 缓存）；`TenantDatabase` 包装不变。跨租户聚合改协调层 scatter-gather；租户搬迁复用（去脱敏的）GDPR export/import。

```
request.tenantId ──► TenantOSFactory.getTenantOS(tenantId)
                        │
                        ├─ ShardRouter.dbFor(tenantId)   ← 查 tenant_shard 表（缓存）
                        │      └─ 按 shard_id 取/建 per-shard pool（按 shard 缓存，非按 tenant）
                        ▼
                     TenantDatabase(shardDb, tenantId)   ← WHERE tenant_id=? 不变
```

**协调库（coordinator DB）** 持有分片控制平面：`tenant_shard(tenant_id PK, shard_id, state)` + 平台级表（`event_ledger_authority` 等，Phase 2 决定放这或每 shard）。

## 阶段分解（依赖顺序 + 每阶段可独立交付）

### Phase -1 — DB 访问边界盘点 + `TenantDbResolver` 契约（新，Codex 退回后新增，Phase 0 前置）

**目标：** 在写任何路由机制前，先把「谁怎么拿 DB」盘清并归类，定一个统一契约——否则 Phase 0 会漏掉所有绕过 `TenantDatabase` 的显式 tenant_id store（Codex 退回的核心）。**纯盘点 + 契约定义 + 分类清单，不改运行代码。**

**产出（一份 inventory 文档 + 一个 TS 契约接口）：**
- **`TenantDbResolver` 契约（新接口，`src/storage/tenant-db-resolver.ts`）：**
  - `dbForTenant(tenantId: string): IDatabase` —— 取该租户所在 shard 的 DB（所有显式 tenant_id 访问的唯一入口）。
  - `coordinatorDb(): IDatabase` —— 取协调库（平台级表/shard map）。
  - `allShardDbs(): IDatabase[]` —— 取所有 shard（供 fan-out scatter-gather）。
  - 单 shard 缺省实现：三者都返回同一个 db（等价现状）。
- **逐项分类清单（**8 类**，每张表/每个 DB 拿点归一类）：**
  1. **租户隔离表**（有 tenant_id，走 TenantDatabase 或显式 WHERE）→ 随租户 shard，经 `dbForTenant`。
  2. **父表继承归属表**（无自己的 tenant_id，靠父表 JOIN 归属：`refresh_tokens`/`life_simulation_paths`/`shared_simulations`/`users`/`avatars`/`device_avatars`）→ 随父租户 shard，import/erase 用 JOIN 保同 shard。
  3. **平台表**（无 tenant_id，全局：`event_ledger_authority` 单例 / `event_ledger_consumer_checkpoints` 全局 offset / `schema_migrations` 每实例）→ 协调库或每实例，Phase 2 定。
  4. **全局 worker**（跨租户迭代：settlement / dual-write-flush / evidence-collector / TaskQueue.dequeue / runtime-recovery / media-retention / data-retention timer / observability worker）→ per-shard 或协调库跑，Phase 2 定。
  5. **显式 tenant_id store — per-request 型（在 request handler 作用域内当场 `os.getDatabase()`，不捕获成长生命字段/不绑子服务）**：改为 `resolver.dbForTenant(request.tenantId)`——**换 db 源即可**（小改）。**注意：这类比想象的少**——多数路由是第 6 类（见下），只有「handler 内一次性取 db 直接查」才算第 5 类。
  6. **长寿命对象捕获 root OS / root DB 型（大改；第 3 轮 Codex 扩宽定义）**：在**注册/构造期**捕获 root db（`sharedDb`）**或** root OS（后续方法里反复 `this.os.getDatabase()`），并常把子服务绑死在其上。**已确认属此类（Codex 逐一核实）：**
    - `decisions.ts:64-72`（`sharedDb` + TokenBudget/CostTracker/UsageTracker/QuotaManager/BillingOutbox）
    - **`onboarding.ts:61-76`**（同款 sharedDb + 5 子服务——**第 3 轮更正：原误归第 5 类**）
    - **`companion/chat.ts:75-84`**（注册期 sharedDb + QuotaManager——**原误归第 5 类**）
    - `memory-facade.ts:82,96,100-101`（`:221` 用 sharedDb 绕 TenantDatabase `UPDATE memory_nodes`，非 default 租户**静默写错 shard**——具名验收）
    - **`personas.ts:31-32`**（注册期 `new PersonaCoreService(os.getDatabase())` 长寿命，请求时传任意 `request.tenantId` 查——Codex 补）
    - **`privacy-service.ts:425-436,490,552,570,647,657,788`**（捕获长寿命 root `os`，方法内反复 `this.os.getDatabase()`——第四种写法，第 6 类定义须含此形态）
    - 修法：resolver 下沉 per-request + 子服务**按租户重建/重绑**（生命周期重构，工作量远大于第 5 类）。Phase 0 plan 须把第 5/6 类分开估。
  7. **模块级/全局单例 db 引用（跨请求）**：`websocket.ts:213` `eventLogDb = os.getDatabase()`（模块级单例，`:99-116` INSERT + `:126-143` SELECT `ws_event_log ... tenant_id=?`，**且 `:219-221` 起全局 prune timer**——跨请求事件背板，连 request.tenantId 都拿不到）。既非 per-request、也非普通 worker——单列（按事件 tenantId 路由，或 ws_event_log 整表归协调库）。
  8. **root-only 表**（确实无租户归属的）→ 协调库。
- **接线策略：** `createApp`/`registerXxxRoutes` 注入 `TenantDbResolver` 而非裸 `db`；第 5 类换 db 源；**第 6 类做子服务生命周期重构（decisions/onboarding/companion/personas/privacy/memory-facade 全在此列）**；第 7 类单列。

**不变量（ratchet 权威 + 第 3 轮 Codex 补机制闭合）：**
- **ratchet 是权威，不是「清单已穷尽」**：本 spec 给的是**已知样本，非声称完整**。完整性由 **ratchet 测试**保证——但**第 3 轮 Codex 指出：仅 grep `os.getDatabase()`/`db.prepare`/`new .*Database(` 三串抓不到别名传播（`tx.prepare`/`sharedTx`/`IDatabase` 字段）、构造器注入（`new Service(db)` / `buildAppServices(db)`）、长寿命 `os` 捕获**。故 ratchet 须用 **AST/类型感知或明确的 DB source/sink allowlist** 覆盖别名与构造器注入，不能只靠三条 grep。未归类即 CI 红。Phase -1 交付物含：把当前全部拿点（含上面 6 个第 6 类反例 + websocket）跑一遍并逐个归类落 allowlist。
- 单 shard 下 `TenantDbResolver` 三方法返回同一 db（零回归）。

**为什么先做这个：** 两轮独立审查证明「注入点干净」为假——decisions/memory-facade 注册期捕获 sharedDb（`memory-facade.ts:221` 已有静默错-shard 写）、websocket 模块级单例都绕过 TenantDatabase。不盘清就分片 = 部分租户数据静默留错 shard。这是整个 #3 的真正地基，且第 6/7 类揭示 Phase 0 藏着「子服务生命周期重构」，非「换 db 源」的小活。

### Phase 0 — 分片路由机制（ShardRouter + 接线 TenantDbResolver，默认单 shard 零回归）

**目标：** 落 `ShardRouter` 实现 `TenantDbResolver` 契约 + 把 Phase -1 清单里的显式 tenant_id store 接到 `dbForTenant`。默认单 shard，行为等价现状（零回归）。**范围警示（第 2 轮复审）：** 第 5 类（per-request）是换 db 源的小改；**第 6 类（注册期捕获 sharedDb + 绑子服务）是子服务生命周期重构**——工作量与风险远大于第 5 类，Phase 0 plan 须把二者分开估。具名验收用例：`memory-facade.ts:221` 的 confidence UPDATE 对非 default 租户必须落对 shard（现状静默错-shard）。

**组件：**
- **`ShardRouter`（新，`src/storage/shard-router.ts`，实现 `TenantDbResolver`）：**
  - `dbForTenant(tenantId)`：查 `tenant_shard` 映射（缺省回落一致性哈希）→ 返回该 shard 的 `IDatabase`（同步；shard 已缓存直接返回）。
  - `shardIdFor(tenantId)` 一致性哈希（稳定、不用 Math.random）；`poolFor(shardId)` 按 **shardId** 缓存 `IDatabase`（同 shard 多租户共享一池——防连接爆）。
  - `coordinatorDb()` / `allShardDbs()` 供平台表 + fan-out。
- **配置扩展（`config/schema.ts`）：** `db.shards?: Record<shardId, { connectionString }>` + `db.coordinator?: { connectionString }`。缺省（无 shards）→ 单库，`createDatabase` 不变（向后兼容）。
- **接线（两处，缺一不可）：**
  1. `tenant-os-factory.ts:111`：`new TenantDatabase(this.resolver.dbForTenant(tenantId), tenantId)`。
  2. **Phase -1 清单第 5 类的显式 tenant_id store**：从 `os.getDatabase()` 改为 `resolver.dbForTenant(request.tenantId)`（decisions/onboarding/privacy/companion 等）。这是 Codex 退回后 Phase 0 必须包含的部分。

**连接生命周期（硬约束）：** per-shard 池缓存**按 shard 键**，不按 tenant——64 缓存租户散在 N shard，池数 = 去重 shard 数，每池 `pool.max`（默认 10）。按 tenant 缓存会连接爆。

**不变量：**
1. 单 shard 下路由行为与现状字节等价（全量回归零回归）。
2. 一致性哈希稳定：同 tenantId 恒映同 shard（可复现）。
3. per-shard 池按 shard 去重缓存。
4. **2-shard 负测试（Codex 要求）：** tenant-a→shard A、tenant-b→shard B，断言 **BYOK/subscriptions/quota/usage/decision_cases/onboarding_sessions/privacy export** 全落对应 shard（不是 host DB）——这条挡住「单库假绿掩盖多 shard 错 shard」。
4. `tenant_shard` 表有映射时优先用表，无则回落哈希（表是权威、哈希是缺省）。

**YAGNI：** Phase 0 不碰 default、不改 metrics、不做迁移。只搭机制。

### Phase 1 — 解除 `default` 不可分片阻断点

**目标：** 让 `default` 能像普通租户一样走路由（否则最热租户永卡 host DB，分片无收益）。

**问题：** 20+ 处 `if (tenantFactory && tid !== 'default') return tenantFactory.getTenantOS(tid); return os;`（`memory-facade.ts:108` 等）。`default` 绕过工厂。

**方案（择一，Phase 1 spec 内定）：**
- **A（推荐，小）：** `default` 固定钉在一个「home shard」。**关键更正（Codex）：A 方案生效的前提是「root `os`（那 20+ 处 `return os` 返回的）本身就构造在 default home shard 的 DB 上」**——不是「只让 router 认识 default」。即 `createDatabase`/root OS 的 db = `resolver.dbForTenant('default')` = home shard。这样 20 处 `return os` 天然落 home shard，无需逐个改。须在 spec 内明确：home shard 与协调库是否同库（建议同库/shard 0，简化）。
- **B（大）：** 拆掉所有 `!== 'default'` 特例，`default` 经 `getTenantOS('default')` 正常路由。彻底但跨 ~23 处（20 路由 + rate-limit 等）、风险高。

**推荐 A**，但按上面更正表述：**通过「root OS 构造在 home shard DB 上」让 20 处 `return os` 自动正确**，而非声称「不动那 20 处只改 router」（那是错的——它们直接 `return os`，根本不调 router）。B 留作真需拆 companion 负载时再做。

**不变量：** root `os.getDatabase()` == home shard db；default 所有访问（含 20 处 `return os` 路径）落 home shard；companion/未认证流正常；单库下零回归。

### Phase 2 — 跨租户聚合 fan-out + 平台表归位

**目标：** 让 `/metrics` 等跨租户读在多 shard 下返回正确的全局数字，而非本 shard 局部。

**组件：**
- **协调层 scatter-gather（metrics）：** `MetricsQueryService` 从「单 db」改为「遍历所有 shard，各自查，协调层合并」：
  - SUM 类（rollup/queue/billing-outbox）→ 各 shard 求和再相加。
  - tenant usage（已按 tenant keyed）→ 各 shard 结果 concat。
  - **population diversity（O(n²) 全量 decision_style）→ 拉所有 shard 的 decision_style 行做并集，再跑 `personalityDiversity()`**（成对函数需全量人口）。
- **跨租户 worker 归类（两轮审查补全清单，逐个定 per-shard / 协调库）：** settlement-reconciliation、dual-write-flush、evidence-collector、`TaskQueue.dequeue` 全局公平调度（`task-queue.ts:102`）、runtime-recovery 全局扫超时 session（`persona-core-executors.ts:747`）、media-retention 全局扫（`media-ref-store.ts:110`）、observability worker，**+ 第 2 轮复审补漏：** `ConversationRetentionWorker`（`app.ts:525`）、`QuotaUsageRetentionWorker`（`app.ts:534`）、`ToolInvocationsRetentionWorker`（`app.ts:649`）、refresh-token cleanup timer（`app.ts:824`）、Stripe billing-outbox flush timer（`app.ts:868`，与 dual-write-flush 是两回事）、avatar autorun scheduler（`app.ts:426`）、**WebSocket event-log prune timer（`websocket.ts:219-221`，第 3 轮 Codex 补——与第 7 类同源）**、**TaskWorker 自带 poll/reaper/purge 三 timer（`task-worker.ts:64-67`，归 TaskQueue 项下但须展开）**。**每个明确 per-shard 跑或协调库跑。** 完整性同样由 ratchet（Phase -1）兜底——app.ts + 各 worker 里所有 `setInterval` 须逐个归类（不能只查 app.ts 接线）。（注：`AuditChainAnchor`/`TaskWakeReconciler`/`LearningWorker` 是每个 ChronoSynthOS 自带、随 tenant OS DB 跑的，非新 root 遗漏——Codex 澄清。）
- **平台表归位（3 张无 tenant_id）：** `event_ledger_authority`（单例）→ 协调库；`event_ledger_consumer_checkpoints`（全局 offset）→ 每 shard 或重键 `(shard, consumer_id)`；`schema_migrations` → 保持每实例（每 shard 独立跑同一迁移集，须 lockstep）。

**不变量：** metrics 全局数字 = 各 shard 之和/并集（用 2 shard 测：分别塞数据，断言聚合 = 合并值）；diversity score 在多 shard 下等于单库同数据的值。

### Phase 3 — 租户搬迁（rebalance）

**目标：** 一个租户从 shard A 挪到 B，数据完整、密钥不丢、可重跑。

**方案（复用 GDPR 机制 + 补全保真 + shard 参数化——Codex 更正「唯一差异」不完整）：**
- **两处改动，不止一处：**
  1. **全保真模式**：GDPR `exportData` 加 `mode:'migration'` 标志——**不脱敏**（导出 `api_keys.key_hash`/OAuth ciphertext/`llm_provider_credentials.api_key_encrypted`/`object_key` 原值，及必要的 token/secret 表）。
  2. **source/target shard 参数化**：`exportData` 现总用 `this.os.getDatabase()`（`privacy-service.ts:436`），`commitImport` 总写 `this.os.getDatabase()`（`:788`）——迁移须改为 `exportData({sourceDb})` / `commitImport({targetDb})`，显式传源/目标 shard DB，而非隐式 host DB。
- **cutover saga（无跨库事务 → 幂等可重跑步骤）：** `tenant_shard.state='migrating'`（冻源）→ 全保真 export(sourceDb) → import(targetDb)（`ON CONFLICT DO UPDATE` 幂等）→ 校验 → 原子翻 `tenant_shard.shard_id=B, state='active'` → erase 源 → evict OS 缓存。
- **父表继承归属子表**（`refresh_tokens`/`life_simulation_paths`/`shared_simulations` 等无自己 tenant_id 的）：import/erase 用 JOIN/子查询保同 shard（沿用 GDPR 的 `exportSql` JOIN 定义）。
- **对象存储 + KMS（Codex 补）：** `object_key` 引用随行走，但 blob 在对象存储（BYOS bucket 不变则引用仍可解，须确认）；KMS 主密钥在外部，B 进程须能访问该租户 KMS 引用解密（`tenant_key_versions` 随数据走，主密钥不在 DB）。
- **校验（Codex 补）：** 不仅校验行数，还须校验 **credential 可用性 + KMS 可解密 + 对象引用可达**。

**不变量：** 迁移后租户在 B 上功能完整（API key 可用、BYOK LLM 可用、媒体引用可解、KMS 可解密）；saga 任一步中断可重跑不损坏；迁移中租户读写被 `state='migrating'` 冻结。

## 明确不做（YAGNI，全 spec 范围）

- 不做分布式 2PC（已证实无跨租户单事务写）。
- 不做自动 rebalance 决策（Phase 3 只做「执行搬迁」，何时搬由人工/后续）。
- 不做读写分离/副本（另一条路，本 spec 不涉及）。
- 不改 `IDatabase` 同步契约（路由在构造时解析 shard，不引入 async 查询）。
- 不改业务 SQL 的**语义**、不改 `TenantDatabase` 的 WHERE 注入逻辑。（**更正：** 会改「拿 db 的来源」——把显式 tenant_id store 从 `os.getDatabase()` 换成 `resolver.dbForTenant(tenantId)`，但 SQL 文本本身不动。）

## 依赖顺序与交付

```
#4（编译锁 per-persona，PR #312 待合）
   ▼
Phase -1（DB 访问盘点 + TenantDbResolver 契约，纯盘点+分类）  ← Codex 退回后新增，真地基
   ▼
Phase 0（ShardRouter 实现契约 + 接线显式 tenant_id store，默认单库零回归）  ← 含 2-shard 负测试
   ▼
Phase 1（default 归位：root OS 构造在 home shard）+ Phase 2（fan-out + worker 归类）
   ▼
Phase 3（迁移：全保真 + shard 参数化 + KMS/对象存储校验）  ← 依赖 Phase 0 shard map
```

**Phase -1 是当前唯一独立交付**（纯盘点 + resolver 契约 + ratchet，不启用 shard 路由、不改 DB 选择，零回归）。**Phase 0 暂缓**（它含第 6 类子服务生命周期重构，不再是「低风险小改」）。Phase 1-3 待真规模信号再各自成 plan。

## 本地验证策略（全 spec）

- Phase -1：inventory 覆盖所有 `os.getDatabase()`/裸 db 拿点（grep 全量枚举 + ratchet 测试防新增未归类）。
- Phase 0：单测 ShardRouter（哈希稳定/池按 shard 缓存/单库等价）+ **2-shard 负测试（显式 tenant_id store 落对应 shard）** + 全量回归零回归。
- Phase 1：default 路由到 home shard 测试 + companion 流回归。
- Phase 2：**2 shard 集成测试**（内存 SQLite 起两个 db 当两 shard），塞数据分别落两 shard，断言 metrics 聚合 = 合并值。
- Phase 3：迁移 saga 集成测试（源→目标搬迁，校验全保真 + 幂等重跑 + 冻结）。
- 每阶段 typecheck + build + 相关回归；失败即止。

## 风险

- **高（整体）**，但**分阶段后 Phase 0 低**（默认单库、纯机制、零回归）。真风险集中在 Phase 1（跨 20 文件的 default 语义）+ Phase 2（metrics 静默错误——聚合返回局部值不报错）+ Phase 3（迁移保真 + saga 原子性）。缓解：分阶段独立交付 + 每阶段独立审查；Phase 2 的「静默错误」用 2-shard 集成测试挡（断言聚合值 = 合并值，错了就红）。
- 跨审：本 spec 交 Codex 交叉审查（Claude 生成→Codex 审）。

## 交叉审查记录（CLAUDE.md 互审规范）

- **生成:** Claude；**审查:** Codex（独立，非自审）；报告 `.claude/review-report-sharding.md`。
- **Codex 首轮:** 58/100，**退回**，品味 6/10。核实结论：「无跨租户单事务写」「迁移漏密钥」基本支持；**「注入点干净/Phase 0 不改业务 SQL」不成立**（决定性）。
- **主 AI 决策（<80 且建议退回 → 按 CLAUDE.md 直接确认退回并修）:** 接受退回。主 AI 独立复核确认 Codex 抓对——`decisions.ts:64,93` 实证 `sharedDb=os.getDatabase()` 后 `SELECT ... subscriptions WHERE tenant_id=?` 绕过 TenantDatabase，≥7 路由同款。已按 Codex 5 条改进全面修订：
  1. 【致命·已修】`TenantDatabase` 非唯一包装 → 新增 **Phase -1（DB 访问盘点 + `TenantDbResolver` 契约）** 作真地基；Phase 0 扩为「显式 tenant_id store 全接 `dbForTenant`」+ 2-shard 负测试。
  2. 【致命·已修】default A 方案表述错误 → 更正为「root OS 构造在 home shard DB 上，使 20 处 `return os` 自动正确」，非「只改 router」。
  3. 【致命·已修】迁移「全保真是唯一差异」错 → 补 source/target shard 参数化 + 父表继承子表 JOIN + 对象存储/KMS 可达性 + credential/解密校验。
  4. 【已补】跨租户 worker 清单不全 → 补 TaskQueue/runtime-recovery/media-retention/retention-timer/observability。
  5. 【已修】IDatabase 端口漏 `queryOne/queryMany/execute` → 契约须覆盖全同步端口。
- **第 2 轮复审（Codex MCP 版本不兼容失败 → 降级为独立 Claude subagent 对抗复审，守生成者≠审查者）：72/100，需讨论。** 三致命诊断已补全，但根因只消化一半——独立发现两轮都漏的：① `websocket.ts:81` 模块级单例（→ 新增第 7 类）；② 注册期捕获 sharedDb + 绑子服务这个更大重构维度 + `memory-facade.ts:221` 静默错-shard 写（→ 新增第 6 类 + 二分 + 具名验收）；③ 漏 6 个跨租户 worker（→ 补全清单）；④ 不变量「已穷尽」与样本清单自相矛盾（→ 改为 ratchet 权威）。
- **主 AI 决策（本轮修订采纳全部第 2 轮发现）：** 已加第 6/7 类 + per-request/注册期二分 + 补全 worker + ratchet 不变量重写 + memory-facade 具名验收。**交付范围决定（用户定）：只实现 Phase -1**（盘点 + `TenantDbResolver` 契约 + ratchet + 逐点归类，默认单库零回归）；Phase 0-3 待真规模信号再推。
- **降级说明:** 第 2 轮 Codex CLI 报 `gpt-5.6-sol requires a newer Codex` 两次失败，由独立 Claude subagent（opus）替代。
- **第 3 轮复审（Codex，已更新版本后成功）：82/100，需讨论（小修后可通过）。** default/迁移=已解决；注入边界/worker 清单=部分解决（方向对，仍有可复现遗漏）。**主 AI 采纳全部并小修（本轮）：** ① onboarding/companion/chat 从第 5 类**更正**到第 6 类（独立核实确认注册期捕获 sharedDb）；② 第 6 类定义扩为「长寿命对象捕获 root OS/root DB」+ 点名 personas/privacy；③ ratchet 机制补「须覆盖别名传播/构造器注入，非三条 grep」；④ 修文档错误（六类→8 类、websocket `:81`→`:213`、Phase 0「唯一低风险」矛盾→Phase -1 唯一交付/Phase 0 暂缓）；⑤ 补 websocket prune timer + TaskWorker 三 timer。**Phase -1 验收合同收紧（Codex 4 条）：稳定 ID+1-8 类归属、ratchet 防别名/构造器注入漏、resolver 仅交接口+单库适配器不接业务点、Phase -1 不承诺修错-shard bug（那在 Phase 0）。**
