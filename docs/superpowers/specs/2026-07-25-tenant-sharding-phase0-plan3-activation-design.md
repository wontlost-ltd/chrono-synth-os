# 租户分片 Phase 0 · Plan 3（放开生产多库门 + root-scoped carrier 下沉 + 2-shard 证明）设计

**Goal:** 让分片引擎从「就位未激活」变「可真多-shard 跑」——首次生产装配 ShardRouter（typed runtime bundle 单 owner 作放开判据），下沉剩余 root-scoped carrier（含 P0 修 PrivacyService GDPR 静默漏擦），补 2-shard 行为证明，真 2-shard PG 端到端验收。**分片激活最后一步，唯一放开生产多库门，最高风险。**

> **第 3 轮修订（采纳 Codex 67/100 退回 + 深挖分水岭事实）**：深挖确认 **TenantOSFactory 已传 `resolver.dbForTenant(tenantId)` 给每租户 ChronoSynthOS**（`tenant-os-factory.ts:110-127`）——per-tenant OS 的 ~20 内部层换 resolver 实现后**自动落对 shard，非重写内核**。故 Plan 3 真范围 = 放开门（小）+ `requires-resolver-rewire`(114) root-scoped carrier 下沉（P0=PrivacyService GDPR）+ ~200 edge 2-shard 证明（多是测试）。解决 Codex 4 致命：① bundle 不 seed hostDb 当 home（从 homeShard 自己 connStr 建）② PrivacyService GDPR 漏擦**改为 P0 代码修（下沉 dbForTenant），非 defer/501**（深挖确认 eraseData 用 root os.getDatabase() 是可修的 carrier 下沉，非需 OS facade 分片）③ 删 isMultiShardActive（守卫用实例比较）④ 统一 runtime `{rootDb, resolver, close}` 单一 close 所有权。

## 分水岭事实（决定范围）

**TenantOSFactory 已 shard-ready**（`tenant-os-factory.ts:110-127`）：`new TenantDatabase(resolver.dbForTenant(tenantId), tenantId)` → `new ChronoSynthOS({ db: tenantDb, tenantId, ... })`。每租户 OS 及其内部 ~20 层（UpdateGate/AcceleratedLayer/MetaRegulationLayer/各 Store/getCore CoreRhythmLayer）绑该租户 shard db——**换 resolver 实现（SingleDbResolver→ShardRouter）后自动落对 shard，零内核改动**。inventory 把这 27 条标 `resolved-boundary-unproven`（语义来自构造，只欠 2-shard 证明，不欠重写）。

**真风险集中在 root-scoped carrier**：tenant-scoped 逻辑直查 **root OS db**（`main.ts:34 new ChronoSynthOS` 裸 host db=deps.os）而非经 per-tenant OS。inventory `requires-resolver-rewire`(114) 是这类主体——app.ts 3 大 root capture、PrivacyService、companion sharedDb、memory-facade sub-service。

## 核心设计决策

### 1. typed runtime bundle 作放开判据（单 owner，含 rootDb）——Codex #1/#4

新建 `createShardedDatabaseRuntime(config): DatabaseRuntime`（`src/storage/sharded-database-runtime.ts`）：
```ts
interface DatabaseRuntime {
  resolver: TenantDbResolver;
  rootDb: IDatabase;      // 平台级/default 租户 db（明确 scope + 单一所有权）
  close(): void;          // 单 owner：关它拥有的一切
}
```
- **单库分支**（`shards` 空）：`const hostDb = createDatabase(config)` → `{ resolver: new SingleDbResolver(hostDb), rootDb: hostDb, close: () => {} }`（hostDb 由 os 拥有，runtime close no-op；rootDb=hostDb）。
- **多库分支**（`shards` 非空，**唯一构造 ShardRouter 处**）：config 嵌套 `{[id]:{connectionString}}` → flat `{[id]:connStr}`；coordinatorConnStr 取 `config.db.coordinator?.connectionString ?? shards[homeShardId].connectionString`；`buildDb=(cs)=>{const db=new PostgresDatabase(cs,pool); runDslPostgresMigrations(db); return db;}`；`new ShardRouter({shards, homeShardId, coordinatorConnStr, buildDb})`——**不传 seedDbs**（**Codex #1 致命修复**：homeShard 从它自己的 `shards[homeShardId].connectionString` 由 buildDb 建 owned，绝不 seed hostDb 当 home——hostDb 连 `config.db.connectionString` 与 homeShard connStr 可不同）；`router.initialize()`（预热全池，失败 throw+回收）。**rootDb = `router.coordinatorDb()`**（多库下平台级/default 落 coordinator，若 coordinator==home 则 per-connStr 缓存复用同实例）。返 `{ resolver: router, rootDb: router.coordinatorDb(), close: () => router.close() }`。
- **rootDb 与 close 所有权（Codex #4）**：**ChronoSynthOS 不再自建 db close**——root OS 用 `new ChronoSynthOS({ db: runtime.rootDb, ownsDb: false })`（ChronoSynthOS ctor 加 `ownsDb` 标志，false 时 close 不下传 db.close）。**runtime 是 db 单 owner**：多库关 ShardRouter owned 池（含 rootDb=coordinator，若 owned）；单库 hostDb 由 os 拥有（runtime close no-op，此路径 ChronoSynthOS ownsDb=true 保持现状零回归）。**避免 os.close + runtime.close 双重关同一 db**。
- **类型即证明**：多库 initialize 成功才产出 `DatabaseRuntime`（含真 resolver）；失败 throw=fail-closed。`assertShardingActivationAllowed` 删除，放开逻辑内化进 bundle。**无 isMultiShardActive 布尔**（Codex #3——守卫用实例比较，见 §3）。

**入口装配链**：进程启动 `const runtime = createShardedDatabaseRuntime(config)` → root OS `new ChronoSynthOS({ db: runtime.rootDb, ownsDb: config 单库 })` → `createApp({ os: rootOs, resolver: runtime.resolver, ... })` → 退出**进程入口**（main.ts/main-desktop.ts）注册 `runtime.close()`（createApp 不声称拥有 runtime close——Codex 指出 createApp 拿不到 bundle；改由 main 入口 owns runtime 生命周期，createApp onClose 只 stop worker）。

**3 guard 职责（Codex #4）**：`factory.createDatabase(config)` 只管单库（shards 非空直接 throw，非调删掉的 assert——它是「单库入口」防旧路径拿多库 config 建裸 db）；`createShardedDatabaseRuntime` 多库唯一装配者+owner；`createApp` 接收 resolver+os 不自建不 assert。

### 2. root-scoped carrier 下沉（主体，inventory `requires-resolver-rewire` 114 路线图）

**P0 正确性——PrivacyService GDPR 静默漏擦（Codex #2 致命，改为代码修非 defer）**：
- `privacy-service.ts` eraseData(:513)/exportData(:459)/其余 8 处全用 `this.os.getDatabase()`(root host db)——多库非-home 租户 erase 在 host 库删 0 行却返 deleted:true（GDPR Art.17 漏擦）。
- **修**：PrivacyService ctor **加 `resolver: TenantDbResolver`**；eraseData/exportData/commitImport/startExportJob/LegalHoldService 构造全改 `resolver.dbForTenant(tenantId)`（tenant-scoped 数据在其 shard 真删/真导）；平台级 export job 表若无 tenant_id 归 coordinator。同步 v1 privacy route + v2 portability route 的 PrivacyService 构造点传 resolver。**这是 carrier 下沉（PrivacyService 是 enterprise service 非 OS 内核层，深挖确认可下沉），非需 OS facade 分片。** 非-home 租户 erase 在其真 shard 删——不再漏擦，GDPR Art.17 真履行（非 501 拒绝）。
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

### 本 Plan 分批（诚实——114 carrier + 200 证明是大工程）
Plan 3 拆多批 SDD task 逐类下沉（P0 PrivacyService/app root 先 → companion/memory-facade → 证明）。**不含**：observability 独立进程 fan-out（DEFERRED 子 spec）；OS facade 真 per-shard 实例化（若 companion 有此需求则守卫兜底 + follow-up）。

### 诚实
分片引擎（ShardRouter + resolver 契约 + TenantOSFactory 传 dbForTenant）已全就位；Plan 3 = 放开门（小）+ carrier 下沉（大但机械，inventory 已铺路线图）+ 证明。**真跑仍依赖用户部署决策**（配几 shard/connStr/coordinator）。**Plan 3 是分片激活最大单 plan，周级工作。**

## 验收
- 真 2-shard PG 端到端全清单绿。
- 单库零回归（shards 空 → SingleDbResolver + rootDb=hostDb + ChronoSynthOS ownsDb=true 现状不变）。
- `npm run test:golden` 全门 EXIT 0（check:db-access——下沉的 carrier edge 升 verified，剩余守卫兜底的诚实标注）。
- 放开门安全：initialize 失败 → fail-closed；hostDb≠homeShard 时 default 落真 homeShard 非 hostDb（测证不静默分裂）。
- **PrivacyService GDPR（P0）**：多库非-home 租户 eraseData 在其真 shard 删（非 host 漏擦、非 501 拒绝），测证真删对 shard。

## 破坏性
- 无新迁移。
- ChronoSynthOS ctor 加 `ownsDb` 标志（缺省 true 保现状零回归；多库 root OS 传 false）。
- runtime 统一 `{rootDb, resolver, close}`；main.ts/main-desktop.ts 入口 owns runtime.close。
- PrivacyService ctor 加 resolver + 全构造点同步；TaskQueue/AvatarAutorun/bulk-import enqueueFor 路由。
- 放开门：单库零回归；多库首次可用。
- **已消除 Codex 致命**：hostDb 不 seed 当 home（无静默分裂）；PrivacyService GDPR 真下沉（无漏擦，非 501）；无 isMultiShardActive 布尔；runtime 单一 close 所有权（无双重关）。
