# 子服务接 TenantDbResolver 模式 + 多-shard 验收脚手架 设计

> **状态**：设计已定，待 writing-plans。
> **归属**：#3 租户分片 Phase 0 —— 「12 访问点接线」sub-phase 的**首个实现子片**（立模式 + 立验收方法）。
> **前置**：ShardRouter 子片（PR #314，`TenantDbResolver`/`SingleDbResolver`/`ShardRouter` 契约已合入）。

## 背景与问题

项目每租户一个 `ChronoSynthOS` 实例，`TenantOSFactory.getTenantOS(tenantId)` 已把 `resolver.dbForTenant(tenantId)` 包成 `TenantDatabase` 灌进去——凡走 `tenantOS.getDatabase()` 的访问点**已自动 shard-aware**（Task 4 已接）。

但一批 route 在**注册期直接抓 root db**（`sharedDb = db ?? os.getDatabase()`），把它塞进子服务（`QuotaManager`/`TokenBudget`/`PersonaCoreService` 等）构造器，然后 per-request 对这个 root db 跑租户查询。侦察确证：**这些子服务全是「db 进构造、tenantId 进方法」模式，持单一 db 实例做参数化查询**。即使 route 层换对 db 源，多库下子服务仍只查那一个库——**真正的分片能力缺口在子服务内部**。

单库下 root db = 唯一库，一切能跑；多库下 root db = 协调库、租户数据在别 shard → **静默错-shard**。

## 本子片的范围（YAGNI）

**只做**：把**一个典型子服务**（`QuotaManager`）从「持单一 db」改为「持 `TenantDbResolver`、每调用按 tenantId 取 `dbForTenant`」，并建**可复用的多-shard 探针验收脚手架**。此片立起模式与验收方法，后续子服务批量套用。

**不做**（归后续子片）：
- app.ts 把 resolver 真正穿到 route 层（本片调用点用 `SingleDbResolver` 包裹，等价现状）。
- 其余子服务（TokenBudget/CostTracker/UsageTracker/BillingOutbox/PersonaCoreService/PersonaTemplateService）的改造。
- default 租户走根实例绕过 resolver 的缝隙。
- privacy-service 跨表 GDPR 事务的跨-shard 原子性难题。

## 为什么选 QuotaManager 作首个标本

1. **覆盖面最广**：在全部 7 个 route（decisions/onboarding/companion×3 + app.ts queueDb）出现。
2. **构造只吃 db**：`constructor(tx: SyncWriteUnitOfWork)`，无租户绑定，改造干净。
3. **一个类里同时有两种范式**（关键）：
   - **per-tenant 方法**（`setLimit`/`clearLimit`/`checkQuota`/`consumeQuota`/`recordUsage`）——首参即 `tenantId` → `dbForTenant(tenantId)`。
   - **cross-tenant 方法**（`pruneUsageBefore(now, cutoff, batchSize)`——**无 tenantId**）→ `allShardDbs()` fan-out。
   两种范式一次立全，是模式的完整标本。

## 核心模式（两个范式）

### 范式 A：per-tenant（有 tenantId 首参）

```
// 现状
this.tx.execute(quotaCmdSetLimit({ tenantId, ... }));
// 改造后
this.resolver.dbForTenant(tenantId).execute(quotaCmdSetLimit({ tenantId, ... }));
```

`tenantId` 已是方法首参，直接喂 `dbForTenant`。SQL 命令本身不变（仍带 `tenantId` 作 WHERE 过滤——单 shard 内可能多租户共库，过滤仍必要）。

### 范式 B：cross-tenant fan-out（无 tenantId）

`pruneUsageBefore` 是跨租户清理（`QuotaUsageRetentionWorker` 周期调用），多库下必须**跑遍所有 shard**：

```
pruneUsageBefore(now, cutoff, batchSize = 1000): PruneResult {
  let totalDeleted = 0;
  let allDrained = true;
  for (const db of this.resolver.allShardDbs()) {
    const removed = db.execute(quotaCmdPruneUsage({ now, cutoff, batchSize })).rowsAffected;
    totalDeleted += removed;
    if (removed >= batchSize) allDrained = false;  // 该 shard 本轮可能还有
  }
  return { totalDeleted, allDrained };
}
```

### 分页语义修正（Linus「别破坏调用方假设」）

**问题**：现状 `pruneUsageBefore` 返回裸 `rowsAffected`，调用方 `quota-usage-retention-worker.ts:87` 靠 `if (removed < batchSize) break;` 判断清完。fan-out 后简单累加会破坏此语义——3 个 shard 各删 500（各 <1000），累加 1500 > batchSize，调用方永不 break（或反之空转）。

**决策**：返回类型从 `number` 改为 `{ totalDeleted: number; allDrained: boolean }`。
- `allDrained` = **所有 shard 本轮都 < batchSize**（即全局清完）。
- 调用方 `quota-usage-retention-worker.ts` 相应改：`const { totalDeleted, allDrained } = ...; total += totalDeleted; if (allDrained) break;`。
- 这是**破坏性签名变更**，但调用方仅 2 处（worker + 1 集成测试），且新语义在单库下与旧行为逐字等价（单 shard 时 `allDrained === (removed < batchSize)`）。

> 注：`quotaCmdPruneUsage` 命令本身**无 tenantId**（它按 window_start 跨租户删），fan-out 时每个 shard 传相同 `{now, cutoff, batchSize}`——语义正确：每 shard 独立删自己的旧窗口行。

## 签名变更

```
// 现状
class QuotaManager {
  constructor(private readonly tx: SyncWriteUnitOfWork) { ... }
}
// 改造后
class QuotaManager {
  constructor(private readonly resolver: TenantDbResolver) { ... }
}
```

因 `IDatabase extends SyncWriteUnitOfWork`（`src/storage/database.ts:27`），`resolver.dbForTenant()`/`allShardDbs()` 返回的 `IDatabase` **直接可当 `SyncWriteUnitOfWork` 用，无适配层**。`registerCoreSelfExecutors()` 调用位置不变（构造器内）。

## 调用点更新（最小改动，零回归）

全部 `new QuotaManager(<db>)` → `new QuotaManager(new SingleDbResolver(<db>))`。

调用点清单（plan 阶段用 `grep -rn "new QuotaManager(" src --include=*.ts` 复核确认全覆盖）：
- `src/server/routes/decisions.ts`
- `src/server/routes/onboarding.ts`
- `src/server/routes/companion/chat.ts`
- `src/server/routes/companion/perceive.ts`
- `src/server/routes/companion/perceive-stream.ts`
- `src/server/app.ts`（queueDb 那处）
- `src/multi-tenant/quota-usage-retention-worker.ts` 的构造点（追其 `new QuotaManager` 来源）
- 任何测试文件里的 `new QuotaManager(db)` 同步改包裹（否则编译红）

`SingleDbResolver` 三方法恒返回同一 db → `dbForTenant` 与 `allShardDbs`（返回 `[db]`）在单库下与改造前逐字等价。**零回归**。

## 验收脚手架（本子片关键交付，后续复用）

### `FakeMultiShardResolver`（`src/test/support/fake-multi-shard-resolver.ts`）

测试专用的 `TenantDbResolver` 实现，绕过 fail-closed（测试直接构造，不经 `createDatabase`），用于**证明路由分流正确**——这是「铺路不激活」子片唯一能真正验证正确性的方法（单库下 dbForTenant 与 coordinatorDb 是同一 db，普通功能测试证不出对错）。

```
class FakeMultiShardResolver implements TenantDbResolver {
  // 构造：coordinator db + shardId→db 映射 + tenantId→shardId 映射
  // dbForTenant(tenantId): 按 tenantId→shardId→db 返回对应 shard db（未映射 → 抛错，防测试疏漏）
  // coordinatorDb(): 返回 coordinator db
  // allShardDbs(): 返回所有 shard db（去重，稳定顺序）
}
```

每个 shard 是独立的 `createMemoryDatabase()` + `runDslSqliteMigrations`（各自建 quota 表）。

### 探针测试（`src/test/unit/quota-manager-sharding.test.ts`）

1. **per-tenant 分流**：`tenantA`→shard1、`tenantB`→shard2；各自 `setLimit`+`consumeQuota`；断言 shard1 的 db 查得到 tenantA 的 quota 行、查不到 tenantB 的（反之亦然）——证明写真落到 `dbForTenant` 返回的对应 db。
2. **fan-out**：两个 shard 各预置旧窗口行；调 `pruneUsageBefore`；断言**两个 shard 的旧行都被删**（fan-out 生效），`totalDeleted` = 两 shard 之和。
3. **分页 `allDrained` 语义**：构造「shard1 满一批（≥batchSize）、shard2 未满」，断言 `allDrained === false`；再构造两 shard 都未满，断言 `allDrained === true`。
4. **单库零回归**：注 `SingleDbResolver(oneDb)`，跑一遍 per-tenant + prune，断言行为与改造前等价（数据落唯一 db、`allDrained` 等价于旧 `removed < batchSize`）。

### worker 回归（`quota-usage-retention-worker`）

worker 改用新返回类型后，其现有测试（若有）须绿；新增一条断言：多-shard 下 worker 的分页循环用 `allDrained` 正确终止（不空转、不早停）。

## 文件结构

| 文件 | 动作 | 责任 |
|---|---|---|
| `src/multi-tenant/quota-manager.ts` | 改 | 构造 `tx`→`resolver`；per-tenant→`dbForTenant`；`pruneUsageBefore`→fan-out + 新返回类型 |
| `src/multi-tenant/quota-usage-retention-worker.ts` | 改 | 适配 `pruneUsageBefore` 新返回类型（`allDrained` 判终止）+ 其 `new QuotaManager` 构造点包 `SingleDbResolver` |
| 7 个 route + app.ts | 改（最小） | `new QuotaManager(db)`→`new QuotaManager(new SingleDbResolver(db))` |
| `src/test/support/fake-multi-shard-resolver.ts` | 建 | 复用验收脚手架 |
| `src/test/unit/quota-manager-sharding.test.ts` | 建 | 探针测试（分流/fan-out/分页/零回归） |
| 现有 QuotaManager 测试 | 改 | 构造点包 `SingleDbResolver`（保持绿） |

## 红线（不变量）

1. **零回归**：单库（`SingleDbResolver`）下所有行为与改造前逐字等价；全量 unit fail=0。
2. **per-tenant 必经 dbForTenant**：所有带 tenantId 的 quota 操作经 `resolver.dbForTenant(tenantId)`，不得直接持某个 db。
3. **cross-tenant 必 fan-out**：`pruneUsageBefore` 遍历 `allShardDbs()`，不得只碰单个 db。
4. **分页语义不破坏**：`allDrained` 正确反映「所有 shard 本轮清完」；worker 终止条件正确。
5. **无适配层**：直接用 `IDatabase extends SyncWriteUnitOfWork` 的兼容性，不新增包装类型。
6. **验收真证分流**：探针测试用多个独立物理 db 断言数据真落对 shard，非仅「不报错」。
7. **模式可复制**：QuotaManager 的改法 + FakeMultiShardResolver 脚手架，能被后续子服务子片直接套用（文档化改造步骤）。

## 验收标准

- `npm run typecheck` exit 0。
- `npm run build` 成功。
- 探针测试全绿（4 类断言）。
- worker 回归绿。
- **全量 unit fail=0**（零回归铁证）。
- ratchet exit 0（QuotaManager 从「持 db」变「持 resolver」——它不再是拿-host-db 访问点；确认 ratchet 不因此新报，必要时更新 inventory note）。
- 交叉审查（生成者≠审查者）：Codex 或独立 Claude 审查，含变异测试证明探针测试非重言式（如：故意让 dbForTenant 恒返回 coordinator，探针测试应变红）。
