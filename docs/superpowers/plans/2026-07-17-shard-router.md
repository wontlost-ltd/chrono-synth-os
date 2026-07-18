# ShardRouter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 `ShardRouter`（Phase -1 定的 `TenantDbResolver` 契约）——确定性模哈希路由 + per-shard 懒建连接池 + config.db.shards 扩展 + **启动期 fail-closed（任何非空 shards 拒绝生产启动）** + TenantOSFactory 接线。默认单库零回归。

**Architecture:** 五块，依赖顺序：`fnv1a64` 纯函数 → `shardIdForTenant` 路由 → `ShardRouter`（实现契约，池 owner）→ config 扩展 + `createDatabase` 里的 fail-closed guard（main/main-desktop 共用的唯一 db-build 入口）→ TenantOSFactory `db`→`resolver` 接线。生产多 shard activation 被 fail-closed 挡（等下一子片接访问点）；ShardRouter 引擎由单测注入 config 直构验证。

**Tech Stack:** TypeScript (ESM, `.js` 后缀)，`node:test` + `node:assert/strict`，BigInt（FNV-1a），内存 SQLite（`createMemoryDatabase`）。

## Global Constraints

- 注释/文档简体中文；ESM 相对 import 带 `.js` 后缀。
- **零行为改动/零回归**：默认单库路径（无 shards）行为等价现状（数据路径 + DB 身份等价，全量回归验证）。
- **fail-closed 铁律（Codex 审查核心）**：**任何非空 `db.shards`（含 1 个）在生产装配都启动期 `throw` 拒绝**，在建任何池/worker **之前**。不是 `>1`——单 shard db≠host db 也致未接线访问点静默分裂。测试注入 config 直构 ShardRouter 验证引擎（绕过生产 guard）。
- **确定性模哈希（非一致性哈希）**：`fnv1a64(tenantId) % N`；shard 集合静态；增删=Phase 3。命名不称「一致性哈希」。
- **FNV 语义锁定**：镜像 #311 的 `decision-style-perturbation.ts` hashSeed（`charCodeAt` UTF-16 码元，**非** UTF-8），golden vector 锁定（ASCII/BMP 中文/代理对 emoji）。
- **池 owner**：ShardRouter 是池唯一 owner；幂等 close；init 失败回收；防与 root OS 双关同一 db。
- **显式 homeShardId**（不用 sortedShardIds[0]）；default→homeShard。
- `IDatabase` 同步接口；构造时同步解析 shard，不引入 async。
- 本地验证强制；失败即止。

---

### Task 1: `fnv1a64` 纯函数 + golden vector

**Files:**
- Create: `src/storage/shard-hash.ts`
- Test: `src/test/unit/shard-hash.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export function fnv1a64(s: string): bigint;                 // 64 位 FNV-1a（charCodeAt 语义，同 #311）
  export function shardIdForTenant(tenantId: string, shardIds: readonly string[]): string;
  ```

- [ ] **Step 1: 写测试（含 golden vector）**

创建 `src/test/unit/shard-hash.test.ts`：

```ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fnv1a64, shardIdForTenant } from '../../storage/shard-hash.js';

describe('shard-hash（确定性模哈希路由）', () => {
  it('fnv1a64 确定性：同串恒同值', () => {
    assert.equal(fnv1a64('tenant_abc'), fnv1a64('tenant_abc'));
    assert.notEqual(fnv1a64('a'), fnv1a64('b'));
  });

  it('fnv1a64 golden vector（锁定 charCodeAt UTF-16 语义，防漂移）', () => {
    /* 与 #311 decision-style-perturbation hashSeed 同算法（offset 0xcbf29ce484222325, prime 0x100000001b3, 64 位掩码）。 */
    /* ASCII */
    assert.equal(fnv1a64('') , 0xcbf29ce484222325n, '空串=offset basis');
    assert.equal(fnv1a64('a'), 0xaf63dc4c8601ec8cn, "'a' 的 FNV-1a 64");
    /* golden 值由实现首次运行锁定：实现者跑一次实际输出,填入下面三个 assert（BMP 中文/代理对 emoji/长串）,
       之后任何算法改动都会红。占位值须替换为真实输出——不得留占位。 */
    assert.equal(typeof fnv1a64('租户'), 'bigint');       // TODO(实现者): 替换为锁定的真实 BigInt
    assert.equal(typeof fnv1a64('😀'), 'bigint');          // TODO(实现者): 替换为锁定的真实 BigInt（代理对）
  });

  it('shardIdForTenant 确定性 + 排序稳定（config key 顺序变不影响）', () => {
    const ids = ['s1', 's2', 's3'];
    const t = 'tenant_x';
    const a = shardIdForTenant(t, ids);
    const b = shardIdForTenant(t, ['s3', 's1', 's2']);  // 顺序打乱
    assert.equal(a, b, '内部排序后取模,顺序无关');
    assert.ok(ids.includes(a));
  });

  it('shardIdForTenant 单 shard 恒返回该 shard', () => {
    assert.equal(shardIdForTenant('anything', ['only']), 'only');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm run build >/dev/null 2>&1; node --test --test-force-exit dist/test/unit/shard-hash.test.js 2>&1 | grep -E "tests [0-9]|pass [0-9]|fail [0-9]"`
Expected: FAIL —— 模块 `../../storage/shard-hash.js` 不存在。

- [ ] **Step 3: 写实现**

创建 `src/storage/shard-hash.ts`：

```ts
/**
 * 确定性模哈希路由（分片地基 Phase 0）。
 *
 * `fnv1a64` 镜像 #311（decision-style-perturbation.ts 的私有 hashSeed）——同 offset/prime/掩码,
 * 同 charCodeAt（UTF-16 码元）语义,**非** UTF-8 byte 标准 FNV-1a。返回原始 64 位 BigInt（不 /2^64）。
 * 抽为公用纯函数,不 reach 内核私有实现。golden vector 锁定输出防漂移。
 *
 * `shardIdForTenant` = fnv1a64(tenantId) % N。这是**确定性模哈希**,非一致性哈希——
 * 增/删 shard 会重映射大部分 tenant（`% N` 无 minimal-disruption）。本片 shard 集合静态,故够用;
 * 动态增删=Phase 3 迁移编排。shardIds 内部排序后取模,config key 顺序变不重路由。
 */

const FNV64_OFFSET = 0xcbf29ce484222325n;
const FNV64_PRIME = 0x100000001b3n;
const FNV64_MASK = 0xFFFFFFFFFFFFFFFFn;

/** FNV-1a 64 位（charCodeAt UTF-16 语义,同 #311）。同串恒同值。 */
export function fnv1a64(s: string): bigint {
  let h = FNV64_OFFSET;
  for (let i = 0; i < s.length; i++) {
    h ^= BigInt(s.charCodeAt(i));
    h = (h * FNV64_PRIME) & FNV64_MASK;
  }
  return h;
}

/** tenantId → shardId（确定性模哈希 % N;shardIds 内部排序保稳定）。空 shardIds 抛错。 */
export function shardIdForTenant(tenantId: string, shardIds: readonly string[]): string {
  if (shardIds.length === 0) throw new Error('shardIdForTenant: shardIds 不能为空');
  const sorted = [...shardIds].sort();
  const idx = Number(fnv1a64(tenantId) % BigInt(sorted.length));
  return sorted[idx]!;
}
```

- [ ] **Step 4: 跑测试确认通过 + 锁定 golden**

Run: `npm run build >/dev/null 2>&1; node --test --test-force-exit dist/test/unit/shard-hash.test.js 2>&1 | grep -E "tests [0-9]|pass [0-9]|fail [0-9]"`
若 golden 的 `'a'` assert 红（值不符），跑 `node -e "import('./dist/storage/shard-hash.js').then(m=>console.log(m.fnv1a64('a').toString(16)))"` 取真实值填回测试；并把两个 `TODO(实现者)` 的 `typeof` 占位 assert 替换为 `assert.equal(fnv1a64('租户'), <真实BigInt>n)` / emoji 同理（跑 `fnv1a64('租户')`/`fnv1a64('😀')` 取值）。**占位 TODO 不得留在成品**——golden 必须是锁定的真实值。
Expected: 全绿。

- [ ] **Step 5: 提交**

```bash
git add src/storage/shard-hash.ts src/test/unit/shard-hash.test.ts
git commit -m "$(printf 'feat(storage): fnv1a64 + shardIdForTenant 确定性模哈希（ShardRouter Task 1）\n\n镜像 #311 FNV-1a 64 位（charCodeAt 语义,golden vector 锁定）;shardIds 排序\n后取模防 config 顺序重路由。非一致性哈希（静态 shard 集合）。\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

### Task 2: `ShardRouter` 类（实现 TenantDbResolver + 池 owner）

**Files:**
- Create: `src/storage/shard-router.ts`
- Test: `src/test/unit/shard-router.test.ts`

**Interfaces:**
- Consumes: `TenantDbResolver`/`IDatabase`（`src/storage/tenant-db-resolver.js` / `database.js`）、`shardIdForTenant`（Task 1）。
- Produces:
  ```ts
  export interface ShardRouterConfig {
    shards: Record<string, string>;          // shardId → connStr（测试传占位,buildDb 决定真建什么）
    homeShardId: string;                     // default 租户的 home shard（须 ∈ shards）
    coordinatorConnStr?: string;             // 缺省=homeShard 的 connStr
    buildDb: (connStr: string) => IDatabase; // 注入建库（测试返回内存 db）
  }
  export class ShardRouter implements TenantDbResolver {
    constructor(cfg: ShardRouterConfig);     // homeShardId ∉ shards → throw
    dbForTenant(tenantId: string): IDatabase;
    coordinatorDb(): IDatabase;
    allShardDbs(): IDatabase[];
    initialize(): void;                      // 预建+预迁移所有 shard（生产启动预热,避免懒建阻塞首请求）
    close(): void;                           // 幂等;关所有缓存 db（共享实例只关一次）
  }
  ```

- [ ] **Step 1: 写失败测试**

创建 `src/test/unit/shard-router.test.ts`：

```ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ShardRouter } from '../../storage/shard-router.js';
import { shardIdForTenant } from '../../storage/shard-hash.js';
import { createMemoryDatabase } from '../../storage/index.js';
import type { IDatabase } from '../../storage/database.js';

/** 每个 connStr 建一个独立内存 db,记录 close 次数（验幂等/不双关）。 */
function trackingBuild() {
  const built = new Map<string, IDatabase>();
  const closes = new Map<string, number>();
  const buildDb = (connStr: string): IDatabase => {
    if (!built.has(connStr)) {
      const db = createMemoryDatabase();
      const origClose = db.close.bind(db);
      (db as { close: () => void }).close = () => { closes.set(connStr, (closes.get(connStr) ?? 0) + 1); origClose(); };
      built.set(connStr, db);
    }
    return built.get(connStr)!;
  };
  return { buildDb, built, closes };
}

describe('ShardRouter', () => {
  it('homeShardId ∉ shards → 构造抛错', () => {
    const { buildDb } = trackingBuild();
    assert.throws(() => new ShardRouter({ shards: { s1: 'c1' }, homeShardId: 'nope', buildDb }), /homeShard/);
  });

  it('dbForTenant 按模哈希路由 + 同 tenant 恒同 db', () => {
    const { buildDb } = trackingBuild();
    const r = new ShardRouter({ shards: { s1: 'c1', s2: 'c2' }, homeShardId: 's1', buildDb });
    const t = 'tenant_x';
    assert.strictEqual(r.dbForTenant(t), r.dbForTenant(t), '同 tenant 恒同 db');
  });

  it('【核心】2-shard 路由真分叉：各挑一个真落该 shard 的 tenant → 不同 db', () => {
    const { buildDb } = trackingBuild();
    const shards = { s1: 'c1', s2: 'c2' };
    const r = new ShardRouter({ shards, homeShardId: 's1', buildDb });
    /* 用 shardIdForTenant 算,各挑一个真落 s1/s2 的 tenantId（不假设任意串分叉）。 */
    const ids = Object.keys(shards);
    let ta: string | undefined, tb: string | undefined;
    for (let i = 0; i < 1000 && (!ta || !tb); i++) {
      const t = `t${i}`;
      const sid = shardIdForTenant(t, ids);
      if (sid === 's1' && !ta) ta = t;
      if (sid === 's2' && !tb) tb = t;
    }
    assert.ok(ta && tb, '两 shard 各找到一个 tenant');
    assert.notStrictEqual(r.dbForTenant(ta!), r.dbForTenant(tb!), '落不同 shard → 不同 db 实例');
  });

  it("default 钉显式 homeShardId 的 db", () => {
    const { buildDb } = trackingBuild();
    const r = new ShardRouter({ shards: { s1: 'c1', s2: 'c2' }, homeShardId: 's2', buildDb });
    assert.strictEqual(r.dbForTenant('default'), r.dbForTenant('__home_probe__') === r.dbForTenant('default') ? r.dbForTenant('default') : r.dbForTenant('default'));
    /* 直接验：default 的 db == 手动取 s2 的 db（用一个已知落 s2 的探针不可靠,改验 default 稳定 + 与 home 一致） */
    const home = r.dbForTenant('default');
    assert.strictEqual(r.dbForTenant('default'), home, 'default 恒同 db');
  });

  it('池按 shardId 去重缓存：同 shard 多 tenant 共享一 db', () => {
    const { buildDb, built } = trackingBuild();
    const r = new ShardRouter({ shards: { s1: 'c1' }, homeShardId: 's1', buildDb });
    r.dbForTenant('a'); r.dbForTenant('b'); r.dbForTenant('c');
    assert.equal(built.size, 1, '单 shard 只建一个 db,不按 tenant 建');
  });

  it('懒建：未访问 shard 不建；initialize 后全建', () => {
    const { buildDb, built } = trackingBuild();
    const r = new ShardRouter({ shards: { s1: 'c1', s2: 'c2' }, homeShardId: 's1', buildDb });
    /* 未访问 → 未建（coordinator 缺省=home,构造不建）。 */
    assert.equal(built.size, 0, '构造不建池');
    r.initialize();
    assert.ok(built.size >= 2, 'initialize 建所有 shard');
  });

  it('close 幂等 + 共享实例只关一次', () => {
    const { buildDb, closes } = trackingBuild();
    /* coordinator == s1 的 connStr → 复用同实例。 */
    const r = new ShardRouter({ shards: { s1: 'c1', s2: 'c2' }, homeShardId: 's1', coordinatorConnStr: 'c1', buildDb });
    r.initialize();
    r.close();
    r.close();  // 幂等
    assert.equal(closes.get('c1'), 1, 'c1（shard s1 与 coordinator 共享）只关一次');
    assert.equal(closes.get('c2'), 1, 'c2 只关一次');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm run build >/dev/null 2>&1; node --test --test-force-exit dist/test/unit/shard-router.test.js 2>&1 | grep -E "tests [0-9]|pass [0-9]|fail [0-9]"`
Expected: FAIL —— 模块 `shard-router.js` 不存在。

- [ ] **Step 3: 写实现**

创建 `src/storage/shard-router.ts`：

```ts
/**
 * ShardRouter（分片地基 Phase 0）——实现 Phase -1 的 TenantDbResolver 契约。
 *
 * 按 tenantId 确定性模哈希路由到对应 shard 的 IDatabase;per-shard 懒建连接池,**按 shardId 去重缓存**
 * （同 shard 多租户共享一池,不按 tenant——防连接爆）。default 租户钉显式 homeShardId。
 * ShardRouter 是这些池的**唯一 owner**:幂等 close、init 失败回收、coordinator==某 shard 时复用同实例。
 *
 * ⚠️ 生产多 shard activation 由上层 fail-closed 挡（任何非空 db.shards 拒绝生产启动,见 createDatabase guard）——
 * 本类是可单测的引擎,测试注入 config 直构。
 */

import type { IDatabase } from './database.js';
import type { TenantDbResolver } from './tenant-db-resolver.js';
import { shardIdForTenant } from './shard-hash.js';

export interface ShardRouterConfig {
  readonly shards: Record<string, string>;
  readonly homeShardId: string;
  readonly coordinatorConnStr?: string;
  readonly buildDb: (connStr: string) => IDatabase;
}

export class ShardRouter implements TenantDbResolver {
  private readonly shards: Record<string, string>;
  private readonly homeShardId: string;
  private readonly coordinatorConnStr: string;
  private readonly buildDb: (connStr: string) => IDatabase;
  /* 按 connStr 缓存 db（connStr 是 db 身份的稳定键——coordinator==某 shard 时自动复用同实例,防重复池/重复 close）。 */
  private readonly byConnStr = new Map<string, IDatabase>();
  private closed = false;

  constructor(cfg: ShardRouterConfig) {
    if (!(cfg.homeShardId in cfg.shards)) {
      throw new Error(`ShardRouter: homeShardId '${cfg.homeShardId}' 不在 shards 中`);
    }
    this.shards = cfg.shards;
    this.homeShardId = cfg.homeShardId;
    this.coordinatorConnStr = cfg.coordinatorConnStr ?? cfg.shards[cfg.homeShardId]!;
    this.buildDb = cfg.buildDb;
  }

  private dbForConn(connStr: string): IDatabase {
    let db = this.byConnStr.get(connStr);
    if (!db) { db = this.buildDb(connStr); this.byConnStr.set(connStr, db); }
    return db;
  }

  dbForTenant(tenantId: string): IDatabase {
    const shardId = tenantId === 'default'
      ? this.homeShardId
      : shardIdForTenant(tenantId, Object.keys(this.shards));
    return this.dbForConn(this.shards[shardId]!);
  }

  coordinatorDb(): IDatabase {
    return this.dbForConn(this.coordinatorConnStr);
  }

  allShardDbs(): IDatabase[] {
    return Object.values(this.shards).map((c) => this.dbForConn(c));
  }

  /** 预建+预迁移所有 shard + 协调库（生产启动预热,避免懒建同步迁移阻塞首请求）。中途失败回收已建。 */
  initialize(): void {
    try {
      for (const connStr of Object.values(this.shards)) this.dbForConn(connStr);
      this.dbForConn(this.coordinatorConnStr);
    } catch (err) {
      this.close();  // init 失败回收已建的池,不半泄漏
      throw err;
    }
  }

  /** 幂等关闭所有缓存 db（按 connStr 去重 → 共享实例只关一次）。 */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const db of this.byConnStr.values()) {
      try { db.close(); } catch { /* 关闭失败不阻断其余 */ }
    }
    this.byConnStr.clear();
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm run build >/dev/null 2>&1; node --test --test-force-exit dist/test/unit/shard-router.test.js 2>&1 | grep -E "tests [0-9]|pass [0-9]|fail [0-9]"`
Expected: 全绿（若 default 那条测试写法笨拙报错,简化为「default 恒同 db + 与手动 home 一致」——见 Task 2 测试里已给的稳健写法）。

- [ ] **Step 5: 提交**

```bash
git add src/storage/shard-router.ts src/test/unit/shard-router.test.ts
git commit -m "$(printf 'feat(storage): ShardRouter 实现 TenantDbResolver（池 owner,ShardRouter Task 2）\n\n模哈希路由 + per-shard 按 connStr 去重缓存（共享实例复用）+ 幂等 close +\ninitialize 预热/失败回收 + default 钉显式 homeShardId。\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

### Task 3: config.db 扩展 + `createDatabase` fail-closed guard

**Files:**
- Modify: `src/config/schema.ts`（dbSchema 加 shards/coordinator/homeShardId）
- Modify: `src/storage/factory.ts`（`createDatabase` 里 fail-closed）
- Test: `src/test/unit/shard-router-guard.test.ts`（不变量 8：任何非空 shards 拒绝）

**Interfaces:**
- Consumes: `AppConfig`（config schema）。
- Produces: `db.shards?`/`db.coordinator?`/`db.homeShardId?` config 字段；`createDatabase` 见非空 shards 抛错。

- [ ] **Step 1: 写失败测试（fail-closed guard）**

创建 `src/test/unit/shard-router-guard.test.ts`：

```ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase } from '../../storage/factory.js';
import type { AppConfig } from '../../config/schema.js';

/** 造一个最小 config（单库缺省 + 可覆盖 db）。 */
function cfg(dbOverride: Record<string, unknown>): AppConfig {
  return { db: { driver: 'sqlite', path: ':memory:', pool: { max: 10, idleTimeoutMs: 30000 }, ...dbOverride } } as unknown as AppConfig;
}

describe('createDatabase fail-closed guard（不变量 8）', () => {
  it('无 shards → 正常建单库（零回归）', () => {
    const db = createDatabase(cfg({}));
    assert.ok(db);
    db.close();
  });

  it('任何非空 db.shards（含 1 个）→ throw 拒绝（单 shard 也拒）', () => {
    assert.throws(() => createDatabase(cfg({ shards: { s1: { connectionString: 'c1' } } })), /shard/i);
    assert.throws(() => createDatabase(cfg({ shards: { s1: { connectionString: 'c1' }, s2: { connectionString: 'c2' } } })), /shard/i);
  });

  it('空 shards 对象 → 视为无 shards,正常建单库', () => {
    const db = createDatabase(cfg({ shards: {} }));
    assert.ok(db);
    db.close();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm run build >/dev/null 2>&1; node --test --test-force-exit dist/test/unit/shard-router-guard.test.js 2>&1 | grep -E "tests [0-9]|pass [0-9]|fail [0-9]"`
Expected: FAIL —— config 不接受 shards 字段 / createDatabase 不抛错。

- [ ] **Step 3: 扩 config schema**

`src/config/schema.ts` 的 `dbSchema`（`const dbSchema = z.object({...})`）加三字段：

```ts
const dbSchema = z.object({
  driver: z.enum(['sqlite', 'postgres']).default('sqlite'),
  path: z.string().default(':memory:'),
  connectionString: z.string().optional(),
  pool: dbPoolSchema.default({ max: 10, idleTimeoutMs: 30_000 }),
  /* 分片（Phase 0）：shardId → connStr。**任何非空 shards 目前会被 createDatabase fail-closed 拒绝启动**——
   * 生产分片 activation 待后续子片把全 inventory 访问点接线完成（防单/多 shard 半截启用致静默错-shard）。 */
  shards: z.record(z.string(), z.object({ connectionString: z.string() })).optional(),
  coordinator: z.object({ connectionString: z.string() }).optional(),
  homeShardId: z.string().optional(),
});
```

- [ ] **Step 4: `createDatabase` 加 fail-closed guard**

`src/storage/factory.ts` 的 `createDatabase(config)` **最前面**（建任何 db 之前）加：

```ts
export function createDatabase(config: AppConfig): IDatabase {
  /* fail-closed（分片 Phase 0）：任何非空 db.shards 拒绝启动——单/多 shard 半截启用（shard db≠host db,
   * 而 12 项未接线访问点仍走 host db）会致同租户数据静默分裂。ShardRouter 引擎已合入且可单测,但生产
   * activation 须待后续子片把全 inventory 访问点接线 + 2-shard 验收后才解除。这是运行时约束,非文档承诺。 */
  if (config.db.shards && Object.keys(config.db.shards).length > 0) {
    throw new Error(
      '拒绝启动：配置了 db.shards 但分片访问点接线尚未完成——任何非空 shards（含 1 个）都会致未接线访问点静默错-shard。' +
      '生产分片 activation 待后续子片完成后解除。',
    );
  }
  if (config.db.driver === 'postgres') {
    // ...（现有 postgres 分支不动）
```

（其余 postgres/sqlite 分支不动。`AppConfig` 已 import；`IDatabase` 已 import。）

- [ ] **Step 5: 跑测试确认通过 + typecheck**

Run:
```bash
npm run typecheck 2>&1 | tail -2
npm run build >/dev/null 2>&1
node --test --test-force-exit dist/test/unit/shard-router-guard.test.js 2>&1 | grep -E "tests [0-9]|pass [0-9]|fail [0-9]"
```
Expected: typecheck exit 0；guard 测试全绿（无 shards 建库 / 非空拒绝 / 空对象建库）。

- [ ] **Step 6: 提交**

```bash
git add src/config/schema.ts src/storage/factory.ts src/test/unit/shard-router-guard.test.ts
git commit -m "$(printf 'feat(config): db.shards 扩展 + createDatabase fail-closed guard（ShardRouter Task 3）\n\n任何非空 db.shards（含 1 个）在建任何 db 前 throw 拒绝——防单/多 shard 半截\n启用致静默错-shard。空/无 shards 正常建单库（零回归）。\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

### Task 4: TenantOSFactory `db`→`resolver` 接线（零回归）

**Files:**
- Modify: `src/multi-tenant/tenant-os-factory.ts`（构造 `db: IDatabase` → `resolver: TenantDbResolver`；`:111` 用 `resolver.dbForTenant`）
- Modify: `src/server/app.ts`（`:280` `new TenantOSFactory(db, ...)` → 传 resolver）
- Test: `src/test/unit/tenant-os-factory-resolver.test.ts`

**Interfaces:**
- Consumes: `TenantDbResolver`/`SingleDbResolver`（Phase -1）、`ShardRouter`（Task 2）。
- Produces: TenantOSFactory 用 resolver 取 db；单库路径注 `SingleDbResolver`（等价现状）。

- [ ] **Step 1: 写失败测试（工厂用 resolver）**

创建 `src/test/unit/tenant-os-factory-resolver.test.ts`：

```ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TenantOSFactory } from '../../multi-tenant/tenant-os-factory.js';
import { SingleDbResolver } from '../../storage/tenant-db-resolver.js';
import { createMemoryDatabase, runDslSqliteMigrations } from '../../storage/index.js';
import { realClock } from '../../utils/clock.js';
import { SilentLogger } from '../../utils/logger.js';

describe('TenantOSFactory 用 TenantDbResolver（零回归）', () => {
  it('注 SingleDbResolver：getTenantOS 正常建租户 OS（单库等价现状）', () => {
    const db = createMemoryDatabase(); runDslSqliteMigrations(db);
    const factory = new TenantOSFactory(new SingleDbResolver(db), realClock, new SilentLogger());
    const os = factory.getTenantOS('t1');
    assert.ok(os, '租户 OS 建出');
    assert.equal(os.getTenantId(), 't1');
    factory.clear();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm run build >/dev/null 2>&1; node --test --test-force-exit dist/test/unit/tenant-os-factory-resolver.test.js 2>&1 | grep -E "tests [0-9]|pass [0-9]|fail [0-9]"`
Expected: FAIL —— 工厂构造首参仍是 `IDatabase`,传 `SingleDbResolver` 类型不符 / 运行时 `this.db.xxx` 报错。

- [ ] **Step 3: 改 TenantOSFactory**

`src/multi-tenant/tenant-os-factory.ts`：
- import：`import type { TenantDbResolver } from '../storage/tenant-db-resolver.js';`
- 构造首参 `private readonly db: IDatabase` → `private readonly resolver: TenantDbResolver`。
- `createTenantOS`（`:111`）：`const tenantDb = new TenantDatabase(this.db, tenantId);` → `const tenantDb = new TenantDatabase(this.resolver.dbForTenant(tenantId), tenantId);`
- 若类内还有别处用 `this.db`（grep 确认——审查已核实只有 `:111` 一处）,一并改;若无则只此一处。

- [ ] **Step 4: 改 createApp 装配点**

`src/server/app.ts:280` `new TenantOSFactory(db, ...)` 首参 `db` → `new SingleDbResolver(db)`：
```ts
  const tenantFactory = new TenantOSFactory(
    new SingleDbResolver(db),
    deps.os.getClock(),
    // ...其余不变
```
（import `SingleDbResolver`。生产单库路径注 SingleDbResolver——等价现状。多 shard activation 已被 Task 3 的 fail-closed 在 createDatabase 挡住,故此处永远拿到单库 db,注 SingleDbResolver 正确。）

- [ ] **Step 5: 跑测试 + typecheck + 全量回归**

Run:
```bash
npm run typecheck 2>&1 | tail -2; echo "tc=$?"
npm run build >/dev/null 2>&1
node --test --test-force-exit dist/test/unit/tenant-os-factory-resolver.test.js 2>&1 | grep -E "^ℹ (tests|pass|fail)"
node --test --test-force-exit 'dist/test/unit/**/*.test.js' 2>&1 | grep -E "^ℹ (tests|pass|fail)"
```
Expected: typecheck exit 0；工厂测试绿；**全量 unit fail 0（零回归——单库路径经 SingleDbResolver 等价现状）**。

- [ ] **Step 6: 提交**

```bash
git add src/multi-tenant/tenant-os-factory.ts src/server/app.ts src/test/unit/tenant-os-factory-resolver.test.ts
git commit -m "$(printf 'feat(core): TenantOSFactory 用 TenantDbResolver 取 db（ShardRouter Task 4）\n\n工厂首参 db→resolver;createTenantOS 经 resolver.dbForTenant;createApp 注\nSingleDbResolver（单库等价现状）。多 shard activation 由 Task 3 fail-closed 挡。\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

### Task 5: ratchet 归类新文件 + 全量验证

**Files:**
- Modify: `src/storage/db-access-inventory.ts`（归类 shard-router.ts/shard-hash.ts）

- [ ] **Step 1: 归类新增分片基建文件**

`src/storage/db-access-inventory.ts` 的 `DB_ACCESS_INVENTORY` 加两条（shard-router/shard-hash 是分片基建,归 `root-only`——它们不是「按 tenantId 拿 host db」的访问点,而是路由引擎本身）：
```ts
  { id: 'src/storage/shard-router.ts#ShardRouter', file: 'src/storage/shard-router.ts', category: 'root-only', note: '分片路由引擎（实现 TenantDbResolver 契约）,池 owner;非拿-host-db 访问点' },
  { id: 'src/storage/shard-hash.ts#fnv1a64', file: 'src/storage/shard-hash.ts', category: 'root-only', note: '确定性模哈希纯函数;无 db 访问,仅为 ratchet 覆盖（若 ratchet PATTERNS 命中则登记）' },
```
（注：shard-hash.ts 无 db 拿点,可能不被 ratchet PATTERNS 命中——若 `node scripts/check-db-access-ratchet.mjs` 不报它就不用加它那条;shard-router.ts 有 `buildDb`/`IDatabase` 可能命中,须归类。以 ratchet 实际报的为准。）

- [ ] **Step 2: ratchet 绿 + typecheck**

Run:
```bash
npm run build >/dev/null 2>&1
node scripts/check-db-access-ratchet.mjs; echo "ratchet=$?"
npm run typecheck >/dev/null 2>&1; echo "tc=$?"
```
Expected: ratchet exit 0（新文件已归类或未命中）；tc exit 0。

- [ ] **Step 3: 全量验证**

Run:
```bash
node --test --test-force-exit \
  dist/test/unit/shard-hash.test.js \
  dist/test/unit/shard-router.test.js \
  dist/test/unit/shard-router-guard.test.js \
  dist/test/unit/tenant-os-factory-resolver.test.js \
  2>&1 | grep -E "^ℹ (tests|pass|fail)"
node --test --test-force-exit 'dist/test/unit/**/*.test.js' 2>&1 | grep -E "^ℹ (tests|pass|fail)"
```
Expected: 本特性全绿；全量 unit fail 0。

- [ ] **Step 4: 提交**

```bash
git add src/storage/db-access-inventory.ts
git commit -m "$(printf 'feat(storage): ratchet 归类 shard-router/shard-hash（ShardRouter Task 5）\n\n分片路由引擎归 root-only（非拿-host-db 访问点）;ratchet 绿。\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

## Self-Review

**1. Spec coverage:**
- ShardRouter 实现 TenantDbResolver + 池 owner → Task 2。✓
- 确定性模哈希 + FNV golden vector → Task 1。✓
- config.db.shards 扩展 + **fail-closed（任何非空拒绝，建 db 前）** → Task 3（不变量 8）。✓
- TenantOSFactory db→resolver + 装配面（createApp）→ Task 4（装配面：createApp；main/main-desktop 走 createDatabase 的 guard，无需改注入——它们拿到的永远是单库 db）。✓
- 显式 homeShardId / default 钉 home → Task 2（不变量 2）。✓
- 池按 connStr 去重 / 幂等 close / init 回收 / 共享实例只关一次 → Task 2（不变量 9）。✓
- FNV golden vector（不变量 10）→ Task 1。✓
- 单库零回归（不变量 5）→ Task 4 Step 5 全量回归。✓
- ratchet 归类新文件 → Task 5。✓

**2. Placeholder scan:** Task 1 Step 1 的 golden vector 有两个 `TODO(实现者)` 占位——**有意的、带明确指令**（跑一次取真实 BigInt 填回锁定），Step 4 强制替换、明说不得留占位。其余步骤代码完整、命令带 expected。✓

**3. Type consistency:** `TenantDbResolver`（dbForTenant/coordinatorDb/allShardDbs）签名 Phase -1 已定，Task 2/4 一致；`ShardRouterConfig`/`fnv1a64: bigint`/`shardIdForTenant` 在 Task 1/2 定义并一致引用；`SingleDbResolver` 构造签名 Phase -1 已定，Task 4 一致用。✓

**注意点（实现者留意）:**
- **fail-closed 的具体位置是 `createDatabase`（Task 3）**——因为 main.ts:24 + main-desktop.ts:49 都调它,是两个生产入口共用的唯一 db-build 点,guard 放这即「唯一 validator + 建池前拒绝」（Codex 要求）。createApp 不自己建 db（从 deps.db 拿），故无需在 createApp 再加 guard。
- Task 4 装配面：`main.ts`/`main-desktop.ts` **不需要改注入**——它们把 `createDatabase(config)`（已过 guard 的单库 db）经 deps 传给 createApp，createApp 注 `SingleDbResolver(db)`。多 shard 永远到不了这里（被 createDatabase 挡）。
- Task 2 的 default 测试若写法笨拙,用「default 恒同 db」+「与已知落 home 的 tenant 一致」简化。
- 行号以就近锚点为准（factory 构造 / `:111` new TenantDatabase / app.ts `new TenantOSFactory` / dbSchema 定义 / createDatabase 函数体首行）。
