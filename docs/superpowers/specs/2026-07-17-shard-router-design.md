# ShardRouter 实现设计（#3 Phase 0 第一子片）

**日期:** 2026-07-17
**范围:** `src/storage/shard-router.ts`（新）、`src/storage/shard-hash.ts`（新，一致性哈希纯函数）、`src/config/schema.ts`（db.shards/db.coordinator 可选扩展）、`src/storage/factory.ts`（建 shard db）、`src/multi-tenant/tenant-os-factory.ts`（一处接线：`this.db` → resolver）
**关联:** #3 租户分片；实现 Phase -1（PR #313，已合 main）定的 `TenantDbResolver` 契约；依赖 #4 编译锁 per-persona（已合）
**状态:** Phase 0 的**第一子片**——只做路由引擎（ShardRouter）。后续子片：13 处子服务生命周期重构 / metrics fan-out（Phase 2）/ 迁移（Phase 3）。

## 背景与问题

Phase -1（已合 main）交付了 `TenantDbResolver` 契约 + `SingleDbResolver` 单库适配器 + DB-访问点盘点 allowlist + ratchet。契约定了，但**真 shard 路由（一致性哈希 + per-shard 连接池 + 多 shard 配置）尚未实现**——`SingleDbResolver` 三方法都返回同一 db。

本子片实现 `ShardRouter implements TenantDbResolver`：按 tenantId 一致性哈希路由到对应 shard 的 `IDatabase`。**默认单 shard，行为字节等价现状，零回归**；配了 shards 才启用多库。

**范围边界（已与用户确认）：** 本片只做路由引擎。接线**只动一处**——`TenantOSFactory.createTenantOS` 的 `new TenantDatabase(this.db, tenantId)` → `new TenantDatabase(resolver.dbForTenant(tenantId), tenantId)`。盘点里 13 处直接拿裸 `os.getDatabase()` 的 `longlived-root-capture` 点**本片不接**（下一子片的子服务生命周期重构才改）。**故本片单独不足以「正确多 shard」**——它是引擎先就位；多 shard 下经 TenantOSFactory 的租户 OS 内核走对 shard，那 13 处仍在 host db，须下一子片接上。这是有意的分片交付。

## 组件与数据流

### 1. `ShardRouter`（`src/storage/shard-router.ts`，实现 `TenantDbResolver`）

- 构造：`new ShardRouter(shards, coordinatorConnStr, buildDb)` —— `shards: Record<shardId, connStr>`；`buildDb: (connStr) => IDatabase`（注入建库函数，便于测试用内存 db）。
- `dbForTenant(tenantId)`：`shardIdForTenant(tenantId, sortedShardIds())` → `poolFor(shardId)`。**`default` 特判**：恒返回 `poolFor(homeShardId)`（`sortedShardIds()[0]`），对应 Phase 1 的 default 归位前置。
- `coordinatorDb()`：返回协调库 db（懒建缓存）。
- `allShardDbs()`：返回所有 shard 的 db（供后续 fan-out；懒建全部）。
- `poolFor(shardId)`：首次访问懒建 `buildDb(shards[shardId])`（内含跑迁移），**按 shardId 键缓存**（`Map<shardId, IDatabase>`）——同 shard 的多租户共享一池，**不按 tenant 缓存**（硬约束：防连接爆）。
- `close()`：关所有缓存的 shard db + 协调库。

### 2. 一致性哈希（`src/storage/shard-hash.ts`，纯函数）

- `shardIdForTenant(tenantId: string, shardIds: readonly string[]): string` = `fnv1a64(tenantId) % shardIds.length` → `shardIds[idx]`。
- 复用 #311 已在 main 的 64 位 FNV-1a 算法（`decision-style-perturbation.ts` 的 `hashSeed` 是私有 `function`，**不 reach into**——本片抽一份公用的 `fnv1a64(s): bigint` 纯函数，避免耦合内核私有实现）。
- **确定性**：同 tenantId + 同 shardIds → 同 shardId（可复现，无 `Math.random`）。`shardIds` 须**稳定排序**（`sortedShardIds()`）后再取模，否则 config 里 key 顺序变会重路由。

### 3. 配置扩展（`src/config/schema.ts`）

- `db.shards?: Record<string, { connectionString: string }>`（可选）+ `db.coordinator?: { connectionString: string }`（可选）。
- **缺省（无 shards）→ 单库**：工厂用 `SingleDbResolver(createDatabase(config))`，行为不变（向后兼容零回归）。
- 有 shards → 工厂用 `ShardRouter`。

### 4. 建 shard db（`src/storage/factory.ts`）

- 抽一个 `createShardDb(connStr, pool): IDatabase` —— 建 `PostgresDatabase` 池 + `runDslPostgresMigrations`（每 shard 独立跑同一套迁移，和现单库一致）。协调库同样建 + 迁移。
- `createDatabase(config)`（现有单库入口）不动——缺省路径仍走它。

### 5. 接线（`src/multi-tenant/tenant-os-factory.ts`，唯一一处）

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
| D. default 租户 | 钉 `sortedShardIds()[0]`（home shard） | 对应 Phase 1 default 归位前置；本片先让 `dbForTenant('default')` 明确落 home shard。 |
| 一致性哈希 | 64 位 FNV-1a（抽公用纯函数，不 reach 内核私有） | 复用 #311 已验证算法；确定性、无 Math.random、可复现。 |

## 不变量（测试必须覆盖）

1. **哈希稳定可复现**：同 tenantId + 同 shardIds → 恒同 shardId（跑多次一致）；`shardIds` 排序后取模（config key 顺序变不影响路由）。
2. **default 钉 home shard**：`dbForTenant('default')` 恒返回 `sortedShardIds()[0]` 的 db。
3. **池按 shardId 去重缓存**：同 shard 的多个租户 → 同一个 db 实例（`strictEqual`）；不同 shard → 不同 db 实例。
4. **【核心】2-shard 路由真分叉**：配两个（内存 SQLite）shard，**先用 `shardIdForTenant` 计算、从两个 shard 各挑一个真落该 shard 的 tenantId**（不假设任意字符串会分叉——用哈希算出来选），断言这两个 tenantId 的 `dbForTenant` 返回**不同** db 实例（引用比较）；且 `dbForTenant` 对同一 tenantId 恒返回其 shard 的同一 db。
5. **单库等价现状（零回归）**：无 shards 配置时工厂用 `SingleDbResolver`，`dbForTenant` 恒返回同一 db；全量回归零回归。
6. **close 关全部**：`ShardRouter.close()` 关所有缓存 shard db + 协调库（不泄漏连接）。
7. **懒建**：未访问的 shard 不建池（`poolFor` 首次访问才 `buildDb`）。

## 明确不做（YAGNI）

- 不建 `tenant_shard` 表（Phase 3 迁移才需要写入方）。
- 不接盘点里 13 处 `longlived-root-capture` 访问点（下一子片：子服务生命周期重构）。
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

- **中**。核心是多 shard 下连接池 + 路由正确。缓解：单库缺省零回归（默认路径 = SingleDbResolver，字节等价现状）+ 2-shard 负测试证明路由真分叉。**本片单独不足以「正确多 shard」**（13 处访问点未接）——有意的分片交付，spec + note 已明说「引擎先就位，访问点接线在下一子片」。次要风险：`shardIds` 未排序会致 config key 顺序变重路由——不变量 1 用「排序后取模」挡。
- 跨审：本 spec 交 Codex 交叉审查（Claude 生成 → Codex 审）。
