# 子服务接 TenantDbResolver 模式 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `QuotaManager` 改造为「双入口（resolver / bound-UoW）」子服务，per-tenant 走 `dbForTenant`、cross-tenant `pruneUsageBefore` 走 `allShardDbs` fan-out，并建可复用的多-shard 探针验收脚手架，为后续子服务分片接线立模式与验收方法。

**Architecture:** 每租户一个 ChronoSynthOS 实例，`TenantOSFactory` 已持 `TenantDbResolver`。本子片让 QuotaManager 也能按 tenantId 解析 db（resolver 模式）或固定使用已绑事务（bound-UoW 模式）。单库下（`SingleDbResolver`）与改造前逐字等价，多库能力由探针测试用 `FakeMultiShardResolver` 注独立物理 db 验证。分片生产未激活（fail-closed 挡着），本片纯「铺路」。

**Tech Stack:** TypeScript (NodeNext ESM, `.js` imports)，node:test，SQLite 内存库，`@chrono/kernel` 的 `SyncWriteUnitOfWork` 端口 + quota 命令。

## Global Constraints

- **零回归铁律**：单库（`SingleDbResolver`）与 bound-UoW 模式下所有行为与改造前逐字等价；全量 unit fail=0。
- **双入口语义诚实分离**：`fromResolver`（route 长期服务，per-tenant→dbForTenant、prune→allShardDbs fan-out）；`fromUnitOfWork`（billing/entitlement 已绑事务，固定 tx、不 fan-out）。
- **allShardDbs 返唯一物理 db**：去重在 `ShardRouter.allShardDbs()` 源头（按 connStr）；消费方不重复去重。
- **fan-out fail-fast**：某 shard 抛错立即整体抛出，后续 shard 本轮不执行；无跨-shard 原子性，靠 prune 幂等重试收敛。
- **`pruneUsageBefore` 返回** `{ totalDeleted: number; mayHaveMore: boolean }`；`mayHaveMore = 任一 shard removed >= batchSize`。
- **无适配层**：直接用 `IDatabase extends SyncWriteUnitOfWork`（`src/storage/database.ts:27`）兼容性，不新增包装类型。
- **inventory 不动**：QuotaManager 不命中 ratchet 拿-db 模式；route 的 `longlived-root-capture` 条目保留；`npm run check:db-access` 继续通过。
- 注释简体中文；ESM `.js` 扩展名；同步（QuotaManager 无 async）；无 `Math.random`/`Date.now`（测试传时钟）。
- **构造点分类以声明静态类型为准**（见 Task 6 权威分类表）：声明 `IDatabase`→`fromResolver(new SingleDbResolver(x))`；声明**仅** `SyncWriteUnitOfWork`→`fromUnitOfWork(x)`。

---

### Task 1: `ShardRouter.allShardDbs()` 按 connStr 去重（前置契约修复）

**Files:**
- Modify: `src/storage/shard-router.ts:60-62`（`allShardDbs`）
- Test: `src/test/unit/shard-router.test.ts`（加一条去重断言）

**Interfaces:**
- Consumes: 现有 `ShardRouterConfig`（`shards: Record<shardId, connStr>`）、私有 `dbForConn(connStr)`（按 connStr 缓存去重实例）。
- Produces: `allShardDbs(): IDatabase[]` 返回**唯一**物理 db（两 shardId 同 connStr → 只出现一次），稳定顺序（按 shards 声明顺序首次出现）。

- [ ] **Step 1: 写失败测试**

在 `src/test/unit/shard-router.test.ts` 末尾（describe 内）加：

```ts
  it('allShardDbs 按 connStr 去重：两 shardId 映射同一 connStr → 只返回一个实例', () => {
    const { buildDb } = trackingBuild();
    /* s1 与 s2 指向同一 connStr 'c1'，s3 独立 'c3' */
    const r = new ShardRouter({ shards: { s1: 'c1', s2: 'c1', s3: 'c3' }, homeShardId: 's1', buildDb });
    const dbs = r.allShardDbs();
    assert.equal(dbs.length, 2, '唯一物理 db 数（c1 去重 + c3）');
    /* 稳定顺序：c1 首次出现在 s1，c3 在 s3 */
    assert.strictEqual(dbs[0], r.dbForTenant('default'), '首个是 home(s1=c1) 的 db');
    /* 两个返回的实例互不相同（c1 vs c3） */
    assert.notStrictEqual(dbs[0], dbs[1]);
  });
```

（`trackingBuild()` 是该测试文件已有的 helper——若名称不同，用文件内现有的 buildDb 追踪 helper；核对文件顶部 import/helper。）

- [ ] **Step 2: 跑测试确认失败**

Run: `npm run build >/dev/null 2>&1; node --test --test-force-exit dist/test/unit/shard-router.test.js 2>&1 | grep -E "^ℹ (tests|pass|fail)"`
Expected: FAIL —— 现状 `allShardDbs` 返 3 个（s1/s2/s3 各一，c1 重复），`length === 2` 断言红。

- [ ] **Step 3: 改 allShardDbs 去重**

`src/storage/shard-router.ts` 的 `allShardDbs`：

```ts
  allShardDbs(): IDatabase[] {
    /* 返唯一物理 db：两 shardId 映射同一 connStr 时只出现一次（防 fan-out 消费方对同库重复执行）。
     * 按 shards 声明顺序取首次出现，稳定顺序。 */
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

- [ ] **Step 4: 跑测试确认通过 + 全量 shard-router 测试绿**

Run: `npm run build >/dev/null 2>&1; node --test --test-force-exit dist/test/unit/shard-router.test.js 2>&1 | grep -E "^ℹ (tests|pass|fail)"`
Expected: 全绿（原有 + 新增去重断言）。

- [ ] **Step 5: 提交**

```bash
git add src/storage/shard-router.ts src/test/unit/shard-router.test.ts
git commit -m "$(printf 'fix(storage): ShardRouter.allShardDbs 按 connStr 去重（防 fan-out 重复执行）\n\n两 shardId 映射同一 connStr 时原返回同实例两次；改为按 connStr 去重、\n稳定顺序，返唯一物理 db。fan-out 消费方（QuotaManager.pruneUsageBefore）\n据此不对同库重复 prune。\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

### Task 2: `FakeMultiShardResolver` 验收脚手架

**Files:**
- Create: `src/test/support/fake-multi-shard-resolver.ts`
- Test: `src/test/unit/fake-multi-shard-resolver.test.ts`（脚手架自测）

**Interfaces:**
- Consumes: `TenantDbResolver`（`src/storage/tenant-db-resolver.js`）、`IDatabase`、`createMemoryDatabase` + `runDslSqliteMigrations`（`src/storage/index.js`）。
- Produces: `class FakeMultiShardResolver implements TenantDbResolver` + 便捷构造 helper `makeShardedResolver(shardCount, tenantToShard)`（返回 resolver + 各 shard db 引用供断言）。

- [ ] **Step 1: 写脚手架自测（失败）**

创建 `src/test/unit/fake-multi-shard-resolver.test.ts`：

```ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FakeMultiShardResolver } from '../support/fake-multi-shard-resolver.js';
import { createMemoryDatabase } from '../../storage/index.js';

describe('FakeMultiShardResolver（验收脚手架）', () => {
  it('dbForTenant 按 tenantId→shard 映射返对应 db；未映射抛错', () => {
    const s1 = createMemoryDatabase();
    const s2 = createMemoryDatabase();
    const coord = createMemoryDatabase();
    const r = new FakeMultiShardResolver({
      coordinator: coord,
      shards: { shardA: s1, shardB: s2 },
      tenantToShard: { t1: 'shardA', t2: 'shardB' },
    });
    assert.strictEqual(r.dbForTenant('t1'), s1);
    assert.strictEqual(r.dbForTenant('t2'), s2);
    assert.strictEqual(r.coordinatorDb(), coord);
    assert.throws(() => r.dbForTenant('unknown'), /映射|未知|unknown/i);
  });

  it('allShardDbs 返唯一 shard db、稳定顺序（与真实 ShardRouter 语义对齐）', () => {
    const s1 = createMemoryDatabase();
    const s2 = createMemoryDatabase();
    const r = new FakeMultiShardResolver({
      coordinator: s1, /* coordinator 复用 s1（同实例）——不应在 allShardDbs 里重复 */
      shards: { shardA: s1, shardB: s2 },
      tenantToShard: {},
    });
    const dbs = r.allShardDbs();
    assert.equal(dbs.length, 2, '两个唯一 shard 实例');
    assert.strictEqual(dbs[0], s1);
    assert.strictEqual(dbs[1], s2);
  });
});
```

- [ ] **Step 2: 跑确认失败**

Run: `npm run build >/dev/null 2>&1; node --test --test-force-exit dist/test/unit/fake-multi-shard-resolver.test.js 2>&1 | grep -E "^ℹ (tests|pass|fail)"`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 实现脚手架**

创建 `src/test/support/fake-multi-shard-resolver.ts`：

```ts
/**
 * 多-shard 验收脚手架（测试专用）。实现 TenantDbResolver，用多个独立物理 db 断言分片路由分流。
 * 「铺路不激活」子片唯一能真正验证正确性的手段：单库下 dbForTenant 与 coordinatorDb 是同一 db，
 * 普通功能测试证不出路由对错；本 Fake 注独立 db，让「数据真落对 shard」可断言。
 * allShardDbs 去重语义与真实 ShardRouter 对齐（按实例身份去重、稳定顺序）。
 */
import type { IDatabase } from '../../storage/database.js';
import type { TenantDbResolver } from '../../storage/tenant-db-resolver.js';

export interface FakeShardConfig {
  readonly coordinator: IDatabase;
  /** shardId → 该 shard 的独立 db 实例。 */
  readonly shards: Record<string, IDatabase>;
  /** tenantId → shardId 映射。未映射的 tenantId 调 dbForTenant 抛错（防测试疏漏静默走错）。 */
  readonly tenantToShard: Record<string, string>;
}

export class FakeMultiShardResolver implements TenantDbResolver {
  constructor(private readonly cfg: FakeShardConfig) {}

  dbForTenant(tenantId: string): IDatabase {
    const shardId = this.cfg.tenantToShard[tenantId];
    if (!shardId) throw new Error(`FakeMultiShardResolver: tenantId '${tenantId}' 无 shard 映射（测试须显式声明）`);
    const db = this.cfg.shards[shardId];
    if (!db) throw new Error(`FakeMultiShardResolver: shardId '${shardId}' 无 db`);
    return db;
  }

  coordinatorDb(): IDatabase {
    return this.cfg.coordinator;
  }

  allShardDbs(): IDatabase[] {
    /* 按实例身份去重、稳定顺序（与真实 ShardRouter 按 connStr 去重语义对齐——此处实例即身份）。 */
    const seen = new Set<IDatabase>();
    const out: IDatabase[] = [];
    for (const db of Object.values(this.cfg.shards)) {
      if (seen.has(db)) continue;
      seen.add(db);
      out.push(db);
    }
    return out;
  }
}
```

- [ ] **Step 4: 跑确认通过**

Run: `npm run build >/dev/null 2>&1; node --test --test-force-exit dist/test/unit/fake-multi-shard-resolver.test.js 2>&1 | grep -E "^ℹ (tests|pass|fail)"`
Expected: 全绿。

- [ ] **Step 5: 提交**

```bash
git add src/test/support/fake-multi-shard-resolver.ts src/test/unit/fake-multi-shard-resolver.test.ts
git commit -m "$(printf 'test(support): FakeMultiShardResolver 多-shard 验收脚手架\n\n实现 TenantDbResolver，注独立物理 db 断言分片路由分流；allShardDbs 按\n实例身份去重、稳定顺序，与真实 ShardRouter 对齐。未映射 tenantId 抛错防疏漏。\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

### Task 3: QuotaManager 双入口重构 + 全部构造点原子迁移

> **原子性铁律**：私有化构造器会让全仓所有 `new QuotaManager(` 立即编译红。故**本任务在同一提交内**完成「双入口重构 + 全部 20+ 构造点迁移」——每个提交都必须编译过（Global Constraints 隐含要求）。构造点分类表见本任务 Step 5-6，权威依据是 spec 与已核实的声明静态类型。

**Files:**
- Modify: `src/multi-tenant/quota-manager.ts`（私有构造器 + 两静态工厂 + per-tenant 走内部取 db；`pruneUsageBefore` 本任务保持 `number` 返回，Task 4 再改 fan-out）
- Modify（生产构造点 → `fromResolver(new SingleDbResolver(x))`，x 声明 IDatabase）：`src/server/routes/decisions.ts:71`、`onboarding.ts:74`、`companion/chat.ts:83`、`companion/perceive.ts:52`、`companion/perceive-stream.ts:70`、`companion/me.ts:344,454`、`app.ts:384,494`、`core/memory-facade.ts:102`、`server/routes/life-simulations.ts:39`
- Modify（生产构造点 → `fromUnitOfWork(x)`，x 声明**仅** SyncWriteUnitOfWork）：`src/billing/plans.ts:58`、`src/billing/entitlement-service.ts:50`
- Modify（测试构造点，全部内存 db → `fromUnitOfWork(db)`，单库等价、改动最小）：`src/test/unit/quota-manager.test.ts`、`quota-usage-retention-worker.test.ts:22`、`model-router.test.ts:218,234,253`、`billing-uow-entrance.test.ts:91,92`、`avatar-quota.test.ts:119,129,142,160`、`src/test/integration/companion-perceive-stream.test.ts:187`、`quota-usage-prune-pg.test.ts:29`、`companion-perceive-api.test.ts:233,271`、`negative-rate-limit-bypass.test.ts:27`、`companion-api.test.ts:349,393`、`companion-chat-api.test.ts:373`
- Test: `src/test/unit/quota-manager.test.ts`（加双入口测试 + 现有构造点改）

**Interfaces:**
- Consumes: `TenantDbResolver`/`SingleDbResolver`（`src/storage/tenant-db-resolver.js`）、`SyncWriteUnitOfWork`（`@chrono/kernel`）、现有 quota 命令/查询。
- Produces:
  - `QuotaManager.fromResolver(resolver: TenantDbResolver): QuotaManager`
  - `QuotaManager.fromUnitOfWork(tx: SyncWriteUnitOfWork): QuotaManager`
  - per-tenant 方法签名不变（`setLimit`/`clearLimit`/`checkQuota`/`consumeQuota`/`recordUsage`），内部按模式取 db。
  - `pruneUsageBefore` 签名/返回类型在 Task 4 改（本任务保持 `number` 返回 + 单模式，Task 4 再加 fan-out）。

- [ ] **Step 1: 写失败测试（双入口 + per-tenant 分流）**

在 `src/test/unit/quota-manager.test.ts` 加（不删现有测试，现有的下一步改构造点）：

```ts
import { FakeMultiShardResolver } from '../support/fake-multi-shard-resolver.js';
import { SingleDbResolver } from '../../storage/tenant-db-resolver.js';
// ...现有 import

describe('QuotaManager 双入口', () => {
  it('fromResolver：per-tenant 落 dbForTenant 对应 shard', () => {
    const s1 = makeQuotaDb();  // helper：createMemoryDatabase + 建 quota 表（用文件现有建库方式）
    const s2 = makeQuotaDb();
    const r = new FakeMultiShardResolver({
      coordinator: s1, shards: { a: s1, b: s2 }, tenantToShard: { t1: 'a', t2: 'b' },
    });
    const qm = QuotaManager.fromResolver(r);
    qm.setLimit('t1', 'sim', 5, 60_000);
    qm.setLimit('t2', 'sim', 9, 60_000);
    /* t1 的 limit 落 s1，s2 查不到 t1 */
    assert.equal(new QuotaManager /* 直接查 */ ?? true, true);  // 占位——实际用下方断言
    /* 断言：用 s1/s2 直接查 quota_limits，t1 只在 s1、t2 只在 s2 */
    const t1OnS1 = s1.prepare('SELECT max_per_window FROM quota_limits WHERE tenant_id=? AND resource=?').get('t1', 'sim');
    const t1OnS2 = s2.prepare('SELECT max_per_window FROM quota_limits WHERE tenant_id=? AND resource=?').get('t1', 'sim');
    assert.ok(t1OnS1, 't1 limit 落 s1');
    assert.equal(t1OnS2, undefined, 't1 limit 不在 s2');
  });

  it('fromUnitOfWork：所有操作固定用该 tx（不 fan-out、不重新解析）', () => {
    const db = makeQuotaDb();
    const qm = QuotaManager.fromUnitOfWork(db);
    qm.setLimit('tX', 'sim', 3, 60_000);
    const row = db.prepare('SELECT max_per_window FROM quota_limits WHERE tenant_id=? AND resource=?').get('tX', 'sim');
    assert.ok(row);
  });
});
```

（注：上面 `makeQuotaDb()` 用测试文件现有的建库/迁移方式——核对 quota-manager.test.ts 顶部现有 setup 怎么建 quota 表，复用它。删掉占位那行，只保留真实 s1/s2 直查断言。）

- [ ] **Step 2: 跑确认失败**

Run: `npm run build >/dev/null 2>&1; node --test --test-force-exit dist/test/unit/quota-manager.test.js 2>&1 | grep -E "^ℹ (tests|pass|fail)"`
Expected: FAIL —— `QuotaManager.fromResolver`/`fromUnitOfWork` 不存在，且现有 `new QuotaManager(db)` 若构造器已私有化则编译红（Step 3 后现有测试构造点在 Step 5 统一改）。

- [ ] **Step 3: 重构 QuotaManager**

`src/multi-tenant/quota-manager.ts` 全文重构：

```ts
/**
 * 租户配额管理（双入口过渡契约，租户分片 Phase 0）。
 * 基于 quota_limits / quota_usage 表实现每租户资源限制，支持按数量消费。
 *
 * 两模式（语义诚实分离）：
 *   - resolver 模式（fromResolver）：未绑事务的长期服务（route 注册期）。per-tenant 经
 *     resolver.dbForTenant(tenantId) 选 db；cross-tenant（pruneUsageBefore）经 allShardDbs() fan-out。
 *   - bound-UoW 模式（fromUnitOfWork）：已进事务的调用链（billing/entitlement）。所有操作固定用该
 *     事务，不重新解析 db（否则脱离事务），pruneUsageBefore 单次 execute 不 fan-out。
 * 因 IDatabase extends SyncWriteUnitOfWork，两模式内部统一到 SyncWriteUnitOfWork 接口，无适配层。
 */
import type { SyncWriteUnitOfWork } from '@chrono/kernel';
import {
  quotaQueryLimit, quotaQueryUsage,
  quotaCmdSetLimit, quotaCmdClearLimit, quotaCmdConsume, quotaCmdRecordUsage, quotaCmdPruneUsage,
} from '@chrono/kernel';
import { registerCoreSelfExecutors } from '../storage/executors/index.js';
import type { TenantDbResolver } from '../storage/tenant-db-resolver.js';

/** 内部 db 取源：resolver 模式按 tenantId 解析；UoW 模式固定 tx。 */
interface QuotaSource {
  /** per-tenant 操作取 db。 */
  forTenant(tenantId: string): SyncWriteUnitOfWork;
  /** cross-tenant fan-out 的所有 db（UoW 模式返 [tx]）。 */
  allDbs(): SyncWriteUnitOfWork[];
}

export class QuotaManager {
  private constructor(private readonly source: QuotaSource) {
    registerCoreSelfExecutors();
  }

  /** resolver 模式：per-tenant→dbForTenant，prune→allShardDbs fan-out。用于 route 等未绑事务的长期服务。 */
  static fromResolver(resolver: TenantDbResolver): QuotaManager {
    return new QuotaManager({
      forTenant: (tenantId) => resolver.dbForTenant(tenantId),
      allDbs: () => resolver.allShardDbs(),
    });
  }

  /** bound-UoW 模式：固定用该事务，不 fan-out。用于 billing/entitlement 等已绑事务的调用链。 */
  static fromUnitOfWork(tx: SyncWriteUnitOfWork): QuotaManager {
    return new QuotaManager({
      forTenant: () => tx,
      allDbs: () => [tx],
    });
  }

  setLimit(tenantId: string, resource: string, maxPerWindow: number, windowMs: number): void {
    this.source.forTenant(tenantId).execute(quotaCmdSetLimit({ tenantId, resource, maxPerWindow, windowMs }));
  }

  clearLimit(tenantId: string, resource: string): void {
    this.source.forTenant(tenantId).execute(quotaCmdClearLimit({ tenantId, resource }));
  }

  checkQuota(tenantId: string, resource: string, quantity = 1, now?: number): boolean {
    const tx = this.source.forTenant(tenantId);
    const limit = tx.queryOne(quotaQueryLimit(tenantId, resource));
    if (!limit) return true;
    const ts = now ?? Date.now();
    const windowStart = ts - (ts % limit.window_ms);
    const usage = tx.queryOne(quotaQueryUsage(tenantId, resource, windowStart));
    const used = usage?.used ?? 0;
    return (used + quantity) <= limit.max_per_window;
  }

  consumeQuota(tenantId: string, resource: string, quantity = 1, now?: number): boolean {
    const tx = this.source.forTenant(tenantId);
    const ts = now ?? Date.now();
    const limit = tx.queryOne(quotaQueryLimit(tenantId, resource));
    if (!limit) {
      this.recordUsage(tenantId, resource, quantity, ts);
      return true;
    }
    if (limit.max_per_window <= 0 || quantity > limit.max_per_window) return false;
    const windowStart = ts - (ts % limit.window_ms);
    const result = tx.execute(quotaCmdConsume({
      tenantId, resource, quantity, windowStart, maxPerWindow: limit.max_per_window,
    }));
    return result.rowsAffected > 0;
  }

  recordUsage(tenantId: string, resource: string, quantity = 1, now?: number): void {
    const tx = this.source.forTenant(tenantId);
    const ts = now ?? Date.now();
    const limit = tx.queryOne(quotaQueryLimit(tenantId, resource));
    const windowStart = limit ? ts - (ts % limit.window_ms) : ts;
    tx.execute(quotaCmdRecordUsage({ tenantId, resource, quantity, windowStart }));
  }

  /** Task 4 改为 fan-out + {totalDeleted,mayHaveMore}。本任务先保持单-source 语义（用 allDbs()[0] 或遍历——见 Task 4）。 */
  pruneUsageBefore(now: number, cutoff: number, batchSize = 1000): number {
    /* 临时：本任务只重构入口，prune 仍单次（用第一个/唯一 db）。Task 4 改 fan-out。 */
    return this.source.allDbs()[0]!.execute(quotaCmdPruneUsage({ now, cutoff, batchSize })).rowsAffected;
  }
}
```

> 注意 `checkQuota`/`consumeQuota` 内 `forTenant(tenantId)` 只调一次并复用 `tx` 变量（避免多次解析）。`consumeQuota` 里 `recordUsage` 递归调用会再解析一次 `forTenant`——resolver 模式下同 tenantId 返回同 db，无副作用；可接受。

- [ ] **Step 4: 跑测试（双入口新测试应绿，现有旧构造点测试可能编译红——下一步修）**

Run: `npm run build 2>&1 | grep -E "error TS" | head; echo "---"; node --test --test-force-exit dist/test/unit/quota-manager.test.js 2>&1 | grep -E "^ℹ (tests|pass|fail)"`
Expected: 新双入口测试逻辑正确；若现有 `new QuotaManager(db)` 因私有构造器编译红，Step 5 统一改。

- [ ] **Step 5: 迁移全部生产构造点（同提交，保编译过）**

按上方 Files 分类逐一替换。判据重申：**看变量声明静态类型**，非运行时。
- `fromUnitOfWork(x)` **仅两处**：`billing/plans.ts:58`（参数 `tx: SyncWriteUnitOfWork`）、`entitlement-service.ts:50`（`this.tx: SyncWriteUnitOfWork`）。
- 其余生产点全 `fromResolver(new SingleDbResolver(x))`（x 均声明 IDatabase：`sharedDb`/`sharedTx`/`queueTx`/`tx=db`/`optTx=options.db`(db?:IDatabase)/`sharedTx=this.sharedDb`(IDatabase)）。
- 每个 fromResolver 文件需 import `SingleDbResolver`（`../../storage/tenant-db-resolver.js`，相对深度按文件位置调整）。

- [ ] **Step 6: 迁移全部测试构造点 + 改 quota-manager.test.ts**

测试传的都是内存 db（IDatabase）。统一 `QuotaManager.fromUnitOfWork(db)`（单库语境，最贴近原「持单一 db」，不需 import SingleDbResolver，改动最小）。删 Step 1 占位断言行。列出的测试文件全改。

- [ ] **Step 7: typecheck + 全仓编译 + quota 测试绿 + grep 无残留**

Run:
```bash
npm run typecheck 2>&1 | tail -3
npm run build >/dev/null 2>&1; echo "build=$?"
grep -rn "new QuotaManager(" src --include="*.ts" && echo "!!! 有残留直接构造" || echo "无直接构造（预期，构造器已私有）"
node --test --test-force-exit dist/test/unit/quota-manager.test.js 2>&1 | grep -E "^ℹ (tests|pass|fail)"
```
Expected: typecheck 0；build 0；**无 `new QuotaManager(` 残留**；quota-manager 测试全绿。

- [ ] **Step 8: 提交**

```bash
git add -A
git commit -m "$(printf 'feat(multi-tenant): QuotaManager 双入口 + 全部构造点原子迁移\n\n私有构造器 + fromResolver/fromUnitOfWork 两工厂（QuotaSource 抽象两模式取 db）。\n同提交迁移全部 20+ 构造点保编译过：billing/plans+entitlement 走 fromUnitOfWork\n（声明仅 SyncWriteUnitOfWork），其余全 fromResolver(SingleDbResolver)（声明 IDatabase），\n测试统一 fromUnitOfWork。per-tenant 方法签名不变；pruneUsageBefore fan-out 见下任务。\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

### Task 4: `pruneUsageBefore` fan-out + `{totalDeleted,mayHaveMore}` + worker 适配

**Files:**
- Modify: `src/multi-tenant/quota-manager.ts`（`pruneUsageBefore` 改 fan-out + 新返回类型）
- Modify: `src/multi-tenant/quota-usage-retention-worker.ts`（适配新返回类型）
- Test: `src/test/unit/quota-usage-retention-worker.test.ts`（worker 现有测试适配）

**Interfaces:**
- Consumes: Task 3 的 `QuotaSource.allDbs()`。
- Produces: `pruneUsageBefore(now, cutoff, batchSize?): { totalDeleted: number; mayHaveMore: boolean }`。worker 用 `mayHaveMore` 判分页终止。

- [ ] **Step 1: 写失败测试（放到探针测试文件占位 + worker 测试适配）**

先改 worker 现有测试对返回值的用法（若它断言了 `pruneUsageBefore` 返回 number）。核对 `quota-usage-retention-worker.test.ts` 现有断言，改成解构 `{ totalDeleted, mayHaveMore }`。fan-out 本体断言在 Task 5 探针测试。

本步先加一条**返回类型**测试到 quota-manager.test.ts：

```ts
it('pruneUsageBefore 返回 {totalDeleted, mayHaveMore}', () => {
  const db = makeQuotaDb();
  const qm = QuotaManager.fromUnitOfWork(db);
  const r = qm.pruneUsageBefore(1000, 500, 10);
  assert.equal(typeof r.totalDeleted, 'number');
  assert.equal(typeof r.mayHaveMore, 'boolean');
});
```

- [ ] **Step 2: 跑确认失败**

Run: `npm run build 2>&1 | grep -E "error TS" | head; node --test --test-force-exit dist/test/unit/quota-manager.test.js 2>&1 | grep -E "^ℹ (tests|pass|fail)"`
Expected: FAIL —— 现返回 `number`，`.totalDeleted` 类型错 / 断言红。

- [ ] **Step 3: 改 pruneUsageBefore 为 fan-out**

`src/multi-tenant/quota-manager.ts`：

```ts
export interface PruneResult {
  readonly totalDeleted: number;
  /** 任一 shard 本轮 removed >= batchSize（保守分页信号，是否继续下一批）。 */
  readonly mayHaveMore: boolean;
}
```

```ts
  /**
   * 清理旧窗口行（计量只读当前窗口，旧窗口是死重）。绝不删当前窗口。
   * resolver 模式：fan-out 到 allShardDbs()（唯一物理 db），fail-fast——某 shard 抛错立即整体抛出，
   * 后续 shard 本轮不执行；无跨-shard 原子性，靠 prune 幂等下周期重试收敛。
   * UoW 模式：allDbs() 返 [tx]，等价单次 execute。
   * @returns totalDeleted 本轮各 shard 实删之和；mayHaveMore=任一 shard removed>=batchSize。
   */
  pruneUsageBefore(now: number, cutoff: number, batchSize = 1000): PruneResult {
    let totalDeleted = 0;
    let mayHaveMore = false;
    for (const db of this.source.allDbs()) {
      const removed = db.execute(quotaCmdPruneUsage({ now, cutoff, batchSize })).rowsAffected;
      totalDeleted += removed;
      if (removed >= batchSize) mayHaveMore = true;
    }
    return { totalDeleted, mayHaveMore };
  }
```

- [ ] **Step 4: 改 worker 适配新返回类型**

`src/multi-tenant/quota-usage-retention-worker.ts:81-88` 附近（`for` 分批循环里）：

```ts
    for (let i = 0; i < this.options.maxBatchesPerCycle; i++) {
      const { totalDeleted, mayHaveMore } = this.quota.pruneUsageBefore(now, cutoff, this.options.batchSize);
      total += totalDeleted;
      batches++;
      if (!mayHaveMore) break;
    }
```

（核对现有变量名 `removed`/`total`/`batches`——保持一致，只把 `removed < batchSize` 的终止判断换成 `!mayHaveMore`。）

- [ ] **Step 5: 改 worker 测试适配**

`src/test/unit/quota-usage-retention-worker.test.ts` 里若有对 `pruneUsageBefore` 返回值的直接断言，改解构 `{ totalDeleted, mayHaveMore }`。worker 的 flushOnce 返回 `{ deleted, batches }` 不变（内部适配）。

- [ ] **Step 6: 跑确认通过 + typecheck + 全量**

Run:
```bash
npm run typecheck 2>&1 | tail -2
npm run build >/dev/null 2>&1
node --test --test-force-exit dist/test/unit/quota-manager.test.js dist/test/unit/quota-usage-retention-worker.test.js 2>&1 | grep -E "^ℹ (tests|pass|fail)"
```
Expected: typecheck 0；两文件测试绿。

- [ ] **Step 7: 提交**

```bash
git add src/multi-tenant/quota-manager.ts src/multi-tenant/quota-usage-retention-worker.ts src/test/unit/quota-usage-retention-worker.test.ts src/test/unit/quota-manager.test.js 2>/dev/null; git add src/test/unit/quota-manager.test.ts
git commit -m "$(printf 'feat(multi-tenant): pruneUsageBefore fan-out + {totalDeleted,mayHaveMore}\n\nresolver 模式遍历 allShardDbs() fail-fast fan-out；返回结构化结果修分页语义\n（累加破坏 worker 的 removed<batchSize 终止假设）。worker 改用 mayHaveMore 判终止。\nUoW 模式 allDbs()=[tx] 等价单次。\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

### Task 5: 多-shard 探针测试（7 类断言 + 变异证明）

**Files:**
- Create: `src/test/unit/quota-manager-sharding.test.ts`

**Interfaces:**
- Consumes: `QuotaManager.fromResolver`、`FakeMultiShardResolver`（Task 2）、`SingleDbResolver`、`createMemoryDatabase` + quota 表建法。

- [ ] **Step 1: 写探针测试（7 类，一次写全）**

创建 `src/test/unit/quota-manager-sharding.test.ts`，覆盖 spec 的 7 类断言：

```ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { QuotaManager } from '../../multi-tenant/quota-manager.js';
import { FakeMultiShardResolver } from '../support/fake-multi-shard-resolver.js';
import { SingleDbResolver } from '../../storage/tenant-db-resolver.js';
import { createMemoryDatabase, runDslSqliteMigrations } from '../../storage/index.js';
import type { IDatabase } from '../../storage/database.js';

/** 建带 quota 表的内存 db（核对项目实际迁移入口——runDslSqliteMigrations 建全表；若有更窄的建 quota 表方式用之）。 */
function quotaDb(): IDatabase {
  const db = createMemoryDatabase();
  runDslSqliteMigrations(db);
  return db;
}

describe('QuotaManager 分片探针', () => {
  it('1. per-tenant 分流：写真落 dbForTenant 对应 shard', () => {
    const s1 = quotaDb(), s2 = quotaDb();
    const r = new FakeMultiShardResolver({ coordinator: s1, shards: { a: s1, b: s2 }, tenantToShard: { tA: 'a', tB: 'b' } });
    const qm = QuotaManager.fromResolver(r);
    qm.setLimit('tA', 'sim', 5, 60_000);
    qm.setLimit('tB', 'sim', 9, 60_000);
    const aOnS1 = s1.prepare('SELECT max_per_window AS m FROM quota_limits WHERE tenant_id=? AND resource=?').get('tA', 'sim') as { m: number } | undefined;
    const aOnS2 = s2.prepare('SELECT max_per_window AS m FROM quota_limits WHERE tenant_id=? AND resource=?').get('tA', 'sim') as { m: number } | undefined;
    assert.equal(aOnS1?.m, 5, 'tA 落 s1');
    assert.equal(aOnS2, undefined, 'tA 不在 s2');
    const bOnS2 = s2.prepare('SELECT max_per_window AS m FROM quota_limits WHERE tenant_id=? AND resource=?').get('tB', 'sim') as { m: number } | undefined;
    assert.equal(bOnS2?.m, 9, 'tB 落 s2');
  });

  it('2. fan-out：prune 跑遍所有 shard，totalDeleted 为各 shard 之和', () => {
    const s1 = quotaDb(), s2 = quotaDb();
    const r = new FakeMultiShardResolver({ coordinator: s1, shards: { a: s1, b: s2 }, tenantToShard: { tA: 'a', tB: 'b' } });
    const qm = QuotaManager.fromResolver(r);
    /* 各 shard 预置旧窗口 usage 行（用 recordUsage 在很早的 now 写，制造旧窗口）。 */
    qm.setLimit('tA', 'sim', 100, 1000); qm.consumeQuota('tA', 'sim', 1, 1_000);   // 落 s1，windowStart≈1000
    qm.setLimit('tB', 'sim', 100, 1000); qm.consumeQuota('tB', 'sim', 1, 1_000);   // 落 s2
    /* now 远大于旧窗口 + cutoff 覆盖旧窗口 → 两 shard 各删 1 行。 */
    const res = qm.pruneUsageBefore(10_000_000, 9_000_000, 1000);
    assert.equal(res.totalDeleted, 2, '两 shard 各删 1');
    assert.equal(res.mayHaveMore, false);
  });

  it('3. fan-out 去重：allShardDbs 唯一 → 同库不重复 prune', () => {
    const shared = quotaDb();
    /* 两 shardId 指向同一实例（模拟同 connStr）。FakeMultiShardResolver.allShardDbs 按实例去重 → 只 prune 一次。 */
    const r = new FakeMultiShardResolver({ coordinator: shared, shards: { a: shared, b: shared }, tenantToShard: { t: 'a' } });
    const qm = QuotaManager.fromResolver(r);
    qm.setLimit('t', 'sim', 100, 1000); qm.consumeQuota('t', 'sim', 1, 1_000);
    const res = qm.pruneUsageBefore(10_000_000, 9_000_000, 1000);
    assert.equal(res.totalDeleted, 1, '同库只删一次（非 2）');
  });

  it('4. mayHaveMore 分页信号', () => {
    const s1 = quotaDb(), s2 = quotaDb();
    const r = new FakeMultiShardResolver({ coordinator: s1, shards: { a: s1, b: s2 }, tenantToShard: {} });
    const qm = QuotaManager.fromResolver(r);
    /* s1 预置 >= batchSize 行旧窗口，s2 少量。batchSize=1 → s1 删 1 就 removed>=1=batchSize → mayHaveMore。 */
    seedOldUsage(s1, 2);  // helper：直接 INSERT 2 行旧窗口到 quota_usage
    seedOldUsage(s2, 0);
    const res = qm.pruneUsageBefore(10_000_000, 9_000_000, 1);  // batchSize=1
    assert.equal(res.mayHaveMore, true, 's1 删满一批 → 还有');
  });

  it('5. fan-out fail-fast：中途 shard 抛错 → 整体抛错 + 后续 shard 未执行 + 幂等重试收敛', () => {
    const s1 = quotaDb(), s3 = quotaDb();
    /* s2 是会抛错的 db 桩（execute 抛）。三 shard 顺序 a→bad→c。 */
    const bad = throwingDb();
    const r = new FakeMultiShardResolver({ coordinator: s1, shards: { a: s1, bad: bad, c: s3 }, tenantToShard: {} });
    const qm = QuotaManager.fromResolver(r);
    seedOldUsage(s1, 1);
    seedOldUsage(s3, 1);
    assert.throws(() => qm.pruneUsageBefore(10_000_000, 9_000_000, 1000), /boom/);
    /* s1 已删（fail-fast 前）；s3 本轮未执行（bad 在 s3 之前抛）——观测 s3 旧行仍在。 */
    const s3Remaining = (s3.prepare('SELECT COUNT(*) AS c FROM quota_usage').get() as { c: number }).c;
    assert.equal(s3Remaining, 1, 's3 本轮未被触碰（后续 shard 不跑）');
  });

  it('6. UoW 模式：固定 tx、prune 单次不 fan-out', () => {
    const db = quotaDb();
    const qm = QuotaManager.fromUnitOfWork(db);
    qm.setLimit('t', 'sim', 3, 60_000);
    const row = db.prepare('SELECT max_per_window AS m FROM quota_limits WHERE tenant_id=? AND resource=?').get('t', 'sim') as { m: number };
    assert.equal(row.m, 3);
    seedOldUsage(db, 1);
    const res = qm.pruneUsageBefore(10_000_000, 9_000_000, 1000);
    assert.equal(res.totalDeleted, 1);
  });

  it('7. 单库零回归：SingleDbResolver 行为等价单库', () => {
    const db = quotaDb();
    const qm = QuotaManager.fromResolver(new SingleDbResolver(db));
    qm.setLimit('t', 'sim', 4, 60_000);
    assert.equal(qm.checkQuota('t', 'sim', 1, 1_000), true);
    seedOldUsage(db, 1);
    const res = qm.pruneUsageBefore(10_000_000, 9_000_000, 1000);
    assert.equal(res.totalDeleted, 1);
    assert.equal(res.mayHaveMore, false);
  });
});
```

实现者须补两个 helper（本文件内）：`seedOldUsage(db, n)` 直接向 `quota_usage` INSERT n 行 window_start 很早的行（核对 quota_usage 表真实列名：tenant_id/resource/window_start/used 等，用 db.exec 或 prepare INSERT）；`throwingDb()` 返回一个 `execute` 抛 `Error('boom')`、其余方法 no-op 的最小 `IDatabase` 桩（只需满足 fan-out 遍历时调 execute 抛错）。

- [ ] **Step 2: 跑确认通过**

Run: `npm run build >/dev/null 2>&1; node --test --test-force-exit dist/test/unit/quota-manager-sharding.test.js 2>&1 | grep -E "^ℹ (tests|pass|fail)"`
Expected: 7 类全绿。

- [ ] **Step 3: 变异证明（手动验证，不提交变异）**

临时改 `quota-manager.ts`：把 `fromResolver` 的 `forTenant` 改成恒 `resolver.coordinatorDb()`（无视 tenantId），重 build 跑探针——断言「1. per-tenant 分流」应变红（tA/tB 都落 coordinator）。再把 `pruneUsageBefore` 的 fan-out 改成只 `allDbs()[0]`，跑——「2. fan-out」应变红。**确认两处变异各自触发对应测试红后，`git checkout src/multi-tenant/quota-manager.ts` 还原**，重 build 确认 7 类重新全绿、`git diff` 干净。把变异结果写进 report。

- [ ] **Step 4: 提交**

```bash
git add src/test/unit/quota-manager-sharding.test.ts
git commit -m "$(printf 'test(multi-tenant): QuotaManager 分片探针（7 类 + 变异证明）\n\n注独立物理 db 断言：per-tenant 分流/fan-out/去重/mayHaveMore 分页/fail-fast\n后续 shard 不跑/UoW 模式/单库零回归。变异验证（forTenant 恒 coordinator、\nprune 只碰首 db）各触发对应测试红后还原。\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

### Task 6: 全量回归 + inventory/ratchet 验证

> 构造点已在 Task 3 原子迁移完毕。本任务是**全仓验证**：确认零回归、ratchet 不变、集成测试未被适配包装弄坏。无源码改动（除非发现回归须修）。

**Files:** 无预期改动（验证任务；若全量回归红则定位修复）。

**Interfaces:**
- Consumes: Task 1-5 的全部产物。
- Produces: 零回归铁证（全量 unit fail=0）+ ratchet exit 0。

- [ ] **Step 1: 复核无残留直接构造**

Run: `grep -rn "new QuotaManager(" src --include="*.ts" && echo "!!! 有残留" || echo "无直接构造（预期）"`
Expected: 无残留（Task 3 已全迁移；若有则补迁按声明类型判据分类）。

- [ ] **Step 2: 全量 unit 回归**

Run:
```bash
npm run typecheck 2>&1 | tail -2; npm run build >/dev/null 2>&1; echo "build=$?"
node --test --test-force-exit 'dist/test/unit/**/*.test.js' 2>&1 | grep -E "^ℹ (tests|suites|pass|fail)"
```
Expected: typecheck 0；build 0；**全量 unit fail=0**（零回归铁证）。

- [ ] **Step 3: ratchet 不变验证**

Run: `node scripts/check-db-access-ratchet.mjs; echo "ratchet=$?"`
Expected: exit 0。QuotaManager 改持 resolver 不命中 ratchet PATTERN；route 的 `longlived-root-capture` 条目保留、inventory 条数不变（对照 Task 前 26 条）。

- [ ] **Step 4: 集成测试点验（Task 3 改了这些 integration 测试构造点）**

Run:
```bash
node --test --test-force-exit \
  dist/test/integration/companion-perceive-stream.test.js \
  dist/test/integration/companion-perceive-api.test.js \
  dist/test/integration/negative-rate-limit-bypass.test.js \
  dist/test/integration/companion-api.test.js \
  dist/test/integration/companion-chat-api.test.js \
  dist/test/integration/quota-usage-prune-pg.test.js \
  2>&1 | grep -E "^ℹ (tests|pass|fail)"
```
Expected: 全绿（PG 相关若本机无 PG 则相应条目 SKIP，非 fail）。

- [ ] **Step 5: 无提交（纯验证）或补记**

本任务无源码改动则无需提交。若 Step 2/4 发现回归并修复，则提交修复（commit message 描述具体回归 + 修法）。

---

## Self-Review

**1. Spec coverage**（逐条对 spec）：
- 前置修 allShardDbs 去重 → Task 1。✓
- FakeMultiShardResolver 脚手架 → Task 2。✓
- 双入口 fromResolver/fromUnitOfWork + 全部 20+ 构造点原子迁移（fromUnitOfWork 仅 billing/entitlement）→ Task 3。✓
- pruneUsageBefore fan-out fail-fast + {totalDeleted,mayHaveMore} + worker 适配 → Task 4。✓
- 7 类探针 + 变异证明 → Task 5。✓
- inventory 不动 / ratchet 通过 → Task 6 Step 3 验。✓
- 零回归全量 → Task 6 Step 2。✓

**2. Placeholder scan:** Task 3 Step 1 有一处标注的占位断言行——**明确指令 Step 6 删除**，非遗留。helper（seedOldUsage/throwingDb/quotaDb）给了明确职责 + 核对点。无 TBD。

**3. Type consistency:** `PruneResult { totalDeleted; mayHaveMore }` 在 Task 4 定义，worker（Task 4 Step 4）+ 探针（Task 5）一致解构；`fromResolver`/`fromUnitOfWork`/`QuotaSource` 在 Task 3 定义，Task 5 一致引用；`FakeMultiShardResolver` 构造签名（`{coordinator, shards, tenantToShard}`）在 Task 2 定义，Task 3/5 一致用。

**4. 编译原子性（关键，已在结构解决）:** 私有化构造器会让全仓 `new QuotaManager(` 立即编译红。**Task 3 在同一提交内**完成「双入口重构 + 全部构造点迁移」（Step 5 生产点 + Step 6 测试点），每个提交都编译过。Task 4/5 建立在 Task 3 已全迁移的基础（`new QuotaManager` 已不存在），无耦合遗留；Task 6 退化为纯验证。

**注意点（实现者留意）：**
- quota 表真实列名（quota_limits: tenant_id/resource/max_per_window/window_ms；quota_usage: tenant_id/resource/window_start/used）以实际迁移为准——探针测试 SQL 和 seedOldUsage 须核对真实列名（实现前 `grep -rn "quota_limits\|quota_usage" packages/schema-dsl/src` 或读迁移确认）。
- Task 3 是本计划最大任务（重构 + 20+ 点迁移），实现者可能报 DONE_WITH_CONCERNS——控制者按 SDD 常规处理。
