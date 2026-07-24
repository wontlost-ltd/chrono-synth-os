# 租户分片 Phase 0 · Plan 3（TaskQueue + typed runtime bundle + 放开 fail-closed + 真 2-shard PG 验收）设计

**Goal:** 让分片引擎从「就位未激活（fail-closed 挡非空 shards）」变「可真多-shard 跑」——首次让生产装配 ShardRouter，用 typed runtime bundle（非可伪造布尔）作放开判据，TaskQueue 每 shard 一队列+worker，真 2-shard PG 端到端验收。**这是分片激活最后一步，也是唯一放开生产多库门的 plan，最高风险。**

**背景**：Plan 0（隔离盘点门）+1（buildResolver 注入链）+1b（appservices resolver 化）+1c（Auth mixed-scope coordinator directory）+2（worker/timer/metrics fan-out）已完成。当前引擎「就位未激活」——生产多库路径**从未被任何生产代码构造过**（`config.db.shards` 唯一消费者是 `build-resolver.ts:18` 的 fail-closed guard）。ShardRouter 只被单测直构。

## 核心设计决策

### 1. typed runtime bundle 作放开判据（非可伪造布尔）——最关键安全机制

**问题**：当前放开门 = `config.db.shards` 键存在性检查（`build-resolver.ts:18` `if (shards 非空) throw`），**无就绪证明**。若简单改成「有 shards 就建 ShardRouter」，一个连不上的 shard 会致同租户数据静默分裂。

**方案**：新建 `createShardedDatabaseRuntime(config, hostDb): { resolver: TenantDbResolver; close: () => void }`（`src/storage/sharded-database-runtime.ts`）：
1. config 嵌套 shards `{ [id]: { connectionString } }` → ShardRouter flat `{ [id]: connStr }` 映射；coordinatorConnStr 取 `config.db.coordinator?.connectionString ?? homeShard connStr`。
2. `buildDb = (connStr) => { const db = new PostgresDatabase(connStr, pool); runDslPostgresMigrations(db); return db; }`（照 factory.ts:24-28 现成模式）。
3. `new ShardRouter({ shards, homeShardId, coordinatorConnStr, buildDb, seedDbs: { [homeShardConnStr]: hostDb } })`（**default=home 铁律**：host os db 注入式 seed 进同实例，见 §4）。
4. **`router.initialize()`**（预热全 shard 池，任一 shard 连不上/迁移失败即 throw + 已建 owned 池回收）。
5. **成功才返回 `{ resolver: router, close: () => router.close() }`**——**类型即证明**：产出物是 `TenantDbResolver`（非 `boolean`），无可被误设 true 的就绪标志；initialize 失败则 throw，沿用 fail-closed。

**放开门改造（3 处 `assertShardingActivationAllowed`）**：从「非空 shards → throw」改为「非空 shards → 经 bundle 建 resolver；bundle 未产出（initialize throw）仍 fail-closed」。判据是**「有 bundle 成功产出的 resolver」**，非「config 有 shards」。单库（shards 空/undefined）路径不变（SingleDbResolver）。

**close ownership**：bundle 的 `close` 是单 owner——关 ShardRouter 的 owned 连接池（buildDb 建的），跳过 seedDbs（borrowed hostDb 由 os 关，shard-router.ts:100-111 已实现幂等 close-owned-only）。app.ts 加 `onClose` 调 `bundle.close()`。

### 2. TaskQueue 每 shard 一队列+worker（spec §3-B）

**现状**：`tasks` 表（v008，有 tenant_id）；`TaskQueue(db)` 单库；app.ts L422-501 单队列单 worker。

**方案（每 shard 独立队列+worker，非仅 enqueue 路由）**：
- **TaskQueue ctor** 从收单 `db` 改收单 `shardDb`（仍是单库实例，但由装配层为每个 shard 各建一个 TaskQueue 实例）——TaskQueue 本身保持「操作单个 db」的简单语义，**不在 TaskQueue 内做 fan-out**（避免 enqueue/dequeue 内散射的复杂度）。
- **app.ts 装配 fan-out**：`for (const shardDb of resolver.allShardDbs()) { const queue = new TaskQueue(shardDb, ...); const worker = new TaskWorker(queue, ...); worker.start(); }`——每 shard 独立 queue+worker（独立 workerId 含 shard 标识、独立 poll/reaper/purge）。各 worker 只 dequeue 自己 shard 的 task（该 shard 的 tasks 表）。
- **enqueue 路由**：caller（AvatarAutorunService/bulk-import/life_simulation route）从持单 queue 改为**持 resolver + `enqueueFor(tenantId, ...)` 按 `resolver.dbForTenant(tenantId)` 选对 shard 的 queue 入队**——task 入其 tenant 所属 shard 的队列，被该 shard 的 worker 消费（数据局部性：task 与其操作的 tenant 数据同 shard）。装配层维护 `Map<shardKey, TaskQueue>`（用 Task 2 的 makeShardKeyer）供 enqueueFor 路由。
- **TaskQueryService（get/cancel by task_id）**：task_id 不含 shard 信息——get/cancel 需按 tenantId（若 caller 有）经 dbForTenant 定位，或对 allShardDbs scatter 查（task_id 全局唯一）。定死：**优先按 tenantId 路由**（get/cancel 的 caller 均有 request.tenantId），仅无 tenantId 的管理路径 scatter。

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
- **seedDbs 注入式**：bundle 构造 `seedDbs: { [homeShardConnStr]: hostDb }`——default 租户/coordinator（若==home）复用已建 hostDb 同实例（borrowed 不关）。**注入式 seed 进同实例，非 connStr 字符串比较**（`shard-router-seed.test.ts` 已验）。不碰 `tid!=='default'` 热路径。

### 5. config schema 语义校验

`config/schema.ts` dbSchema 加 `.superRefine`：shards 非空 → `homeShardId` 必填且 ∈ shards keys；coordinator 可选（缺省=home shard connStr）。防半截配置（有 shards 无 homeShardId）静默错。

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
分片激活的**最小可用**是「显式 tenant_id 访问 + worker/timer/metrics + TaskQueue 真多-shard 跑」——这些 Plan 1b/1c/2 + 本 Plan 3 覆盖。OS 内核 carrier（PrivacyService/companion getOS）的跨 shard 是**更深的子设计**（跨 shard GDPR 事务、OS facade 每 shard 实例化），强行纳入 Plan 3 会让 app.ts 80+22 edge 面全部翻动、风险失控。Phase 0 目标是「引擎能真多-shard 跑核心路径」，OS carrier 分片是 Phase 0 后的增量。**放开 fail-closed 后，多库部署下 OS carrier 路径（privacy/companion getOS）仍走 host db（=home shard）**——对 default 租户正确，对非-home 租户的 privacy/companion 是已知 limitation（记录，非静默）。

## 验收
- 真 2-shard PG 集成测全清单绿（隔离/default 同实例/子服务/metrics/worker/TaskQueue per-shard/close ownership/initialize fail-closed）。
- 单库零回归（shards 空 → SingleDbResolver，所有现有测绿）。
- `npm run test:golden` 全门 EXIT 0（含 check:db-access——TaskQueue/AvatarAutorun/bulk-import edge 升 verified，OS carrier 保 planned 诚实）。
- 放开门安全：initialize 失败（shard 连不上）→ fail-closed 不放行（测证）。

## 破坏性
- 无新迁移（tasks 表已有 tenant_id）。
- TaskQueue ctor 语义不变（仍收单 db，装配层 fan-out）；AvatarAutorunService/bulk-import 从持 queue 改持 resolver+enqueueFor——调用点同步。
- 放开门改造：单库路径零回归；多库路径首次可用（此前 throw）。
- **已知 limitation（记录非静默）**：多库下 PrivacyService/companion getOS 的非-home 租户走 host db（=home shard）——OS carrier 分片 follow-up 前，非-home 租户的 GDPR 擦除/companion 数据可能落 home shard。Phase 0 单库部署无此问题；多库部署需知晓此 limitation 或等 follow-up。
