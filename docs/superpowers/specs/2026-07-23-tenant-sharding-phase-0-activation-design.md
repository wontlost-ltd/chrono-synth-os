# 租户分片 Phase 0 全量激活设计

> 状态：待用户审阅 → writing-plans。
> 日期：2026-07-23
> 关联：分片设计总览 `2026-07-17-tenant-sharding-design.md`（Phase 0 契约在此定）；`shard-router-design.md`（引擎设计）；规模化缺口 #3；PR #314（子服务双入口化，已合入 main）。
> 范围：`src/server/app.ts`（组合根装配 resolver）、7 个 `sharedDb` 直用文件、`src/server/routes/metrics.ts` + `src/observability/`（fan-out）、`src/storage/factory.ts`（放开 fail-closed）、`src/config/schema.ts`（shard map 校验）、`src/storage/db-access-inventory.ts`（接线完成后重分类）。

## 1. 目标（一句话）

把分片引擎从「就位未激活」（`createDatabase` fail-closed 拒绝任何非空 `db.shards`）变为**可真多-shard 运行**：所有「显式 tenant_id 访问」经统一的 `TenantDbResolver.dbForTenant(tenantId)` 路由到正确 shard；跨租户聚合经 `allShardDbs()` fan-out；平台表经 `coordinatorDb()`；然后放开 fail-closed，用真 2-shard PG 验收「两租户落不同 shard、各自读写不串、default 落 home shard、metrics 汇总正确」。

## 2. 关键发现（改变风险判断——核验真实代码）

设计总览把 Phase 0 标为「高风险第 6 类子服务生命周期重构，暂缓」。**核验后风险显著低于此判断**：

- **子服务已 shard-ready**（PR #314 双入口化做完硬骨头）：`TokenBudget/CostTracker/UsageTracker/QuotaManager/BillingOutbox` 的 `fromResolver(resolver)` 内部是 `{ forTenant: (t) => resolver.dbForTenant(t) }`——**运行时按 tenantId 解析 db**（`token-budget.ts:59` 实证）。它们唯一问题是被喂 `new SingleDbResolver(sharedDb)`（忽略 tenantId 的单库适配器），而非**同一个共享 `ShardRouter`**（按 tenantId 路由）。
- **`TenantOSFactory` 主路由点已 resolver 化**：`getTenantOS` 走 `new TenantDatabase(this.resolver.dbForTenant(tenantId), tenantId)`（`tenant-os-factory.ts:111`）。
- **`ShardRouter` 引擎完整**（`shard-router.ts`）：per-connStr 缓存、幂等 close、init 失败回收、`default→homeShardId`、`allShardDbs()` 去重。

**故激活 ≠ 生命周期重写，而是三件确定性工作**：A 穿 resolver、B 改 route 内 `sharedDb` 直用、C 放开 fail-closed + 验收。真实工作量 = **7 个 `sharedDb` 文件** + metrics fan-out + 组合根装配。

## 3. 三块范围（A / B / C）

### A. 注入链统一：一个 resolver 穿全链

**组合根 `app.ts` 建唯一 `TenantDbResolver`**（按 config 分单/多库）：

```typescript
// app.ts（装配处，约 line 294-300 附近）
const hostDb = deps.db ?? deps.os.getDatabase();
// 单库（现状 / 测试）：SingleDbResolver(hostDb)——零回归。
// 多库（config.db.shards 非空）：ShardRouter，home shard 钉 = host os 的 db（见 §4 default 不变量）。
const resolver: TenantDbResolver = buildResolver(config, hostDb, deps.os);
```

- `buildResolver`（新，`src/storage/build-resolver.ts` 或并入 factory）：
  - `config.db.shards` 空 → `new SingleDbResolver(hostDb)`（等价现状）。
  - 非空 → `new ShardRouter({ shards, homeShardId, coordinatorConnStr, buildDb: (connStr) => <建同款 PostgresDatabase + 跑迁移> })`，且**约束 home shard 的 connStr 解析出的 db === hostDb 的 connStr**（见 §4 default 不变量；用同一 `buildDb` 复用池，`ShardRouter` 按 connStr 去重天然满足）。
- 这**一个** `resolver` 实例穿进：`new TenantOSFactory(resolver, ...)` + 每个 `registerXxxRoutes(app, os, config, db?, tenantFactory?, resolver)`（route 签名加 `resolver` 参）。
- **替换所有 `new SingleDbResolver(sharedDb)` 局部构造**（decisions/onboarding/chat/perceive/perceive-stream/learn-github 等 7+ 处）为传入的共享 `resolver`。子服务 `fromResolver(config, resolver)` 从此按 tenantId 路由。

> 注：route 已有 `db?`/`tenantFactory?` 可选参惯例（app.ts 装配时穿）；`resolver` 同款加为可选参，缺省 `new SingleDbResolver(os.getDatabase())`（保测试/直调兼容），app.ts 装配时穿真 resolver。

### B. inventory 各类接线到正确入口

按 `db-access-inventory.ts` 的 8 类逐类接线（ratchet 是完整性 oracle）：

| 类 | 数量 | 接线到 | 具体动作 |
|---|---|---|---|
| `tenant-isolated` | 7 | `dbForTenant` | 多经 TenantOSFactory 已路由；route 内 `new XxxStore(sharedDb, tenantId)` → `new XxxStore(resolver.dbForTenant(tenantId), tenantId)` |
| `longlived-root-capture` | 13 | `dbForTenant`（子服务）+ route 内直用改 resolver | A 段穿 resolver 覆盖子服务；route 内 `sharedDb.prepare(...WHERE tenant_id=?)`（decisions/onboarding subscriptions/BYOK 读）→ `resolver.dbForTenant(tenantId).prepare(...)` |
| `explicit-per-request` | 6 | `dbForTenant` | handler 内一次性取 db，换源 |
| `platform-table` | 1 | `coordinatorDb` | 无 tenant_id 全局表 → 协调库 |
| `root-only` | 5 | `coordinatorDb` | 确无租户归属 → 协调库 |
| `global-worker` | 1 | `allShardDbs` per-shard 跑 或 `coordinatorDb` | 跨租户迭代 worker：每 shard 各跑一遍 |
| `module-singleton` | 1 | 单列评估 | 模块级单例 db 引用——评估是否可 resolver 化，不能则记 known-limitation |
| `root-only`（app.ts 装配） | — | 建 resolver | A 段覆盖 |

**具名验收点（inventory 已点名）**：
- `memory-facade.ts:221`：绕 TenantDatabase 的 id-based `UPDATE memory_nodes`（写置信度元数据）——用 `sharedDb` 是为绕 WHERE-rewrite，但 `sharedDb`=单库→多 shard 错库。改 `resolver.dbForTenant(tenantId)`（仍 id-based 绕 WHERE-rewrite，但落对 shard）。
- `metrics.ts:43`：`new MetricsQueryService(os.getDatabase())` 跨租户读（population diversity、rollup SUM、tenant usage）——见 §5 fan-out。

### C. 放开 fail-closed + 真 2-shard 验收

- A+B 接线完 + 契约测试证「无遗漏的 `sharedDb`/`os.getDatabase()` 直用于 per-tenant 访问」后，把 `factory.ts` 的 fail-closed guard 换成放开：`config.db.shards` 非空时不再抛，而是（由 app.ts）建 `ShardRouter`。
- **createDatabase 与 resolver 建立的边界**：`createDatabase` 仍只建**单个 host db**（home shard 的物理库 + 跑迁移）；多 shard 的其余 shard 由 `ShardRouter.buildDb` + `initialize()` 建+迁移。guard 从「拒非空 shards」改为「非空 shards 时要求 app.ts 已装配 ShardRouter」——即把运行时约束从 createDatabase 上移到组合根装配完整性。
- 真 2-shard PG 验收（集成测试，见 §7）。

## 4. default 租户不变量（关键，采纳「host os 即 home shard」）

现状 23 处 `getOS()`：`if (tid !== 'default') return factory.getTenantOS(tid); return os;`——default 返回裸 host `os`（绑 host db），其他租户走 factory。

**不改这 23 处热路径**。而是在组合根钉死不变量：**host `deps.os` 的 db === `ShardRouter` 的 home shard db**（`ShardRouter.dbForTenant('default')` 已钉 `homeShardId`）。这样：
- default → 裸 os → host db = home shard db ✓
- default 若某处经 factory（如 `getTenantOS('default')`）→ `resolver.dbForTenant('default')` → home shard db ✓（同一物理库，`ShardRouter` 按 connStr 去重返同实例）

两路径天然一致，**无需碰 23 处热路径**。约束的落地：`buildResolver` 构造 ShardRouter 时，`shards[homeShardId]` 的 connStr 必须与 `createDatabase` 建 host db 用的 connStr 相同（config 校验，§6）。

## 5. 跨租户 fan-out（metrics + global-worker）

分片后单 shard 只见本 shard 租户，跨租户聚合静默错。改 scatter-gather：

- `MetricsQueryService` 从 `new MetricsQueryService(os.getDatabase())` 改为接 `resolver.allShardDbs()`——对每个 shard db 各查一遍，**协调层合并**：
  - population diversity（跨租户 `decision_style` 群体统计）：各 shard 收集 decision_style 行 → 合并后算多样性（不是各 shard 算完再平均——那口径错）。合并语义在 plan/Task 定义并测。
  - rollup SUM / tenant usage COUNT：各 shard SUM/COUNT → 相加。
- `global-worker`（1 个跨租户迭代 worker）：改 per-shard 各跑一遍（`for (const db of resolver.allShardDbs())`）。
- **单库下 `allShardDbs()` 返 `[db]`**，fan-out 退化为单库查询，零回归。

## 6. 配置校验（`config/schema.ts`）

- `db.shards: Record<shardId, connStr>` + `db.homeShardId: string` + `db.coordinatorConnStr?: string`（已在 ShardRouterConfig，schema 补校验）。
- **校验**：`shards` 非空时 `homeShardId ∈ shards`（ShardRouter ctor 已查，schema 提前到启动校验给清晰错误）；`shards[homeShardId]` 的 connStr 与 `db.connectionString`（host db）一致（§4 不变量）——不一致 → 启动拒。
- 单库（`shards` 空）：现有 `db.connectionString`/`db.path` 路径不变。

## 7. 可验证性（真 2-shard 验收是核心）

- **2-shard 隔离（集成，真 PG 或 2 个内存 sqlite 模拟 shard）**：config 配 2 shard，租户 A 哈希落 shard-0、租户 B 落 shard-1（构造已知落点的 tenantId）→ A 写记忆 → 断言 shard-1 库查不到 A 的记忆、shard-0 查得到；B 反之。**跨 shard 不串**。
- **default 落 home shard**：default 写数据 → 断言落 home shard db（= host db），非其他 shard。
- **子服务 per-tenant 路由**：TokenBudget/QuotaManager 对 A、B 各计量 → 断言各自落各自 shard（不串账）。
- **fan-out 正确**：A 在 shard-0、B 在 shard-1 各有 decision_style → metrics population diversity 断言 = 2（跨 shard 合并），非各 shard 看到的 1。
- **单库零回归**：`shards` 空时全链行为与现状 `assert.deepEqual` 等价（SingleDbResolver 路径）——**现有全套测试仍绿**是硬门。
- **ratchet 完整性**：`check-db-access-ratchet.mjs` 绿——无未归类/未接线的 per-tenant db 拿点。接线完成后 inventory 各点 note 更新为「已接 resolver」，ratchet 断言无 `sharedDb` 直用于 per-tenant 访问的残留（新增契约断言，见约束）。
- **fail-closed 放开后仍守单库**：`shards` 非空但 app.ts 未装配 ShardRouter（误配）→ 仍拒启动（guard 上移到装配完整性）。

## 8. 全局约束（每个实现任务隐含遵守）

1. **隔离铁律不可破**：任一 per-tenant 访问漏接 resolver = 静默错-shard 数据分裂。ratchet + 2-shard 集成测试是双重网。**宁可 fail-closed 不放开，也不带漏接线放开**。
2. **单库零回归**：`shards` 空时全链等价现状，现有全测试绿是硬门（SingleDbResolver 三方法返同一 db）。
3. **default = home shard 不变量**：组合根钉死 host db = home shard db；config 校验 connStr 一致。
4. **fan-out 口径正确**：跨租户聚合的合并语义（diversity 合并行后算、SUM/COUNT 相加）在 Task 定义并测——不是各 shard 算完平均。
5. **无分布式事务**：已核实无跨租户单事务写（总览确认），fan-out 只读、worker per-shard——不引入 2PC。
6. **中文注释**（项目规范）；改动经 `test:golden` 全门（含 ratchet + parity + route-schema 快照）。
7. **迁移在每 shard 跑**：`ShardRouter.buildDb` 建 shard db 时跑同款 DSL 迁移（每 shard 独立 `schema_migrations`）——不新增迁移，复用现有迁移在多库各跑一遍。

## 9. 分片（供 writing-plans）

- **Plan 1（A 注入链统一）**：`buildResolver` + app.ts 装配唯一 resolver + route 签名加 `resolver` 参 + 替换 7 处 `new SingleDbResolver(sharedDb)` 为共享 resolver + 子服务经 resolver。**fail-closed 仍挡**（不放开），单库零回归验。可独立交付、独立验（现有测试全绿 + 新增「resolver 穿透」断言）。
- **Plan 2（B route 内直用 + fan-out）**：7 个 `sharedDb` 文件的 route 内 `sharedDb.prepare/new XxxStore(sharedDb,...)` → `resolver.dbForTenant(tenantId)`（含 memory-facade:221 具名点）；metrics + global-worker fan-out（`allShardDbs`）；inventory note 更新 + ratchet 契约加固。仍 fail-closed 挡，单库零回归。
- **Plan 3（C 放开 + 2-shard 验收）**：config schema 校验（home=host 不变量）；fail-closed guard 上移到装配完整性；真 2-shard 集成测试（隔离/default/子服务/fan-out）；放开生产多库。

## 10. 非目标（YAGNI）

- 不做租户搬迁（rebalance/迁移到新 shard）——那是 Phase 1（总览里的 GDPR-import 去脱敏复用）；本 Phase 只做「新租户按哈希落 shard + 各 shard 内正确读写」。
- 不做协调库独立部署——`coordinatorDb` 单库下 = host db，多库下可 = home shard 或独立库（config 决定），本 Phase 不强制独立协调库。
- 不做 AST 级 source/sink 完整覆盖（ratchet 仍文件级 + 契约断言兜底）——是后续增强。
- 不改 default 租户的 23 处热路径（§4 靠不变量而非改路径）。
- 不引入分布式事务（§8.5）。
