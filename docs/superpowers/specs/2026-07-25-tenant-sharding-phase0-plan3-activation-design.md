# 租户分片 Phase 0 · Plan 3（放开生产多库门 + root-scoped carrier 下沉 + 2-shard 证明）设计

**Goal:** 让分片引擎从「就位未激活」变「可真多-shard 跑」——首次生产装配 ShardRouter（typed runtime bundle 单 owner 作放开判据），下沉剩余 root-scoped carrier（含 P0 修 PrivacyService GDPR 静默漏擦），补 2-shard 行为证明，真 2-shard PG 端到端验收。**分片激活最后一步，唯一放开生产多库门，最高风险。**

> **第 3 轮修订（采纳 Codex 67/100 退回 + 深挖分水岭事实）**：深挖确认 **TenantOSFactory 已传 `resolver.dbForTenant(tenantId)` 给每租户 ChronoSynthOS**（`tenant-os-factory.ts:110-127`）——per-tenant OS 的 ~20 内部层换 resolver 实现后**自动落对 shard，非重写内核**。故 Plan 3 真范围 = 放开门（小）+ `requires-resolver-rewire`(114) root-scoped carrier 下沉（P0=PrivacyService GDPR）+ ~200 edge 2-shard 证明（多是测试）。解决 Codex 4 致命：① bundle 不 seed hostDb 当 home（从 homeShard 自己 connStr 建）② PrivacyService GDPR 漏擦**改为 P0 代码修（下沉 dbForTenant），非 defer/501**（深挖确认 eraseData 用 root os.getDatabase() 是可修的 carrier 下沉，非需 OS facade 分片）③ 删 isMultiShardActive（守卫用实例比较）④ 统一 runtime `{defaultDb, resolver, close}` 单一 close 所有权（defaultDb=home 非 coordinator）。

## 分水岭事实（决定范围）

**TenantOSFactory 已 shard-ready**（`tenant-os-factory.ts:110-127`）：`new TenantDatabase(resolver.dbForTenant(tenantId), tenantId)` → `new ChronoSynthOS({ db: tenantDb, tenantId, ... })`。每租户 OS 及其内部 ~20 层（UpdateGate/AcceleratedLayer/MetaRegulationLayer/各 Store/getCore CoreRhythmLayer）绑该租户 shard db——**换 resolver 实现（SingleDbResolver→ShardRouter）后自动落对 shard，零内核改动**。inventory 把这 27 条标 `resolved-boundary-unproven`（语义来自构造，只欠 2-shard 证明，不欠重写）。

**真风险集中在 root-scoped carrier**：tenant-scoped 逻辑直查 **root OS db**（`main.ts:34 new ChronoSynthOS` 裸 host db=deps.os）而非经 per-tenant OS。inventory `requires-resolver-rewire`(114) 是这类主体——app.ts 3 大 root capture、PrivacyService、companion sharedDb、memory-facade sub-service。

## 核心设计决策

### 1. typed runtime bundle 作放开判据（单 owner，含 defaultDb=home）——Codex #1/#4

新建 `createShardedDatabaseRuntime(config): DatabaseRuntime`（`src/storage/sharded-database-runtime.ts`）：
```ts
interface DatabaseRuntime {
  resolver: TenantDbResolver;
  defaultDb: IDatabase;   // = resolver.dbForTenant('default')（=home shard）——供 root OS（default 租户内核）
  close(): void;          // 单 owner：关它拥有的一切
}
```
**（第 4 轮 Codex 致命修复：`rootDb` 改 `defaultDb`）**——root OS 是 `tenantId='default'`，`dbForTenant('default')=home`（default→home 铁律），故 root OS 的 db 必须是 **home shard**（`defaultDb`），**不是 coordinator**。若 root OS 用 coordinator，default 租户的 per-persona 内核（Core/UpdateGate/TaskQueue/snapshots）落 coordinator、resolver 访问的 default 数据落 home → 又静默分裂（与我上轮修的 hostDb seed 分裂同类）。**平台级代码显式用 `resolver.coordinatorDb()`**，不提供含混的「平台级/default rootDb」让消费者猜 scope。
- **单库分支**（`shards` 空）：`const hostDb = createDatabase(config)` → `{ resolver: new SingleDbResolver(hostDb), defaultDb: hostDb, close: () => {} }`（hostDb 由 os 拥有，runtime close no-op；单库 dbForTenant('default')=coordinatorDb=hostDb 同实例）。
- **多库分支**（`shards` 非空，**唯一构造 ShardRouter 处**）：config 嵌套 `{[id]:{connectionString}}` → flat `{[id]:connStr}`；coordinatorConnStr 取 `config.db.coordinator?.connectionString ?? shards[homeShardId].connectionString`；`buildDb=(cs)=>{const db=new PostgresDatabase(cs,pool); runDslPostgresMigrations(db); return db;}`；`new ShardRouter({shards, homeShardId, coordinatorConnStr, buildDb})`——**不传 seedDbs**（Codex #1：homeShard 从它自己的 `shards[homeShardId].connectionString` 由 buildDb 建 owned，绝不 seed hostDb 当 home——hostDb 连 `config.db.connectionString` 与 homeShard connStr 可不同）；`router.initialize()`（预热全池，失败 throw+回收）。**defaultDb = `router.dbForTenant('default')`（=home shard，非 coordinator）**。返 `{ resolver: router, defaultDb: router.dbForTenant('default'), close: () => router.close() }`。（coordinator 独立于 home 时是三库布局：home/shard2/coordinator——测试须用独立 coordinator+home 三库验 default→home 非 coordinator。）
- **close 所有权（Codex #4）**：**ChronoSynthOS 不再无条件 db close**——root OS 用 `new ChronoSynthOS({ db: runtime.defaultDb, ownsDb: false })`（ctor 加 `ownsDb` 缺省 true 保现状；false 时 `close()` 不下传 `this.db.close()`）。**runtime 是 db 单 owner**：多库关 ShardRouter owned 池（home=defaultDb + 其他 shard + 独立 coordinator 全 owned）；单库 hostDb os 拥有（runtime close no-op，ChronoSynthOS ownsDb=true 零回归）。**避免 os.close+runtime.close 双重关**。关闭顺序 `app.close → rootOs.close(不关 db) → runtime.close(全池各关一次)`；runtime 建成后若 OS 构造/createApp 失败须回收 runtime。
- **类型即证明**：多库 initialize 成功才产出 `DatabaseRuntime`（含真 resolver）；失败 throw=fail-closed。`assertShardingActivationAllowed` 删除，放开逻辑内化进 bundle。**无 isMultiShardActive 布尔**（Codex #3——守卫用实例比较，见 §3）。

**入口装配链**：进程启动 `const runtime = createShardedDatabaseRuntime(config)` → root OS `new ChronoSynthOS({ db: runtime.defaultDb, ownsDb: (config 单库) })` → `createApp({ os: rootOs, resolver: runtime.resolver, ... })` → 退出**进程入口**（main.ts/main-desktop.ts）注册 `runtime.close()`（createApp 拿不到 runtime——改由 main 入口 owns runtime 生命周期，createApp onClose 只 stop worker）。

**3 guard 职责（Codex #4）**：`factory.createDatabase(config)` 只管单库（shards 非空直接 throw，非调删掉的 assert——它是「单库入口」防旧路径拿多库 config 建裸 db）；`createShardedDatabaseRuntime` 多库唯一装配者+owner；`createApp` 接收 resolver+os 不自建不 assert。

### 2. root-scoped carrier 下沉（主体，inventory `requires-resolver-rewire` 114 路线图）

**P0 正确性——PrivacyService GDPR 静默漏擦（Codex #2 致命，改为代码修非 defer）**：
- `privacy-service.ts` eraseData(:513)/exportData(:459)/其余 8 处全用 `this.os.getDatabase()`(root host db)——多库非-home 租户 erase 在 host 库删 0 行却返 deleted:true（GDPR Art.17 漏擦）。
- **修（PrivacyService 是 mixed-scope，须逐 capability 路由表，非笼统「全改 dbForTenant」——第 4 轮 Codex #2 致命）**：PrivacyService ctor **加 `resolver: TenantDbResolver`**。**关键**：`TENANT_TABLES` 含 **`tenant_identity_directory`（coordinator 表，Plan 1c——email/token/key→tenant 全局目录）**——若全改 dbForTenant 会**漏擦 coordinator 目录**（shard 上同名表空，coordinator 真目录行不删→删后仍能定位该租户→GDPR 漏导/漏擦）。逐 capability 路由表：
  - **shard tenant 表**（life_simulations/decisions/avatars/... 有 tenant_id 归属该 shard）→ `resolver.dbForTenant(tenantId)`。
  - **coordinator 身份目录**（`tenant_identity_directory`）→ `resolver.coordinatorDb()`（与 Plan 1c `TenantIdentityDirectory` 同——删该租户所有 lookup 行）。
  - **persona 状态**（core）→ 已经 `getOS(tenantId)→TenantOSFactory` 落对 shard（不变）。
  - **capability 数据域最终表（第 4 轮 Codex——定死非「逐个判」）**：

    | Capability | 数据域 |
    |---|---|
    | `tenant_identity_directory` | coordinator（Plan 1c，全局查找目录） |
    | `tenant_bootstrap` | coordinator（Plan 1c，PK tenant+op 完成标记；Claude 自审补——TENANT_TABLES 含它，erase 须经 coordinatorDb 删非漏） |
    | tenant payload 表（life_sim/decisions/avatars/...） | tenant shard `dbForTenant` |
    | `import_commit_tokens` | tenant shard |
    | `export_jobs` | tenant shard |
    | tenant privacy audit（recordPrivacyAudit） | tenant shard（route 的裸 `os.getDatabase()` 改 dbForTenant；若合规定义为擦除豁免保留则明确独立 sink + 内容最小化，不与 tenant 数据一起删） |
    | tenant enterprise profile（profileService） | tenant shard `dbForTenant`（现 `new SingleDbResolver(rootDb)` 改 resolver） |
    | persona/core | TenantOSFactory `getOS(tenantId)` 对应 shard |
    | `privacy_erasure_operations` ledger | coordinator |
  - **coordinator==home 缺省快路径（第 4 轮 Codex）**：缺省 coordinatorConnStr=shards[home].connStr → `dbForTenant(tenantId)===coordinatorDb()` 同库时，eraseData **走单 DB 原子事务**（目录阻断+tenant 擦除+状态一次提交），无 saga 无多提交窗口。仅**显式独立 coordinator**（三库）才走下面的跨库 saga。
  - **跨库擦除 saga（显式独立 coordinator 时，第 4 轮 Codex 硬条件——需专属持久状态机 + 新迁移）**：eraseData 跨库非原子，须**专属持久 ledger**（**非**复用 Plan 1c 的 tenant_identity_directory——那只有 REGISTER/EMAIL_CHANGE/TOKEN/API_KEY，TenantReservationRecovery 恢复不了 privacy erasure）。**新建 coordinator 表 `privacy_erasure_operations`（新迁移，「无新迁移」仅对 coordinator==home 缺省成立；独立 coordinator 需此迁移）**：`operation_id / tenant_id / state / created_at / updated_at / retry_count / last_error`。状态机 `PENDING → DIRECTORY_DISABLED → SHARD_ERASED → DIRECTORY_CLEANED → COMPLETE`，每步 CAS 幂等；恢复 worker 扫未完成记录续做（shard 擦除重复执行安全）；**仅 COMPLETE 才返 `deleted:true` + 记 privacy.erase.completed 审计**（崩溃/超时中途绝不误报完成）。崩溃中途（如 DIRECTORY_DISABLED 后 shard 未擦）由 ledger + 恢复 worker 收敛（租户暂不可定位但 PII 未残留无记录的情况被 ledger 排除）。
- 同步 v1 privacy route + v2 portability route 的 PrivacyService 构造点传 resolver。**这是 carrier 下沉（PrivacyService 是 enterprise service 非 OS 内核层，深挖确认可下沉），非需 OS facade 分片。** 非-home 租户 erase 在其真 shard + coordinator 目录都删——不再漏擦，GDPR Art.17 真履行（非 501 拒绝、非漏 coordinator）。
- **companion 例外**：companion 的 getOS 消费（chat/perceive 等 sharedDb）**若依赖 per-tenant OS 内部状态**（非纯 tenant-scoped 表直查）则经 `getTenantOS(tenantId)`（factory 已 shard-ready 自动对）；纯 tenant-scoped 表直查（如 companion 的 subscriptions 读）下沉 dbForTenant。逐 sink 判：能经 getTenantOS 的走它，直查表的下沉。

**app.ts 3 大 root capture**：`:238 db`（组合根 host db，几十子服务/route/worker capture）、`:283`（jwtKeyStore）、`:422 queueDb`——逐消费者判：tenant-scoped → dbForTenant/getTenantOS；平台级 → coordinatorDb；worker → allShardDbs fan-out（Plan 2 已做多数）。

**memory-facade.ts**（:97 sharedDb=os.getDatabase() + 6 sub-service + subscriptions/BYOK 直查）：逐 sink 拆——sub-service tenant-scoped 下沉 dbForTenant；embedding index(:150 已用 tenantOS.getDatabase() 对)保留。

### 3. OS carrier 非-home 守卫（对暂不下沉的 carrier，实例比较无 flag）——Codex #2/#3

对本 Plan **不下沉**的 tenant-scoped root-OS carrier（若有——目标是尽量下沉，剩余的），加运行时守卫（无 isMultiShardActive 布尔）：
```ts
if (resolver.dbForTenant(tenantId) !== resolver.dbForTenant('default')) {
  throw new ShardedCarrierNotSupportedError(tenantId, '<carrier>');
}
```
单库自然相等(no-op)；多库非-home 自然不同(throw)。**优先下沉（§2）；仅无法在本 Plan 下沉的才守卫**（诚实边界：守卫是「未下沉的对会落错库的租户明确拒绝」，非合规完成——但目标是 PrivacyService 等 P0 全下沉，守卫仅兜底剩余）。

### 4. TaskQueue 每 shard 队列+worker（严格契约，Codex #3）

- app.ts 装配 fan-out：`for (const shardDb of resolver.allShardDbs()) { new TaskQueue(shardDb); new TaskWorker(...); }`——每 shard 独立 queue+worker（独立 workerId 含 shard 标识、独立 reaper/purge；两 shardId 同 connStr 只启一个，allShardDbs 已 connStr 去重）。
- **enqueueFor 路由**：装配层 `Map<shardKey, TaskQueue>`（makeShardKeyer 同一实例）。`enqueueFor(tenantId,...)`: `keyer(dbForTenant(tenantId))` → map.get → **miss 抛错 fail-closed**（不静默丢 task）。task 入其 tenant shard 队列被该 shard worker 消费（数据局部性）。
- **TaskQueryService get/cancel**：tenant-facing 用 `dbForTenant(request.tenantId)` + SQL `WHERE id=? AND tenant_id=?`（双约束防越权）；仅无 tenantId 管理路径 scatter allShardDbs，**scatter 遇重复 id fail-closed 抛错**（task_id 全局唯一，重复=异常）。

### 5. 运行期掉线不 fallback + 确定性模哈希

- initialize 只证启动时全 shard 可连——运行期 shard 掉线 `dbForTenant` 返的 db 操作抛（连接错误）→ **请求显式失败绝不 fallback home**（fallback 会错-shard 写）。ShardRouter dbForTenant 不做「连不上回退 home」。
- `shardIdForTenant`（shard-hash.ts）是**确定性模哈希 % N**（非一致性哈希，注释明说；本 Phase shard 集合静态故够用）；default 不哈希钉 homeShardId。

### 6. config schema 语义校验
dbSchema 加 `.superRefine`：shards 非空 → homeShardId 必填且 ∈ shards keys；coordinator 可选（缺省=home connStr）。防半截配置静默错。

### 7. 2-shard 证明（~200 edge，多是测试）
- `resolved-boundary-unproven`(27) 内核层：换 resolver 后自动对，加 2-shard 行为测证明（不改码）。
- `terminal-escape`(167) 逃逸终点：验证在对 shard。
- 真 2-shard PG 端到端（testcontainers 多 CREATE DATABASE，基础设施已验）：隔离/default→home 真库/子服务/metrics+worker fan-out/TaskQueue per-shard/PrivacyService GDPR 非-home 真删对 shard/close 只关 owned/initialize fail-closed。

## 范围边界

### 本 Plan 含
放开门（bundle + 3 guard）+ P0 PrivacyService GDPR 下沉 + app.ts 3 root capture 下沉 + memory-facade/companion carrier 下沉 + TaskQueue per-shard + 剩余 carrier 守卫兜底 + config superRefine + 2-shard 证明（含真 PG 端到端）。

### 拆 3 个子 plan（诚实——114 carrier + 200 证明非单次可审，Codex 建议；每中间态多库门仍关，仅 3c 末提交放开）
- **Plan 3a：runtime + ownership**——`createShardedDatabaseRuntime` bundle（`{defaultDb=home, resolver, close}` + ownsDb）+ ChronoSynthOS ctor ownsDb 标志 + config superRefine。**多库门仍关（钉死，无「或」，第 4 轮 Codex）**：**3a/3b 的生产 `main.ts/main-desktop.ts` 仍走旧 `createDatabase(config)`**（不切 runtime——若 3a 切了 runtime，多库 config 会先建池+迁移全库才在 createApp 被挡=已发生生产多库副作用）；`createApp` 最早期 `assertShardingActivationAllowed` 保留；非空 shards 仍在任何插件/worker/route 前拒绝。**bundle 多库分支只能被测试直构**（3a 单库跑生产）。
- **Plan 3b：P0 carrier 下沉**——PrivacyService mixed-scope 路由表（shard tenant 表 + coordinator 目录 + 跨库擦除序列）、app.ts 3 root capture、companion/memory-facade、TaskQueue per-shard；每批完成独立 2-shard 单测（FakeMultiShardResolver）；**多库门仍关**（下沉正确性用 Fake 证，不需真放开）。
- **Plan 3c：证明 + 原子放开**——`resolved-boundary-unproven`(27) 内核层 2-shard 证明 + 真 PG 三库（coordinator+home+shard2）端到端 + initialize/close/掉线负测；**最后一个原子提交同时**：切 `main.ts/main-desktop.ts` 到 runtime + 删 createApp 激活 assert + 保留 createDatabase 单库-only guard + 启用真生产 ShardRouter（真 PG 三库测 + golden 已先过）。任何 3a/3b 中间态生产 main 不调多库 runtime，不得放开。
- **不含**：observability 独立进程 fan-out（DEFERRED 子 spec）；OS facade 真 per-shard 实例化（若 companion 有此需求则守卫兜底 + follow-up）。

### 诚实
分片引擎（ShardRouter + resolver 契约 + TenantOSFactory 传 dbForTenant）已全就位；Plan 3 = 放开门（小）+ carrier 下沉（大但机械，inventory 已铺路线图）+ 证明。**真跑仍依赖用户部署决策**（配几 shard/connStr/coordinator）。**Plan 3 是分片激活最大单 plan，周级工作。**

## 验收
- 真 2-shard PG 端到端全清单绿。
- 单库零回归（shards 空 → SingleDbResolver + defaultDb=hostDb + ChronoSynthOS ownsDb=true 现状不变）。
- `npm run test:golden` 全门 EXIT 0（check:db-access——下沉的 carrier edge 升 verified，剩余守卫兜底的诚实标注）。
- 放开门安全：initialize 失败 → fail-closed；hostDb≠homeShard 时 default 落真 homeShard 非 hostDb（测证不静默分裂）。
- **PrivacyService GDPR（P0，三库布局验）**：独立 coordinator+home+shard2 三库，非-home 租户 eraseData 在其真 shard 删 tenant 表 **且** coordinator 删 `tenant_identity_directory` lookup 行（测证：删后 shard tenant 数据空 + coordinator 目录该租户 lookup 空 + 无法再定位该租户；非 host 漏擦、非 501、非漏 coordinator）。default→home 非 coordinator（三库验 default 内核数据落 home 库，非 coordinator 库）。

## 破坏性
- 迁移：coordinator==home 缺省无新迁移；**显式独立 coordinator 需新建 `privacy_erasure_operations` ledger 迁移（Plan 3b/3c）**（saga 崩溃恢复用）。tasks 表已有 tenant_id 无需改。
- ChronoSynthOS ctor 加 `ownsDb` 标志（缺省 true 保现状零回归；多库 root OS 传 false）。
- runtime 统一 `{defaultDb, resolver, close}`（defaultDb=home 非 coordinator）；main.ts/main-desktop.ts 入口 owns runtime.close。
- PrivacyService ctor 加 resolver + 全构造点同步；TaskQueue/AvatarAutorun/bulk-import enqueueFor 路由。
- 放开门：单库零回归；多库首次可用。
- **已消除 Codex 致命**：hostDb 不 seed 当 home（无静默分裂）；PrivacyService GDPR 真下沉（无漏擦，非 501）；无 isMultiShardActive 布尔；runtime 单一 close 所有权（无双重关）。
