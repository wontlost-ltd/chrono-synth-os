# 租户分片 Phase 0 · Plan 3（TaskQueue + typed runtime bundle + 放开 fail-closed + 真 2-shard PG 验收）设计

**Goal:** 让分片引擎从「就位未激活（fail-closed 挡非空 shards）」变「可真多-shard 跑」——首次让生产装配 ShardRouter，用 typed runtime bundle（非可伪造布尔）作放开判据，TaskQueue 每 shard 一队列+worker，真 2-shard PG 端到端验收。**这是分片激活最后一步，也是唯一放开生产多库门的 plan，最高风险。**

**背景**：Plan 0（隔离盘点门）+1（buildResolver 注入链）+1b（appservices resolver 化）+1c（Auth mixed-scope coordinator directory）+2（worker/timer/metrics fan-out）已完成。当前引擎「就位未激活」——生产多库路径**从未被任何生产代码构造过**（`config.db.shards` 唯一消费者是 `build-resolver.ts:18` 的 fail-closed guard）。ShardRouter 只被单测直构。

> **第 2 轮修订（安全关键，采纳 Codex 58/100 退回 4 致命）**：① **hostDb≠homeShard 静默分裂**——config.db 有独立顶层 `connectionString`（hostDb 连它），与 `shards[homeShardId].connectionString` **可不同**；原方案盲目 seed hostDb 当 home 会伪装错误物理库。改：bundle **从各 shard 自己的 connStr 建全部 shard（含 homeShard），不 seed hostDb 当 home**（多库下 hostDb 不参与 shard 路由）。② **GDPR 跨 shard 漏擦（Art.17 合规炸弹）**——PrivacyService.eraseData 用 `this.os.getDatabase()`(host)，非-home 租户 erase 在 home 库删 0 行却返 deleted:true。改：多库激活下 **OS carrier 路径（privacy/portability/companion）对非-home 租户运行时 fail-closed（throw），非静默走 host**。③ **放开边界**——放开但 defer OS carrier 时，defer 路径必须运行时拒绝（非仅记录 limitation）。④ **3 guard 协同职责定死** + **运行期 shard 掉线显式失败不 fallback home**。

## 核心设计决策

### 0. 三处 guard 职责定死 + bundle 单 owner（第 2 轮，Codex #4）

**装配顺序 + 各 guard 新职责**（消除 void assert 证不了就绪的问题）：
- **`factory.ts` `createDatabase(config)`**：**只管单库**。`shards` 空/undefined → 建 hostDb（从 `config.db.connectionString`/path）返 `IDatabase`；`shards` 非空 → **throw**（多库不经 createDatabase 建，避免建出「伪 host」误当 shard）。这道 guard 保持 fail-closed（多库 throw）——它的职责是「单库入口」，多库归 bundle。
- **`createShardedDatabaseRuntime(config)`（新建，多库唯一装配者 + owner）**：`shards` 非空时**唯一**构造 ShardRouter 的地方。从各 shard connStr（含 homeShard 自己的 `shards[homeShardId].connectionString`）建全部 shard 池 + initialize（预热失败 throw + 回收）。**成功才返回 `{ resolver, close }`**。单库时（shards 空）返 `{ resolver: new SingleDbResolver(hostDb), close: () => {} }`（hostDb 由调用方传，os 拥有）。
- **`app.ts` createApp**：不再自建 resolver——**接收 bundle 产出的 resolver**（或单库 SingleDbResolver）；不再调 `assertShardingActivationAllowed`（放开逻辑移入 bundle）。`onClose` 调 `bundle.close()`。
- **入口装配链**：进程启动 `const bundle = createShardedDatabaseRuntime(config)`（内部：单库→createDatabase 建 hostDb 包 SingleDbResolver；多库→建全 shard ShardRouter+initialize）→ `createApp({ resolver: bundle.resolver, ... })` → 退出 `bundle.close()`。**bundle 是单 owner**：多库下拥有全 shard 池 close；单库下 hostDb 由 os 拥有 bundle close no-op。**`assertShardingActivationAllowed` 删除**（放开判据变成「bundle 能否成功 initialize 多库 ShardRouter」，非 config 键检查）。

### 1. typed runtime bundle 作放开判据（非可伪造布尔）——最关键安全机制

**问题**：当前放开门 = `config.db.shards` 键存在性检查（`build-resolver.ts:18` `if (shards 非空) throw`），**无就绪证明**。若简单改成「有 shards 就建 ShardRouter」，一个连不上的 shard 会致同租户数据静默分裂。

**方案（第 2 轮修订，签名 `createShardedDatabaseRuntime(config)` 不收 hostDb）**：
1. **单库分支**（`shards` 空）：`const hostDb = createDatabase(config)` → 返 `{ resolver: new SingleDbResolver(hostDb), close: () => {} }`。
2. **多库分支**（`shards` 非空，**唯一构造 ShardRouter 处**）：config 嵌套 `{ [id]:{ connectionString } }` → flat `{ [id]: connStr }`；coordinatorConnStr 取 `config.db.coordinator?.connectionString ?? shards[homeShardId].connectionString`。`buildDb=(connStr)=>{ const db=new PostgresDatabase(connStr,pool); runDslPostgresMigrations(db); return db; }`。`new ShardRouter({ shards, homeShardId, coordinatorConnStr, buildDb })`——**不传 seedDbs**：**homeShard 从它自己的 `shards[homeShardId].connectionString` 由 buildDb 建（owned）**，绝不 seed hostDb 当 home（**Codex #1 致命修复**：hostDb 连 `config.db.connectionString`，与 homeShard connStr 可不同，seed 会伪装错误物理库致同租户静默分裂）。多库下 hostDb 完全不参与 shard 路由。`router.initialize()`（预热全池，失败 throw + 回收 owned）。
3. **成功才返回 `{ resolver: router, close: () => router.close() }`**——**类型即证明**：产出物是 `TenantDbResolver`（非 `boolean`）。

**放开判据**：`assertShardingActivationAllowed` **删除**，放开逻辑内化进 bundle。判据 = **「bundle 多库分支能成功 initialize ShardRouter」**（全 shard 池预热通过才产出 resolver），非「config 有 shards 键」。多库 initialize 失败 → throw → 进程启动失败 = fail-closed。

**运行期 shard 掉线不 fallback（Codex #4）**：initialize 只证启动时全 shard 可连——运行期某 shard 掉线时 `dbForTenant` 返的 db 操作抛（连接错误）→ **请求显式失败，绝不 fallback home**（fallback 会错-shard 写）。此 limitation（initialize 是启动快照非运行时保证）明确记录。

**close ownership**：bundle 单 owner——多库关 ShardRouter owned 池（全 shard 含 home 都 owned，因不 seed）；单库 close no-op（hostDb os 拥有）。app.ts `onClose` 调 `bundle.close()`（shard-router.ts:100-111 幂等 close-owned-only 已实现）。

### 2. TaskQueue 每 shard 一队列+worker（spec §3-B）

**现状**：`tasks` 表（v008，有 tenant_id）；`TaskQueue(db)` 单库；app.ts L422-501 单队列单 worker。

**方案（每 shard 独立队列+worker，非仅 enqueue 路由）**：
- **TaskQueue ctor** 从收单 `db` 改收单 `shardDb`（仍是单库实例，但由装配层为每个 shard 各建一个 TaskQueue 实例）——TaskQueue 本身保持「操作单个 db」的简单语义，**不在 TaskQueue 内做 fan-out**（避免 enqueue/dequeue 内散射的复杂度）。
- **app.ts 装配 fan-out**：`for (const shardDb of resolver.allShardDbs()) { const queue = new TaskQueue(shardDb, ...); const worker = new TaskWorker(queue, ...); worker.start(); }`——每 shard 独立 queue+worker（独立 workerId 含 shard 标识、独立 poll/reaper/purge）。各 worker 只 dequeue 自己 shard 的 task（该 shard 的 tasks 表）。
- **enqueue 路由**：caller（AvatarAutorunService/bulk-import/life_simulation route）从持单 queue 改为**持 resolver + `enqueueFor(tenantId, ...)` 按 `resolver.dbForTenant(tenantId)` 选对 shard 的 queue 入队**——task 入其 tenant 所属 shard 的队列，被该 shard 的 worker 消费（数据局部性：task 与其操作的 tenant 数据同 shard）。装配层维护 `Map<shardKey, TaskQueue>`（用 Task 2 的 makeShardKeyer）供 enqueueFor 路由。
- **TaskQueryService（get/cancel by task_id）严格契约（第 2 轮，Codex #3）**：task_id 不含 shard 信息。定死：**tenant-facing get/cancel 用 `dbForTenant(request.tenantId)` + SQL `WHERE id=? AND tenant_id=?`**（双约束防越权查/取消他租户 task——caller 均有 request.tenantId）；仅无 tenantId 的**管理路径**对 allShardDbs scatter 查，**scatter 遇重复 id（多 shard 都命中同 id）→ fail-closed 抛错**（task_id 应全局唯一，重复=数据异常，不静默取首个）。
- **enqueueFor 路由契约（Codex #3）**：装配层 `Map<shardKey, TaskQueue>`（用 makeShardKeyer）。`enqueueFor(tenantId, ...)`：`const shardKey = keyer(resolver.dbForTenant(tenantId))` → `map.get(shardKey)`——**miss（无对应 queue）→ 抛错 fail-closed**（不静默丢 task）；keyer 用与装配循环同一个 keyer 实例（保证 dbForTenant 返的 db 实例映射到装配时建的 shardKey）。**dequeue 不跨 shard**：每 worker 只 dequeue 自己 shard 库的 tasks 表（task 与其 tenant 数据同 shard，enqueueFor 保证入对库）。

### 3. 真 2-shard PG 端到端验收（spec §5.3）

**基础设施**：testcontainers（`pgvector/pgvector:pg16`）+ 单 container 多 `CREATE DATABASE`（照 `_setup-pg-databases.ts` L25-28）+ `connectionUriForDatabase` 换 pathname 得独立 connStr（2 shard 库 + 可选 coordinator 库）。真 `PostgresDatabase` + `runDslPostgresMigrations` + 真 ShardRouter buildDb。

**新建 `src/test/integration/tenant-sharding-2shard-pg.test.ts`**（testcontainers，`{ skip: !容器可用 }`）验收清单：
- **隔离**：tenantA→s1、tenantB→s2（真不同 PG 库），各自读写不串（A 的数据真落 s1 库，s2 库无）。
- **default=home 同实例**：`dbForTenant('default')` 与 `coordinatorDb()`（若 coordinator==home）复用 seed 的 hostDb 同实例（非新建连接）。
- **子服务**：Identity/Avatar/Quota 等经 resolver 真落对 shard 库。
- **metrics+worker fan-out**：metrics scatter-gather 跨 2 真库聚合正确；MediaRetention/Settlement 等 worker fan-out 真 2 库各处理。
- **TaskQueue per-shard**：tenantA task 入 s1 队列被 s1 worker 消费、tenantB task 入 s2、互不串。
- **close ownership**：bundle.close() 只关 owned（s1/s2 buildDb 建的），seed hostDb 不关（os 拥有）。
- **initialize fail-closed**：某 shard connStr 无效 → initialize throw → 放开门不放行（沿用 fail-closed）。

**单测已覆盖（FakeMultiShardResolver，Plan 1b/1c/2）**：隔离/default/子服务/metrics/worker fan-out/Auth 崩溃收敛 22 个 `*-sharding.test.ts`——真 PG 端到端只需**验证真 PG 多库路由本身**（sqlite 内存 Fake 证不出真连不同库），不重复业务逻辑覆盖。

### 4. default=home 铁律 + 确定性模哈希

- **shardIdForTenant**（`shard-hash.ts`）是**确定性模哈希**（FNV-1a % N，非一致性哈希——注释 L9-10 明说；增删 shard 会重映射，本 Phase shard 集合静态故够用）。spec 用「确定性模哈希」措辞（非「一致性哈希」）。
- **default 不哈希**：`shard-router.ts:66` `tenantId==='default' → homeShardId`。
- **default→homeShard 走真 home 库（第 2 轮：不再 seed hostDb）**：多库下 bundle **不传 seedDbs**——`dbForTenant('default')→homeShardId→shards[homeShardId].connectionString` 由 buildDb 建的真 homeShard 库（owned），**非 hostDb**。default 租户与其他落 home 的租户共享同一 homeShard 池（ShardRouter per-connStr 缓存）。coordinator（若 connStr==home）经 per-connStr 缓存自动复用同实例。不碰 `tid!=='default'` 热路径。（原「seed hostDb 当 home」方案是 Codex #1 致命——已删。seedDbs 机制保留在 ShardRouter 供测试注入，生产 bundle 不用。）

### 5. config schema 语义校验

`config/schema.ts` dbSchema 加 `.superRefine`：shards 非空 → `homeShardId` 必填且 ∈ shards keys；coordinator 可选（缺省=home shard connStr）。防半截配置（有 shards 无 homeShardId）静默错。

### 6. OS carrier 非-home 租户运行时 fail-closed（第 2 轮致命修复，Codex #2/#3）

**问题**：`PrivacyService`（`privacy-service.ts:417/459/513/...` 全用 `this.os.getDatabase()`=host）、companion（getOS）、portability（export/erase）等 OS 内核 carrier **本 Plan defer 分片**（依赖 OS facade per-shard 子设计）。但**放开 fail-closed 后多库真跑**，这些路径就活了——非-home 租户调 `eraseData` 会在 host 库（=home shard 库）删 0 行却返 `deleted:true` + 记完成审计，其真实 shard 数据仍在 = **GDPR Art.17 违规（用户请求删除但数据仍在）**。「记录 limitation」不是运行时保护。

**方案（defer 路径运行时拒绝，非静默走 host）**：多库激活下，OS carrier 路径对**非-home 租户 fail-closed**——在 PrivacyService/companion/portability 的入口加守卫：
```
if (isMultiShardActive && resolver.dbForTenant(tenantId) !== resolver.dbForTenant('default')) {
  throw new ShardedCarrierNotSupportedError(tenantId, '<carrier 名>');  // 501/明确错误码
}
```
即：多库下，若该租户不落 home shard（`dbForTenant(tenantId)` 与 home 实例不同），privacy/companion/portability **明确抛错拒绝**（501 Not Implemented / 明确码），**绝不静默在 host 库执行**（那会漏擦/读错库）。落 home 的租户（default + 哈希到 home 的）仍正常（数据真在 host=home 库）。单库下守卫 no-op（dbForTenant 全返同实例）。
- **守卫落点**：PrivacyService 入口（eraseData/exportData/commitImport/startExportJob）、companion route getOS 消费点、portability 入口。守卫用注入的 resolver（这些 service 已能拿 resolver 或经 OS）判 `dbForTenant(tenantId)` vs home。
- **可观测**：拒绝时 logger.warn + metric（`shardedCarrierRejected`），运维知道哪些非-home 租户的 privacy/companion 被拒（提示需 OS carrier follow-up）。
- **诚实边界**：这不是「实现了 OS carrier 分片」——是「放开多库时，未分片的 OS carrier 对会落错库的租户明确拒绝而非静默错」。OS carrier 真分片是 follow-up；本 Plan 只保证放开不引入静默 GDPR 漏擦/读错库。

## 范围边界（关键——控制最高风险面）

### 本 Plan 含
- typed runtime bundle `createShardedDatabaseRuntime` + 放开 3 处 fail-closed 门 + close ownership。
- TaskQueue 每 shard 队列+worker + enqueue 路由（AvatarAutorunService/bulk-import/life_simulation）+ TaskQueryService 按 tenantId 定位。
- config schema superRefine。
- 真 2-shard PG 集成验收测。
- inventory：TaskQueue/AvatarAutorun/bulk-import 的 planned edge → verified（有 2-shard 覆盖后）。

### 本 Plan **不含**（明确 defer，防 app.ts 80+22 edge 面爆炸）
- **PrivacyService 大 carrier（getOS/eraseData/exportData 跨 shard GDPR）**：`privacy-service.ts` 7 条 planned edge 依赖 OS 内核 `getOS()` 的 per-shard 分片——这是 OS 内核级 carrier，与 companion getOS 同属「OS facade 分片」子设计，**留独立 follow-up**（Plan 3 后单独 brainstorm）。Phase 0 单库下 GDPR 经 host db 正确；多库下 privacy 跨 shard 擦除是 legal-hold 完整性问题，需专门设计（跨 shard 事务/补偿）。
- **companion getOS/perceive carrier**：`companion/*.ts` 的 `getOS::flow::requires-resolver-rewire`——同属 OS facade 分片，留 follow-up。
- **observability 独立进程 fan-out**：已有 DEFERRED 子 spec（`2026-07-25-...-observability-fanout-DEFERRED.md`）。
- **app.ts createApp 的 80 carrier-arg + 22 terminal-escape edge 全量 verified**：这两大 contract 覆盖几十个 route/worker 的 db 逃逸终点。Plan 3 只验证**本 Plan 触及的**（TaskQueue/AvatarAutorun/bulk-import 相关）终点升 verified；其余（依赖 OS carrier 分片的）保持 planned（诚实——未做的不标 verified）。
- **evaluateGate verified 级门实现**：当前门是 planned 级（evaluateGate 不检查 wiringStatus==='verified'）。Plan 3 **不强制升 verified 级门**（那会要求所有危险 sink verified，包括 defer 的 OS carrier）——保持 planned 级门 + inventory verified 数据标注诚实反映哪些真接线。verified 级门的实现待 OS carrier 分片完成后另议。

### defer 理由（诚实）
分片激活的**最小可用**是「显式 tenant_id 访问 + worker/timer/metrics + TaskQueue 真多-shard 跑」——这些 Plan 1b/1c/2 + 本 Plan 3 覆盖。OS 内核 carrier（PrivacyService/companion getOS）的跨 shard 是**更深的子设计**（跨 shard GDPR 事务、OS facade 每 shard 实例化），强行纳入 Plan 3 会让 app.ts 80+22 edge 面全部翻动、风险失控。Phase 0 目标是「引擎能真多-shard 跑核心路径」，OS carrier 分片是 Phase 0 后的增量。**但 defer ≠ 静默走 host——见 §6 运行时 fail-closed（Codex #2/#3 致命修复）**。

## 验收
- 真 2-shard PG 集成测全清单绿（隔离/default 同实例/子服务/metrics/worker/TaskQueue per-shard/close ownership/initialize fail-closed）。
- 单库零回归（shards 空 → SingleDbResolver，所有现有测绿）。
- `npm run test:golden` 全门 EXIT 0（含 check:db-access——TaskQueue/AvatarAutorun/bulk-import edge 升 verified，OS carrier 保 planned 诚实）。
- 放开门安全：initialize 失败（shard 连不上）→ fail-closed 不放行（测证）；hostDb≠homeShard connStr 时 default 租户经 dbForTenant 真落 homeShard 库（非 hostDb）（测证不静默分裂）。
- **OS carrier fail-closed（§6）**：多库下非-home 租户调 eraseData/exportData/companion → 抛 `ShardedCarrierNotSupportedError`（非静默 host 执行/非删 0 行返成功）；落 home 租户正常；单库 no-op（测证 GDPR 不漏擦）。

## 破坏性
- 无新迁移（tasks 表已有 tenant_id）。
- TaskQueue ctor 语义不变（仍收单 db，装配层 fan-out）；AvatarAutorunService/bulk-import 从持 queue 改持 resolver+enqueueFor——调用点同步。
- 放开门改造：单库路径零回归；多库路径首次可用（此前 throw）。
- **OS carrier 非-home 运行时拒绝（非静默走 host，§6）**：多库激活下，PrivacyService/companion/portability 对非-home 租户**明确抛错拒绝**（`ShardedCarrierNotSupportedError` 501），绝不静默在 host 库漏擦/读错库。落 home 租户正常。单库零影响。**这消除了 GDPR Art.17 漏擦风险**——非-home 租户的 erase 不会「删 0 行返成功」，而是明确拒绝（提示需 OS carrier follow-up 才支持该租户的 privacy）。多库部署方须知晓：OS carrier 分片完成前，非-home 租户不能用 privacy/companion/portability（明确拒非静默错）。
