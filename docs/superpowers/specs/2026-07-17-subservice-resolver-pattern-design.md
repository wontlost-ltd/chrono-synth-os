# 子服务接 TenantDbResolver 模式 + 多-shard 验收脚手架 设计

> **状态**：设计已定（Codex 第 2 轮复审采纳，76→待复审），待 writing-plans。
> **归属**：#3 租户分片 Phase 0 —— 「12 访问点接线」sub-phase 的**首个实现子片**（立模式 + 立验收方法）。
> **前置**：ShardRouter 子片（PR #314，`TenantDbResolver`/`SingleDbResolver`/`ShardRouter` 契约已合入）。

## 背景与问题

项目每租户一个 `ChronoSynthOS` 实例，`TenantOSFactory.getTenantOS(tenantId)` 已把 `resolver.dbForTenant(tenantId)` 包成 `TenantDatabase` 灌进去——凡走 `tenantOS.getDatabase()` 的访问点**已自动 shard-aware**（Task 4 已接）。

但一批 route 在**注册期直接抓 root db**（`sharedDb = db ?? os.getDatabase()`），把它塞进子服务（`QuotaManager`/`TokenBudget`/`PersonaCoreService` 等）构造器，然后 per-request 对这个 root db 跑租户查询。侦察确证：**这些子服务全是「db 进构造、tenantId 进方法」模式，持单一 db 实例做参数化查询**。即使 route 层换对 db 源，多库下子服务仍只查那一个库——**真正的分片能力缺口在子服务内部**。

单库下 root db = 唯一库，一切能跑；多库下 root db = 协调库、租户数据在别 shard → **静默错-shard**。

## 本子片的范围（YAGNI）

**只做**：把**一个典型子服务**（`QuotaManager`）改造为支持「持 `TenantDbResolver`、per-tenant 走 `dbForTenant`、cross-tenant 走 `allShardDbs` fan-out」，并建**可复用的多-shard 探针验收脚手架**。此片立起模式与验收方法，后续子服务批量套用。

**关键约束（Codex 复审采纳）**：`QuotaManager` 有 **20+ 个构造点**（不止 route——含 billing/plans、entitlement-service、memory-facade、life-simulations、companion/me、app.ts 多处、大量测试），传入类型**混杂**：route 层是 `IDatabase`（`sharedDb`/`sharedTx`/`queueTx`），billing/entitlement 是 `SyncWriteUnitOfWork`（`this.tx`，已在事务上下文里）。**不能只改 route 构造点**——构造器签名一变，所有构造点编译红。且不能强行把已绑事务的 `SyncWriteUnitOfWork` 当 db 源重新解析（会脱离事务）。

**解法：双入口过渡契约**（见下「签名变更」），一次覆盖所有构造点、不留编译错、诚实区分两种语义。

**不做**（归后续子片）：
- app.ts 把 resolver 真正穿到 route 层（本片 route 构造点用 `SingleDbResolver` 包裹，等价现状）。
- 其余子服务（TokenBudget/CostTracker/UsageTracker/BillingOutbox/PersonaCoreService/PersonaTemplateService）的改造。
- default 租户走根实例绕过 resolver 的缝隙。
- privacy-service 跨表 GDPR 事务的跨-shard 原子性难题。
- 同批 route 里其它裸用 `sharedDb` 的租户查询（`sharedDb.prepare('SELECT ... subscriptions ...')`、`sharedDb.execute(perceptionEventInsert)` 等）——**这些 route 本片后仍非整体 shard-safe**，明确留后续子片。

## 为什么选 QuotaManager 作首个标本

1. **覆盖面最广**：在全部 route 层配额点出现。
2. **构造只吃 db/tx**：无租户绑定，改造干净。
3. **一个类里同时有两种范式**（关键）：
   - **per-tenant 方法**（`setLimit`/`clearLimit`/`checkQuota`/`consumeQuota`/`recordUsage`）——首参即 `tenantId` → `dbForTenant(tenantId)`。
   - **cross-tenant 方法**（`pruneUsageBefore(now, cutoff, batchSize)`——**无 tenantId**）→ `allShardDbs()` fan-out。
   两种范式一次立全，是模式的完整标本。

## 前置修正：`ShardRouter.allShardDbs()` 去重（Codex 采纳，独立提交）

**Bug**：`shard-router.ts:60-61` `Object.values(this.shards).map((c) => this.dbForConn(c))`——若两个 shardId 映射到**同一 connStr**，`dbForConn` 返回同一实例，但 `.map` 把它放进数组**两次**。fan-out 消费方会对同一物理库执行两次（prune 删两遍、计数翻倍）。

**修法**：`allShardDbs()` 语义应为「所有**唯一**物理 db」。按 connStr 去重后再 map：

```
allShardDbs(): IDatabase[] {
  const seen = new Set<string>();
  const out: IDatabase[] = [];
  for (const connStr of Object.values(this.shards)) {
    if (seen.has(connStr)) continue;
    seen.add(connStr);
    out.push(this.dbForConn(connStr));
  }
  return out;
}
```

- 稳定顺序（按 shards 声明顺序首次出现）。
- 这是已合入引擎（PR #314）的小型契约修复，作为**本子片第一个 commit** 单独提交（含针对性单测：两 shardId 同 connStr → `allShardDbs().length === 1`）。
- `FakeMultiShardResolver` 与真实语义对齐：也返回唯一 db、稳定顺序。fan-out 消费方**不**自行去重（去重责任在源头）。

## 核心模式（两个范式）

### 范式 A：per-tenant（有 tenantId 首参，resolver 模式）

```
this.resolver.dbForTenant(tenantId).execute(quotaCmdSetLimit({ tenantId, ... }));
```

`tenantId` 已是方法首参，直接喂 `dbForTenant`。SQL 命令本身不变（仍带 `tenantId` 作 WHERE 过滤——单 shard 内可能多租户共库，过滤仍必要）。

### 范式 B：cross-tenant fan-out（无 tenantId，resolver 模式）

`pruneUsageBefore` 是跨租户清理（`QuotaUsageRetentionWorker` 周期调用），多库下必须**跑遍所有唯一 shard**，**fail-fast**：

```
pruneUsageBefore(now, cutoff, batchSize = 1000): PruneResult {
  let totalDeleted = 0;
  let mayHaveMore = false;
  for (const db of this.resolver.allShardDbs()) {
    // fail-fast：某 shard 抛错立即整体抛出，后续 shard 本轮不执行；下周期重新 fan-out（prune 幂等，重试收敛）。
    const removed = db.execute(quotaCmdPruneUsage({ now, cutoff, batchSize })).rowsAffected;
    totalDeleted += removed;
    if (removed >= batchSize) mayHaveMore = true;  // 该 shard 本轮可能还有
  }
  return { totalDeleted, mayHaveMore };
}
```

**语义声明（Codex 采纳）**：
- `batchSize` 是**每 shard**上限；单轮全局删除上限 = `uniqueShardCount × batchSize`（有界放大，可接受——worker 分批仍收敛，因 prune 幂等）。
- **fail-fast 部分成功**：某 shard 抛错立即整体抛出，前面 shard 已删的**不回滚**（无跨-shard 原子性），失败轮不返回 `totalDeleted`（worker 本轮不记已删数——可接受的观测误差）。靠 prune 幂等，下周期重跑收敛。
- `mayHaveMore = 任一 shard removed >= batchSize`——**保守分页信号**（是否继续下一批），不保证并发写入下已永久 drained。
- **数据倾斜可接受低效**：若 shard1 每轮满、shard2 早空，worker 会因 shard1 持续 `mayHaveMore` 而对已空的 shard2 空跑 prune（删 0 行）——有界低效，不引入 per-shard 游标（避免过度复杂）。

### 分页语义修正（Linus「别破坏调用方假设」）

现状 `pruneUsageBefore` 返回裸 `number`（rowsAffected），调用方 `quota-usage-retention-worker.ts:87` 靠 `if (removed < batchSize) break;` 判断清完。fan-out 后简单累加会破坏此语义。

**决策**：返回类型 `number` → `{ totalDeleted: number; mayHaveMore: boolean }`。调用方 `quota-usage-retention-worker.ts` 改：`const { totalDeleted, mayHaveMore } = ...; total += totalDeleted; if (!mayHaveMore) break;`。破坏性签名变更，但生产调用方仅 1 处（worker）+ 测试；单 shard 下 `mayHaveMore === (removed >= batchSize)`，与旧 `removed < batchSize` 逐字等价。

> `quotaCmdPruneUsage` 命令本身**无 tenantId**（按 window_start 跨租户删），fan-out 时每 shard 传相同 `{now, cutoff, batchSize}`——语义正确：每 shard 独立删自己的旧窗口行。

## 签名变更：双入口过渡契约（Codex 采纳）

`QuotaManager` 有两类调用方，语义不同，**不能混为一谈**：
- **未绑事务的长期服务**（route 注册期）——应按 tenantId 选 db → 需 `TenantDbResolver`。
- **已进事务的调用链**（billing/entitlement，`this.tx` 已在 UoW 里）——必须继续用**该事务**，不得重新解析 db（否则脱离事务）→ 需 `SyncWriteUnitOfWork`。

**解法**：构造器私有化，暴露两个显式静态工厂（比发明 `SyncWriteUnitOfWorkResolver` 更诚实）：

```
class QuotaManager {
  private constructor(private readonly source: QuotaSource) { registerCoreSelfExecutors(); }

  /** resolver 模式：per-tenant 经 dbForTenant()，prune 经 allShardDbs() fan-out。用于 route 等未绑事务的长期服务。 */
  static fromResolver(resolver: TenantDbResolver): QuotaManager { ... }

  /** bound-UoW 模式：所有操作固定用该事务，不重新解析 db，不做 fan-out。用于 billing/entitlement 等已绑事务的调用链。 */
  static fromUnitOfWork(tx: SyncWriteUnitOfWork): QuotaManager { ... }
}
```

内部 `QuotaSource` 抽象两模式取 db 的差异：
- **per-tenant 方法**：resolver 模式 → `resolver.dbForTenant(tenantId)`；UoW 模式 → 固定 `tx`。
- **pruneUsageBefore**：resolver 模式 → `allShardDbs()` fan-out（fail-fast）；UoW 模式 → 单 `tx` 一次 execute（**不声称 fan-out**——它已在特定事务/单库语境，返回 `{ totalDeleted, mayHaveMore }` 与单-shard 等价）。

因 `IDatabase extends SyncWriteUnitOfWork`（`src/storage/database.ts:27`），resolver 返回的 `IDatabase` 直接可当 `SyncWriteUnitOfWork` 用，两模式内部统一到 `SyncWriteUnitOfWork` 接口，**无适配层**。

## 调用点更新（一次覆盖所有构造点，零回归）

**全部** `new QuotaManager(x)` → 按 x 的类型选工厂（plan 阶段用 `grep -rn "new QuotaManager(" src --include=*.ts` 复核，逐一分类）：
- x 是 `IDatabase`（route 层 `sharedDb`/`sharedTx`/`queueTx`/`db`；测试里的内存 db）→ `QuotaManager.fromResolver(new SingleDbResolver(x))`。
- x 是 `SyncWriteUnitOfWork`（billing/plans、entitlement-service 的 `this.tx`；life-simulations 的 `optTx`；memory-facade 的 `sharedTx`——**逐个核对实际静态类型**）→ `QuotaManager.fromUnitOfWork(x)`。

判据：能确定 x 是 `IDatabase` 且该点语义是「注册期长期服务」→ resolver 模式；x 只是 `SyncWriteUnitOfWork` 或已在事务上下文 → UoW 模式。plan 阶段**逐点列出分类表**，不许漏（漏一个编译红）。

`SingleDbResolver` 三方法恒返回同一 db → resolver 模式在单库下与改造前逐字等价。UoW 模式行为完全不变。**零回归**。

## 验收脚手架（本子片关键交付，后续复用）

### `FakeMultiShardResolver`（`src/test/support/fake-multi-shard-resolver.ts`）

测试专用 `TenantDbResolver` 实现，绕过 fail-closed（测试直接构造，不经 `createDatabase`），用于**证明路由分流正确**——「铺路不激活」子片唯一能真正验证正确性的方法（单库下 dbForTenant 与 coordinatorDb 是同一 db，普通功能测试证不出对错）。

```
class FakeMultiShardResolver implements TenantDbResolver {
  // 构造：coordinator db + shardId→db 映射 + tenantId→shardId 映射
  // dbForTenant(tenantId): 按 tenantId→shardId→db 返回对应 shard db（未映射 → 抛错，防测试疏漏）
  // coordinatorDb(): 返回 coordinator db
  // allShardDbs(): 返回所有【唯一】 shard db（与真实 ShardRouter 去重语义对齐，稳定顺序）
}
```

每个 shard 是独立 `createMemoryDatabase()` + `runDslSqliteMigrations`（各自建 quota 表）。

### 探针测试（`src/test/unit/quota-manager-sharding.test.ts`）

1. **per-tenant 分流**：`tenantA`→shard1、`tenantB`→shard2；各自 `setLimit`+`consumeQuota`；断言 shard1 db 查得到 tenantA 的 quota 行、查不到 tenantB 的（反之亦然）——证明写真落到 `dbForTenant` 返回的对应 db。
2. **fan-out**：两 shard 各预置旧窗口行；调 `pruneUsageBefore`；断言两 shard 旧行都被删、`totalDeleted` = 两 shard 之和。
3. **fan-out 去重**：构造两 shardId 映射同一 db 实例的 resolver（或直接用真实 ShardRouter 同 connStr 场景）；断言 prune 只对该物理库执行一次（`totalDeleted` 不翻倍）。
4. **mayHaveMore 分页**：构造「shard1 满一批（≥batchSize）、shard2 未满」，断言 `mayHaveMore === true`；两 shard 都未满 → `mayHaveMore === false`。
5. **fan-out fail-fast**：让第二个 shard 的 execute 抛错；断言 `pruneUsageBefore` 整体抛出、第一个 shard 已删的不回滚（观测其 db）、再次调用最终收敛（幂等）。
6. **UoW 模式**：`QuotaManager.fromUnitOfWork(tx)`，per-tenant 操作落该 tx、`pruneUsageBefore` 单次 execute 不 fan-out，返回值与单-shard 等价。
7. **单库零回归**：`fromResolver(new SingleDbResolver(oneDb))`，跑 per-tenant + prune，断言行为与改造前等价。

### worker 回归（`quota-usage-retention-worker`）

worker 改用新返回类型后现有测试须绿；新增断言：多-shard 下 worker 分页循环用 `mayHaveMore` 正确终止（不空转、不早停）。

## 文件结构

| 文件 | 动作 | 责任 |
|---|---|---|
| `src/storage/shard-router.ts` | 改（前置） | `allShardDbs()` 按 connStr 去重 + 针对性单测 |
| `src/multi-tenant/quota-manager.ts` | 改 | 私有构造器 + `fromResolver`/`fromUnitOfWork` 双入口；per-tenant→按模式取 db；`pruneUsageBefore`→resolver 模式 fan-out(fail-fast)、UoW 模式单次；返回 `{totalDeleted,mayHaveMore}` |
| `src/multi-tenant/quota-usage-retention-worker.ts` | 改 | 适配新返回类型（`mayHaveMore` 判终止）+ 其 `new QuotaManager` 构造点选对工厂 |
| 全部 20+ 个 `new QuotaManager()` 构造点 | 改 | 按传入类型选 `fromResolver(SingleDbResolver(...))` 或 `fromUnitOfWork(...)`（plan 逐点分类表） |
| `src/test/support/fake-multi-shard-resolver.ts` | 建 | 复用验收脚手架（allShardDbs 去重语义对齐） |
| `src/test/unit/quota-manager-sharding.test.ts` | 建 | 探针测试（分流/fan-out/去重/分页/fail-fast/UoW/零回归 7 类） |

## 红线（不变量）

1. **零回归**：单库（`SingleDbResolver`）与 UoW 模式下所有行为与改造前逐字等价；全量 unit fail=0。
2. **per-tenant 必按模式取 db**：resolver 模式经 `dbForTenant(tenantId)`，UoW 模式固定该 tx——不得混。
3. **cross-tenant fan-out 仅 resolver 模式**：`pruneUsageBefore` resolver 模式遍历 `allShardDbs()` fail-fast；UoW 模式单次不声称 fan-out。
4. **allShardDbs 唯一物理 db**：去重在 `ShardRouter.allShardDbs()` 源头，消费方不重复去重；fan-out 不对同库重复执行。
5. **分页语义不破坏**：`mayHaveMore` 正确反映「任一 shard 本轮可能还有」；worker 终止条件正确。
6. **两模式语义诚实分离**：已绑事务的调用链走 `fromUnitOfWork`，不被重新解析 db 脱离事务。
7. **无适配层**：直接用 `IDatabase extends SyncWriteUnitOfWork` 兼容性，不新增包装类型。
8. **验收真证分流**：探针测试用多个独立物理 db 断言数据真落对 shard，非仅「不报错」。
9. **模式可复制**：QuotaManager 双入口改法 + FakeMultiShardResolver 脚手架，能被后续子服务子片直接套用（文档化改造步骤）。
10. **inventory 不动**：QuotaManager 不命中 ratchet 拿-db 模式，改持 resolver 不新增/移除 inventory 条目；相关 route 仍捕获 `sharedDb/sharedTx`、仍有本片范围外裸 db 访问，其 `longlived-root-capture` 分类**必须保留**。`check:db-access` 继续通过≠route 已整体 shard-safe。

## 验收标准

- `npm run typecheck` exit 0。
- `npm run build` 成功。
- `ShardRouter.allShardDbs()` 去重单测绿。
- 探针测试全绿（7 类断言）。
- worker 回归绿。
- **全量 unit fail=0**（零回归铁证）。
- `npm run check:db-access`（ratchet）exit 0（inventory 不变；QuotaManager 改持 resolver 不影响 ratchet PATTERN；route 的 `longlived-root-capture` 条目保留）。
- 交叉审查（生成者≠审查者）：审查含**变异测试**证明探针测试非重言式（如：故意让 `dbForTenant` 恒返回 coordinator，探针「per-tenant 分流」测试应变红；故意去掉 `allShardDbs` fan-out 只碰第一个 db，「fan-out」测试应变红）。
