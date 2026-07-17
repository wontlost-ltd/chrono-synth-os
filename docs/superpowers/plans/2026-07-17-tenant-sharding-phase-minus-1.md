# 租户分片 Phase -1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付分片地基 Phase -1——`TenantDbResolver` 契约接口 + 单库适配器（默认行为等价现状）+ 全仓 DB-访问点盘点 allowlist + ratchet 静态检查（未归类拿点即 CI 红）。**不启用 shard 路由、不改任何 DB 选择、零回归。**

**Architecture:** 三块，互相独立可测：(1) `TenantDbResolver` 接口 + `SingleDbResolver` 适配器（三方法都返回同一 db，等价现状）；(2) 一份把当前 35 个 `os.getDatabase()`/裸 db 拿点逐个归到 8 类的 allowlist 数据文件；(3) 一个 ratchet 脚本（镜像 `check-license-boundary.mjs`：从文件系统自动发现全部拿点，断言「实际集合 ⊆ allowlist」，新增未归类即退出 1）。

**Tech Stack:** TypeScript (ESM, `.js` 后缀)，`node:test` + `node:assert/strict`；ratchet 用纯 Node ESM（镜像 `scripts/check-license-boundary.mjs`，零依赖，直接扫源码，无需构建）；wired into `test:golden`。

## Global Constraints

- 注释/文档简体中文（意图/约束/用法）。
- ESM：相对 import 带 `.js` 后缀；跨包用 `@chrono/kernel` 等。
- **零行为改动**：Phase -1 不改任何运行路径、不接业务调用点、不改 DB 选择。`TenantDbResolver` 只交接口 + 单库适配器（Codex 验收合同第 3 条）。
- **不承诺修错-shard bug**：`memory-facade.ts:221` 那类静默错-shard 写是 Phase 0 的事，Phase -1 只把它**归类登记**，不修（Codex 验收合同第 4 条）。
- **ratchet 须覆盖别名/构造器注入**：不能只 grep `os.getDatabase()`/`db.prepare`/`new .*Database(` 三串——须覆盖 `tx.prepare`/`sharedTx`/`IDatabase` 字段 + 构造器注入 `new Service(db)`/`buildAppServices(db)` + 长寿命 os 捕获（Codex 验收合同第 2 条；spec 不变量段）。
- **稳定 ID + 1-8 类归属**：inventory 每个拿点有稳定 ID + 归到 spec 的 8 类之一（Codex 验收合同第 1 条）。
- `IDatabase` 是同步接口：`exec/prepare/transaction/transactionRollback/queryOne/queryMany/execute/close`——适配器无需实现，只需**透传**一个已有 `IDatabase`。
- 本地验证强制；失败即止。

---

### Task 1: `TenantDbResolver` 契约接口 + 单库适配器

**Files:**
- Create: `src/storage/tenant-db-resolver.ts`
- Test: `src/test/unit/tenant-db-resolver.test.ts`

**Interfaces:**
- Consumes: `IDatabase`（`src/storage/database.js`）。
- Produces:
  ```ts
  export interface TenantDbResolver {
    dbForTenant(tenantId: string): IDatabase;   // 该租户所在 shard 的 db（所有显式 tenant_id 访问的唯一入口）
    coordinatorDb(): IDatabase;                  // 协调库（平台级表/shard map）
    allShardDbs(): IDatabase[];                  // 所有 shard（供 fan-out scatter-gather）
  }
  export class SingleDbResolver implements TenantDbResolver {
    constructor(db: IDatabase);
    // 三方法都返回同一个 db（等价现状；不启用多库）
  }
  ```

- [ ] **Step 1: 写失败测试**

创建 `src/test/unit/tenant-db-resolver.test.ts`：

```ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SingleDbResolver } from '../../storage/tenant-db-resolver.js';
import { createMemoryDatabase } from '../../storage/index.js';

describe('TenantDbResolver（分片地基 Phase -1）', () => {
  it('SingleDbResolver：三方法都返回同一个 db（单库等价现状）', () => {
    const db = createMemoryDatabase();
    const r = new SingleDbResolver(db);
    assert.strictEqual(r.dbForTenant('t1'), db);
    assert.strictEqual(r.dbForTenant('t2'), db, '不同租户单库下也是同一 db');
    assert.strictEqual(r.dbForTenant('default'), db);
    assert.strictEqual(r.coordinatorDb(), db);
    assert.deepEqual(r.allShardDbs(), [db], 'allShardDbs 单库下就一个');
  });

  it('dbForTenant 对任意 tenantId 都不抛（单库恒同 db）', () => {
    const db = createMemoryDatabase();
    const r = new SingleDbResolver(db);
    for (const t of ['', 'default', 'tenant_abc', 'x'.repeat(200)]) {
      assert.strictEqual(r.dbForTenant(t), db);
    }
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm run build >/dev/null 2>&1; node --test --test-force-exit dist/test/unit/tenant-db-resolver.test.js 2>&1 | grep -E "tests [0-9]|pass [0-9]|fail [0-9]"`
Expected: FAIL —— 模块 `../../storage/tenant-db-resolver.js` 不存在。

- [ ] **Step 3: 写实现**

创建 `src/storage/tenant-db-resolver.ts`：

```ts
/**
 * 租户 → shard DB 解析器契约（分片地基 Phase -1）。
 *
 * 分片的统一入口：所有「显式 tenant_id 访问」都应经 `dbForTenant(tenantId)` 取正确 shard 的 db，
 * 而非直接拿裸 `os.getDatabase()`（后者多 shard 下会读写 host DB=错 shard）。平台级表经 `coordinatorDb()`，
 * 跨租户 fan-out 经 `allShardDbs()`。
 *
 * Phase -1 只交契约 + 单库适配器（`SingleDbResolver`：三方法都返回同一 db，行为等价现状，不启用多库）。
 * 真 shard 路由（一致性哈希 + per-shard 池）是 Phase 0 的 `ShardRouter`，本接口是其契约。
 */

import type { IDatabase } from './database.js';

/** 租户 → shard DB 解析契约。所有显式 tenant_id 访问的唯一入口。 */
export interface TenantDbResolver {
  /** 取该租户所在 shard 的 db（单库下恒返回同一 db）。 */
  dbForTenant(tenantId: string): IDatabase;
  /** 取协调库（平台级表 / shard map；单库下=同一 db）。 */
  coordinatorDb(): IDatabase;
  /** 取所有 shard db（供跨租户 fan-out scatter-gather；单库下=[db]）。 */
  allShardDbs(): IDatabase[];
}

/** 单库适配器：三方法都返回构造时传入的同一个 db。等价现状，零回归。 */
export class SingleDbResolver implements TenantDbResolver {
  constructor(private readonly db: IDatabase) {}

  dbForTenant(_tenantId: string): IDatabase {
    return this.db;
  }

  coordinatorDb(): IDatabase {
    return this.db;
  }

  allShardDbs(): IDatabase[] {
    return [this.db];
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm run build >/dev/null 2>&1; node --test --test-force-exit dist/test/unit/tenant-db-resolver.test.js 2>&1 | grep -E "tests [0-9]|pass [0-9]|fail [0-9]"`
Expected: 2 tests PASS。

- [ ] **Step 5: 提交**

```bash
git add src/storage/tenant-db-resolver.ts src/test/unit/tenant-db-resolver.test.ts
git commit -m "$(printf 'feat(storage): TenantDbResolver 契约 + 单库适配器（分片地基 Phase -1）\n\n分片统一入口契约（dbForTenant/coordinatorDb/allShardDbs）+ SingleDbResolver\n（三方法返回同一 db，等价现状零回归）。不启用多库、不接业务点。\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

### Task 2: DB-访问点盘点 allowlist（8 类归属）

**Files:**
- Create: `src/storage/db-access-inventory.ts`（allowlist 数据 + 类型）

**Interfaces:**
- Produces:
  ```ts
  export type DbAccessCategory =
    | 'tenant-isolated' | 'parent-inherited' | 'platform-table' | 'global-worker'
    | 'explicit-per-request' | 'longlived-root-capture' | 'module-singleton' | 'root-only';
  export interface DbAccessPoint {
    readonly id: string;            // 稳定 ID（file:symbol，供 ratchet 比对）
    readonly file: string;          // repo 相对路径
    readonly category: DbAccessCategory;
    readonly note?: string;         // 归类依据 / Phase 0 待办标注
  }
  export const DB_ACCESS_INVENTORY: readonly DbAccessPoint[];
  ```
  归类依据 = spec 的 8 类（`docs/superpowers/specs/2026-07-17-tenant-sharding-design.md` Phase -1 段）。

- [ ] **Step 1: 枚举当前全部拿点**

先跑一遍看当前有哪些拿点（这是盘点的原料，不是测试）：

Run:
```bash
grep -rn "\.getDatabase()" src --include='*.ts' 2>/dev/null | grep -v test | grep -v '.d.ts'
grep -rn "= db ?? os.getDatabase()\|= os.getDatabase()\|this.os.getDatabase()" src --include='*.ts' 2>/dev/null | grep -v test | grep -v '.d.ts'
```
把每个拿点归到 8 类之一（spec 已点名的：decisions/onboarding/companion-chat/personas/privacy/memory-facade → `longlived-root-capture`；websocket → `module-singleton`；metrics → `global-worker`/fan-out；operations 等 per-request → `explicit-per-request`）。

- [ ] **Step 2: 写 inventory 数据文件**

创建 `src/storage/db-access-inventory.ts`（把 Step 1 枚举的拿点逐个落表；下面是**骨架 + 已知归类**，实现者按 Step 1 实际枚举补全每一条，每条必须有 id/file/category）：

```ts
/**
 * DB-访问点盘点（分片地基 Phase -1）。
 *
 * 全仓每个「拿 db 的点」（os.getDatabase() / 裸 db 捕获 / 构造器注入）逐个归到 8 类之一（见分片 spec）。
 * 这是 shard 路由的权威边界：Phase 0 据此把每类接到 dbForTenant/coordinatorDb/fan-out。
 * 完整性由 `scripts/check-db-access-ratchet.mjs` 保证——新增未归类拿点 → CI 红。
 *
 * 归类依据（spec 8 类）：
 *   tenant-isolated       随租户 shard，经 dbForTenant
 *   parent-inherited      无自己 tenant_id 靠父表 JOIN 归属，随父租户 shard
 *   platform-table        无 tenant_id 全局，协调库或每实例
 *   global-worker         跨租户迭代 worker/timer，per-shard 或协调库跑
 *   explicit-per-request  request handler 内一次性取 db，换 db 源即可（小改）
 *   longlived-root-capture 注册/构造期捕获 root db/os + 绑子服务，Phase 0 生命周期重构（大改）
 *   module-singleton      模块级/全局单例 db 引用，单列
 *   root-only             确无租户归属，协调库
 */

export type DbAccessCategory =
  | 'tenant-isolated'
  | 'parent-inherited'
  | 'platform-table'
  | 'global-worker'
  | 'explicit-per-request'
  | 'longlived-root-capture'
  | 'module-singleton'
  | 'root-only';

export interface DbAccessPoint {
  /** 稳定 ID：`<repo相对路径>#<符号>`（供 ratchet 比对，不含行号——防行号漂移）。 */
  readonly id: string;
  readonly file: string;
  readonly category: DbAccessCategory;
  readonly note?: string;
}

/**
 * 当前全部 DB-访问点归类。**实现者须按 Task 2 Step 1 的实际 grep 结果补全每一条**——
 * 下面列出 spec 已点名的确定归类作为起点，其余拿点（operations/admin-templates/metrics/各 worker 等）
 * 按 8 类定义归入。任一遗漏 → ratchet 红。
 */
export const DB_ACCESS_INVENTORY: readonly DbAccessPoint[] = [
  // —— longlived-root-capture（Phase 0 生命周期重构，大改） ——
  { id: 'src/server/routes/decisions.ts#registerDecisionRoutes', file: 'src/server/routes/decisions.ts', category: 'longlived-root-capture', note: '注册期 sharedDb + TokenBudget/CostTracker/UsageTracker/QuotaManager/BillingOutbox' },
  { id: 'src/server/routes/onboarding.ts#registerOnboardingRoutes', file: 'src/server/routes/onboarding.ts', category: 'longlived-root-capture', note: '注册期 sharedDb + 5 子服务' },
  { id: 'src/server/routes/companion/chat.ts#registerCompanionChatRoutes', file: 'src/server/routes/companion/chat.ts', category: 'longlived-root-capture', note: '注册期 sharedDb + QuotaManager' },
  { id: 'src/server/routes/personas.ts#registerPersonaRoutes', file: 'src/server/routes/personas.ts', category: 'longlived-root-capture', note: '注册期 new PersonaCoreService(os.getDatabase()) 长寿命' },
  { id: 'src/core/memory-facade.ts#MemoryFacade', file: 'src/core/memory-facade.ts', category: 'longlived-root-capture', note: '构造期 this.sharedDb；:221 绕 TenantDatabase UPDATE memory_nodes 静默错-shard（Phase 0 具名验收，Phase -1 不修）' },
  { id: 'src/privacy/privacy-service.ts#PrivacyService', file: 'src/privacy/privacy-service.ts', category: 'longlived-root-capture', note: '捕获长寿命 root os，方法内反复 this.os.getDatabase()' },
  // —— module-singleton ——
  { id: 'src/server/plugins/websocket.ts#eventLogDb', file: 'src/server/plugins/websocket.ts', category: 'module-singleton', note: '模块级单例 + :219-221 全局 prune timer；ws_event_log' },
  // —— global-worker / fan-out ——
  { id: 'src/server/routes/metrics.ts#MetricsQueryService', file: 'src/server/routes/metrics.ts', category: 'global-worker', note: '跨租户聚合 fan-out（Phase 2 scatter-gather）' },
  // TODO(实现者): 按 Task 2 Step 1 的 grep 补全其余拿点（operations/admin-templates/各 retention/settlement/task-queue/runtime-recovery/jwt-key-store 等），逐个归 8 类。
];
```

（**注：** 上面 `TODO(实现者)` 那行是**给实现者的指令**，实现时必须替换为实际枚举的剩余拿点——不得留在成品里；ratchet 会强制它补全，否则红。）

- [ ] **Step 3: typecheck 确认 inventory 数据合法**

Run: `npm run build >/dev/null 2>&1; echo "build exit=$?"`
Expected: exit 0（类型合法，8 类枚举匹配）。

- [ ] **Step 4: 提交**

```bash
git add src/storage/db-access-inventory.ts
git commit -m "$(printf 'feat(storage): DB-访问点盘点 allowlist（8 类归属，分片地基 Phase -1）\n\n全仓每个拿 db 点归 spec 8 类之一，稳定 ID+归类依据。longlived-root-capture\n六个（decisions/onboarding/companion/personas/privacy/memory-facade）标 Phase 0 重构。\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

### Task 3: ratchet 静态检查 + 接入 test:golden

**Files:**
- Create: `scripts/check-db-access-ratchet.mjs`（镜像 `scripts/check-license-boundary.mjs`）
- Modify: `package.json`（加 `check:db-access` script + 接入 `test:golden`）

**Interfaces:**
- Consumes: `src/storage/db-access-inventory.ts` 的 `DB_ACCESS_INVENTORY`（读源码文本，非 import 编译产物——镜像 license 脚本「直接读源」纪律）。
- Produces: `check:db-access` npm script；退出码 1 当发现未归类拿点。

- [ ] **Step 1: 写 ratchet 脚本**

创建 `scripts/check-db-access-ratchet.mjs`（镜像 check-license-boundary 的「自动发现全集 + 断言 ⊆ allowlist + 未归类退出 1」）：

```js
#!/usr/bin/env node
/**
 * DB-访问点 ratchet（分片地基 Phase -1）。
 *
 * 防「新增拿 db 点未归类」漂移：全仓静扫每个「拿 db 的点」，断言它出现在
 * `src/storage/db-access-inventory.ts` 的 allowlist（按 file 归属）。任一未归类 → 退出 1。
 *
 * Codex 验收合同：不能只 grep 三串——须覆盖别名传播 + 构造器注入 + 长寿命 os 捕获。
 * 故扫描模式集含：`.getDatabase()`、`= db ?? `、`this.os.getDatabase()`、`sharedDb`/`sharedTx` 捕获、
 * `new .*Database(`、`buildAppServices(`。命中文件必须在 inventory 的 file 集合里。
 *
 * 纯 Node ESM，零依赖，直接读源码（无需构建），镜像 check-license-boundary.mjs。
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();
const SRC = join(ROOT, 'src');

/* 触发拿-db 的模式（Codex 合同：覆盖别名/构造器注入/长寿命捕获，非仅三串）。 */
const PATTERNS = [
  /\.getDatabase\(\)/,
  /=\s*db\s*\?\?\s*/,
  /this\.os\.getDatabase\(\)/,
  /\bsharedDb\b\s*=/,
  /\bsharedTx\b\s*=/,
  /new\s+\w*Database\s*\(/,
  /buildAppServices\s*\(/,
];

/** 递归收集 src 下所有非 test/.d.ts 的 .ts 文件（repo 相对路径）。 */
function collectTsFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) { out.push(...collectTsFiles(p)); continue; }
    if (!name.endsWith('.ts')) continue;
    if (name.endsWith('.d.ts') || name.endsWith('.test.ts')) continue;
    if (p.includes(`${sep()}test${sep()}`)) continue;
    out.push(relative(ROOT, p));
  }
  return out;
}
function sep() { return process.platform === 'win32' ? '\\' : '/'; }

/** 从 inventory 源文件解析出已归类的 file 集合（读源码文本，不 import 编译产物）。 */
function inventoryFiles() {
  const txt = readFileSync(join(SRC, 'storage/db-access-inventory.ts'), 'utf-8');
  const files = new Set();
  for (const m of txt.matchAll(/file:\s*'([^']+)'/g)) files.add(m[1]);
  return files;
}

function main() {
  const invFiles = inventoryFiles();
  const offenders = [];
  for (const file of collectTsFiles(SRC)) {
    /* inventory 文件自身 + resolver 不算拿点（它们是分片基建）。 */
    if (file.endsWith('storage/db-access-inventory.ts')) continue;
    if (file.endsWith('storage/tenant-db-resolver.ts')) continue;
    const txt = readFileSync(join(ROOT, file), 'utf-8');
    const hit = PATTERNS.some((re) => re.test(txt));
    if (hit && !invFiles.has(file)) offenders.push(file);
  }
  if (offenders.length > 0) {
    console.error('❌ DB-访问 ratchet：以下文件有拿-db 点但未在 db-access-inventory.ts 归类：');
    for (const f of offenders) console.error('   - ' + f);
    console.error('\n请在 src/storage/db-access-inventory.ts 把它按 8 类之一归类（见分片 spec）。');
    process.exit(1);
  }
  console.log(`✓ DB-访问 ratchet：${invFiles.size} 个已归类文件，无未归类拿点。`);
}

main();
```

- [ ] **Step 2: 跑 ratchet——确认它对「未归类拿点」会红（负控）**

先临时在一个未归类文件里制造一个拿点，验证 ratchet 真会红（然后还原）：

Run:
```bash
node scripts/check-db-access-ratchet.mjs; echo "exit=$?"
```
Expected: 若 inventory 已覆盖全部拿点 → exit 0「无未归类」；若 Task 2 的 `TODO` 未补全 → exit 1 列出未归类文件（**这正是 ratchet 的价值——它逼 Task 2 补全**）。以实际输出为准：ratchet 红 = inventory 还有拿点没归，回 Task 2 补；ratchet 绿 = 全归类。

- [ ] **Step 3: 补全 inventory 直到 ratchet 绿**

按 Step 2 ratchet 报的未归类文件，回 `src/storage/db-access-inventory.ts` 逐个补归类（每个按 8 类定义归入），重跑 `node scripts/check-db-access-ratchet.mjs` 直到 exit 0。

- [ ] **Step 4: 接入 package.json**

在 `package.json` scripts 里加 `check:db-access`，并接入 `test:golden`：

```json
"check:db-access": "node scripts/check-db-access-ratchet.mjs",
```
把 `test:golden` 末尾的 `&& npm run check:licenses` 改为 `&& npm run check:licenses && npm run check:db-access`。

- [ ] **Step 5: 全量验证 + 零回归**

Run:
```bash
npm run typecheck 2>&1 | tail -2; echo "tc=$?"
node scripts/check-db-access-ratchet.mjs; echo "ratchet=$?"
node --test --test-force-exit dist/test/unit/tenant-db-resolver.test.js 2>&1 | grep -E "^ℹ (tests|pass|fail)"
node --test --test-force-exit 'dist/test/unit/**/*.test.js' 2>&1 | grep -E "^ℹ (tests|pass|fail)"
```
Expected: typecheck exit 0；ratchet exit 0；resolver 测试全绿；全量 unit fail 0（Phase -1 零行为改动，不应波及任何现有测试）。

- [ ] **Step 6: 提交**

```bash
git add scripts/check-db-access-ratchet.mjs package.json src/storage/db-access-inventory.ts
git commit -m "$(printf 'feat(storage): DB-访问 ratchet 静态检查 + 接入 test:golden（分片地基 Phase -1）\n\n镜像 check-license-boundary：全仓静扫拿-db 点，未在 inventory 归类即退出 1。\n覆盖别名/构造器注入/长寿命捕获（非仅三串，Codex 合同）。接入 test:golden。\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

## Self-Review

**1. Spec coverage（对 Phase -1 段 + Codex 4 条验收合同）:**
- `TenantDbResolver` 契约（dbForTenant/coordinatorDb/allShardDbs）+ 单库适配器 → Task 1。✓
- 8 类归类清单（稳定 ID + 1-8 类归属，Codex 合同1）→ Task 2。✓
- ratchet 防新增未归类（Codex 合同2：覆盖别名/构造器注入/长寿命捕获，非三串）→ Task 3 的 PATTERNS。✓
- resolver 仅接口+单库适配器不接业务点（Codex 合同3）→ Task 1 明确只交 SingleDbResolver，无业务接线。✓
- Phase -1 不承诺修错-shard bug（Codex 合同4）→ memory-facade 只在 Task 2 归类登记（note 标 Phase 0），不修。✓
- 零回归 → Task 3 Step 5 全量 unit 回归。✓

**2. Placeholder scan:** Task 2 Step 2 的 `TODO(实现者)` 是**有意的、带明确指令的**占位——它不是「留空」，而是「按实际 grep 补全」，且 ratchet（Task 3）会**强制**补全（不补则 CI 红）。已在文中标注它必须被替换、不得留在成品。其余步骤代码完整、命令带 expected。✓

**3. Type consistency:** `TenantDbResolver` 三方法签名在 Task 1 定义、Task 2/3 一致引用；`DbAccessCategory` 8 值 + `DbAccessPoint` 字段在 Task 2 定义、Task 3 ratchet 读同名 `file:` 字段；`SingleDbResolver` 构造签名一致。✓

**注意点（实现者留意）:**
- Task 2 的 inventory **必须枚举全**——Task 3 的 ratchet 是强制手段：ratchet 红说明还有拿点没归，回 Task 2 补，直到绿。这是「盘点已完成」而非「承诺盘点」的机制保证（Codex 第 2 轮核心）。
- ratchet 的 PATTERNS 是**文件级**判定（命中即要求该文件在 inventory）——比行级精确度低但足够做「防新增未归类文件」的 ratchet；spec 说的 AST 级是更强目标，Phase -1 先落文件级 allowlist（够挡「新文件引入未归类拿点」），note 里标 AST 增强为后续。
- `SingleDbResolver` 暂无消费者（Phase -1 只交契约）——这是 Codex 合同3「不接业务点」的要求，不是遗漏。
