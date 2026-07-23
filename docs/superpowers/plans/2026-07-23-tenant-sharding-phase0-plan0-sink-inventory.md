# 分片 Phase 0 · Plan 0：AST sink 盘点 + 放开门 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development（推荐）or superpowers:executing-plans 逐 task 实现。步骤用 checkbox（`- [ ]`）追踪。

**Goal:** 建一个类型驱动（TS `Program+TypeChecker`）的 DB-capability edge 扫描器 + 升级 `db-access-inventory.ts` 到 source→sink 级，使「每个持有 DB 能力的点都有明确处置结论」可被 CI 自动验证——这是后续 Plan 1/2/3 放开 fail-closed 的完整性前提。

**Architecture:** 扫描器用 `typescript` 的 `Program`/`TypeChecker` 枚举全仓所有「类型为 `IDatabase`/`SyncWriteUnitOfWork`（含别名/结构兼容）的字段/参数/deps 属性」以及「传这些类型实参的构造/函数/属性注入点」，得到 DB-capability edge 集；每条 edge 必须对应 `db-access-inventory.ts` 一个稳定 ID + 处置状态（`resolver`/`coordinator`/`mixed-scope`/`per-shard-worker`/`known-limitation`/`root-only`）。未对应 edge → 扫描器退出非零（ratchet 红）。**本 Plan 纯盘点 + 扫描器 + inventory 升级，不改任何运行逻辑。**

**Tech Stack:** Node.js + TypeScript 6.0.3（已装，`typescript` 6.0.3 提供 `ts.createProgram`/`getTypeChecker`）。扫描器 = 纯 Node ESM 脚本（镜像现有 `scripts/check-db-access-ratchet.mjs`，但升级为类型驱动而非正则）。测试用既有 `node:test` + `tsx`（快跑）/ `dist`（golden）。

## Global Constraints

（每个 task 隐含遵守；出自 spec §3-A0 / §8）

1. **不改运行逻辑**：本 Plan 只加扫描器 + 改 `db-access-inventory.ts` 数据 + 测试；**不碰任何 src 运行代码**（sink 的实际 resolver 下沉是 Plan 1/2/3）。
2. **扫描器类型驱动**：用 `Program+TypeChecker` 判 DB 能力（类型），**不是标识符名字/正则**——才能处理类型别名（`IDatabase extends SyncWriteUnitOfWork`）、结构兼容 deps、推断出的 `os.getDatabase()` 返回类型、db 属性传播。
3. **6 类注入形态全覆盖**：直接参 `IDatabase`/`SyncWriteUnitOfWork` / `deps.db` 对象属性 / route 参 db / 闭包·timer·event·worker 捕获 / factory·container 间接创建 / deps 类型别名·结构兼容。每类有变异 fixture 证明「故意新增 → 扫描器红」。
4. **每 edge 对应 inventory 稳定 ID**：edge 未在 inventory → 红；inventory 条目缺处置状态 → 红。
5. **不追求穷尽人工清单**：已知 sink 起点（spec §3-A0 的 7 类）是起点，扫描器是完整性机制——新 sink 由扫描器自动发现，非人工。
6. **中文注释**（项目规范）；扫描器接进 `test:golden`（替换/扩展现有 `check:db-access`）；单库零回归（扫描器不改运行时行为，现有全测试仍绿）。
7. **测试位置**：测试放 `src/test/unit/`（扁平），命名 `db-sink-scanner-*.test.ts`；变异 fixture 放 `src/test/support/db-sink-fixtures/`（独立目录，供扫描器变异测试用，不进生产扫描范围或显式标注为 fixture）。

---

## File Structure

- `scripts/db-sink-scanner.mjs` — 类型驱动 DB-capability edge 扫描器（新，核心）。用 `typescript` Program+TypeChecker。
- `src/storage/db-access-inventory.ts` — 升级为 source→sink 级（改数据 + 加处置状态字段；纠正 `buildAppServices` 错分类；新增已知 sink）。
- `scripts/check-db-access-ratchet.mjs` — 改为调用/包装 `db-sink-scanner.mjs`（或并入；保持 `check:db-access` 入口不变）。
- `src/test/support/db-sink-fixtures/` — 6 类注入形态的变异 fixture（每类一个 .ts 文件 + 对应「未登记」态）。
- `src/test/unit/db-sink-scanner.test.ts` — 扫描器行为 + 6 类变异测试（每类故意引入未登记 sink → 断言扫描器报红）。
- `src/test/unit/db-access-inventory-completeness.test.ts` — inventory 每条目有处置状态 + 已知 sink（buildAppServices 15 成员/TaskQueue/LegalHold/NudgePushBridge/独立 worker/全局 worker-timer/Auth）都在册。

---

## Task 1: 扫描器骨架 — 用 TypeChecker 枚举 DB-capability 类型 + edge

**Files:**
- Create: `scripts/db-sink-scanner.mjs`
- Test: `src/test/unit/db-sink-scanner.test.ts`（本 task 只测「能枚举出已知 edge」）

**Interfaces:**
- Consumes: `typescript`（`ts.createProgram`/`getTypeChecker`）；`IDatabase`（`src/storage/database.ts:27`）/ `SyncWriteUnitOfWork`（`packages/kernel/src/ports/sync-unit-of-work.ts`）类型身份。
- Produces: `scanDbCapabilityEdges(tsconfigPath): Edge[]`，`Edge = { id: string; file: string; kind: 'ctor-param'|'fn-param'|'deps-prop'|'route-param'|'capture'|'factory-indirect'; symbol: string }`（`id = <repo相对路径>#<符号>` 稳定 ID）。

- [ ] **Step 1: 写失败测试（扫描器能枚举出已知 DB-capability edge）**

```typescript
// src/test/unit/db-sink-scanner.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanDbCapabilityEdges } from '../../../scripts/db-sink-scanner.mjs';

test('扫描器枚举出已知 DB-capability edge（构造器参 + deps 属性）', () => {
  const edges = scanDbCapabilityEdges('tsconfig.src.json');
  const ids = new Set(edges.map((e) => e.id));
  // LegalHoldService 构造器直接接 IDatabase（legal-hold-service.ts:82）
  assert.ok([...ids].some((id) => id.includes('legal-hold-service') && id.includes('LegalHoldService')));
  // NudgePushBridgeDeps.db 是 deps 对象属性（nudge-push-bridge.ts:33）
  assert.ok([...ids].some((id) => id.includes('nudge-push-bridge')));
  // TaskQueue 构造器接 IDatabase（task-queue.ts:75）
  assert.ok([...ids].some((id) => id.includes('task-queue') && id.includes('TaskQueue')));
});

test('扫描器识别 IDatabase 别名/结构兼容（SyncWriteUnitOfWork 也算 DB 能力）', () => {
  const edges = scanDbCapabilityEdges('tsconfig.src.json');
  // TokenBudget.fromUnitOfWork 接 SyncWriteUnitOfWork（IDatabase 的父类型，也是 DB 能力）
  assert.ok(edges.some((e) => e.file.includes('token-budget')));
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx tsx --test src/test/unit/db-sink-scanner.test.ts`
Expected: FAIL（`db-sink-scanner.mjs` 不存在）

- [ ] **Step 3: 写扫描器骨架**

```javascript
// scripts/db-sink-scanner.mjs
/**
 * 类型驱动 DB-capability edge 扫描器（分片 Phase 0 · Plan 0）。
 * 用 TS Program+TypeChecker 枚举全仓所有「类型为 IDatabase / SyncWriteUnitOfWork（含别名/结构兼容）
 * 的字段/参数/deps 属性」及传它们实参的注入点——得到 DB-capability edge 集。
 * 完整性门：每条 edge 须对应 db-access-inventory.ts 一个稳定 ID + 处置状态（check:db-access 断言）。
 */
import ts from 'typescript';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** 判某类型是否「DB 能力」= 是 IDatabase 或 SyncWriteUnitOfWork 或其结构兼容/别名。
 * 用 checker 的 apparent/base 类型比对，不靠名字。 */
function isDbCapabilityType(type, checker, dbSymbols) {
  // dbSymbols = { IDatabase, SyncWriteUnitOfWork } 的 ts.Symbol（从 database.ts / sync-unit-of-work.ts 解析）
  const sym = type.getSymbol?.();
  if (sym && dbSymbols.has(sym)) return true;
  // 结构兼容：type 可赋给 SyncWriteUnitOfWork（有 prepare/execute/transaction 等）——用 checker.isTypeAssignableTo
  // （若该 API 不可用则退化为 base types 递归含 dbSymbols）。实现者按真实 TS 6 API 落地。
  const bases = type.getBaseTypes?.() ?? [];
  return bases.some((b) => { const s = b.getSymbol?.(); return s && dbSymbols.has(s); });
}

export function scanDbCapabilityEdges(tsconfigPath = 'tsconfig.src.json') {
  const configPath = join(ROOT, tsconfigPath);
  const parsed = ts.getParsedCommandLineOfConfigFile(configPath, {}, {
    ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {},
  });
  const program = ts.createProgram(parsed.fileNames, parsed.options);
  const checker = program.getTypeChecker();

  // 解析 IDatabase / SyncWriteUnitOfWork 的 Symbol（从其定义文件）
  const dbSymbols = new Set();  // 实现者：遍历 program 找 database.ts 的 IDatabase + sync-unit-of-work.ts 的 SyncWriteUnitOfWork export symbol
  // ...填充 dbSymbols...

  const edges = [];
  const idOf = (file, symbol) => `${relative(ROOT, file)}#${symbol}`;

  for (const sf of program.getSourceFiles()) {
    if (sf.isDeclarationFile) continue;
    const file = sf.fileName;
    if (!file.includes(`${'/'}src${'/'}`) && !file.includes(`${'/'}scripts${'/'}`)) continue;
    if (file.includes('/test/') || file.endsWith('.test.ts')) continue;

    ts.forEachChild(sf, function visit(node) {
      // 构造器/函数参数：类型是 DB 能力 → ctor-param / fn-param
      if (ts.isParameter(node) && node.type) {
        const t = checker.getTypeAtLocation(node.type);
        if (isDbCapabilityType(t, checker, dbSymbols)) {
          const owner = node.parent;
          const kind = ts.isConstructorDeclaration(owner) ? 'ctor-param' : 'fn-param';
          const ownerName = /* 类名或函数名 */ '';  // 实现者取 enclosing class/function 名
          edges.push({ id: idOf(file, ownerName), file, kind, symbol: ownerName });
        }
      }
      // 接口/类字段：deps 对象属性 db: IDatabase → deps-prop
      if (ts.isPropertySignature(node) || ts.isPropertyDeclaration(node)) {
        if (node.type) {
          const t = checker.getTypeAtLocation(node.type);
          if (isDbCapabilityType(t, checker, dbSymbols)) {
            const ownerName = /* 含它的 interface/class 名 */ '';
            edges.push({ id: idOf(file, ownerName), file, kind: 'deps-prop', symbol: ownerName });
          }
        }
      }
      ts.forEachChild(node, visit);
    });
  }
  // 去重（同 id 合并；route-param/capture/factory-indirect 在 Task 2 补充识别）
  const byId = new Map();
  for (const e of edges) if (!byId.has(e.id)) byId.set(e.id, e);
  return [...byId.values()];
}

// CLI：直接跑时输出 edge 数（供人工 sanity）
if (import.meta.url === `file://${process.argv[1]}`) {
  const edges = scanDbCapabilityEdges();
  console.log(`DB-capability edges: ${edges.length}`);
}
```
> 实现者注：`isDbCapabilityType` 的结构兼容判定按 TS 6.0.3 真实 API 落地（优先 `checker.isTypeAssignableTo(type, uowType)`；不可用则 base-type 递归）。`dbSymbols` 填充：遍历 `program.getSourceFiles()` 找 `database.ts` 的 `IDatabase` + `ports/sync-unit-of-work.ts` 的 `SyncWriteUnitOfWork` 的 export symbol（`checker.getSymbolAtLocation`）。enclosing 名取法照 TS AST 惯例（`node.parent` 上溯到 ClassDeclaration/FunctionDeclaration 取 `.name`）。

- [ ] **Step 4: 运行确认通过**

Run: `npx tsx --test src/test/unit/db-sink-scanner.test.ts`
Expected: PASS（2 测试——枚举出 LegalHold/NudgePush/TaskQueue edge + 识别 SyncWriteUnitOfWork 别名）

- [ ] **Step 5: Commit**

```bash
git add scripts/db-sink-scanner.mjs src/test/unit/db-sink-scanner.test.ts
git commit -m "feat(shard): DB-capability edge 扫描器骨架（TypeChecker 枚举 IDatabase/UoW 注入点）"
```

---

## Task 2: 扫描器补齐 6 类注入形态 + 变异 fixture 自证

**Files:**
- Modify: `scripts/db-sink-scanner.mjs`（补 route-param / capture / factory-indirect 识别）
- Create: `src/test/support/db-sink-fixtures/{ctor-param,deps-prop,route-param,capture,factory-indirect,type-alias}.ts`（6 类 fixture）
- Test: `src/test/unit/db-sink-scanner.test.ts`（加 6 类变异测试）

**Interfaces:**
- Consumes: Task 1 的 `scanDbCapabilityEdges`。
- Produces: 扫描器识别全 6 类形态；fixture 是「若未登记则扫描器应报红」的样本。

- [ ] **Step 1: 写 6 类 fixture（每个含一个 DB-capability 注入点）**

每个 fixture 文件含一个该形态的最小样本，例如：

```typescript
// src/test/support/db-sink-fixtures/deps-prop.ts
// 变异 fixture：deps 对象属性形态的 DB-capability sink（供扫描器变异测试；非生产代码）。
import type { IDatabase } from '../../../storage/database.js';
interface FixtureDeps { readonly db: IDatabase; }
export class DepsPropFixture { constructor(private readonly deps: FixtureDeps) {} }
```
```typescript
// src/test/support/db-sink-fixtures/capture.ts
// 变异 fixture：闭包/timer 捕获 db 形态。
import type { IDatabase } from '../../../storage/database.js';
export function makeTimer(db: IDatabase): () => void {
  return () => { db.prepare('SELECT 1').get(); };   // 闭包捕获 db
}
```
（其余 ctor-param/route-param/factory-indirect/type-alias 各一个最小样本，照 spec 6 类。）

- [ ] **Step 2: 写失败测试（扫描器对每类 fixture 都识别出 edge）**

```typescript
// 追加到 src/test/unit/db-sink-scanner.test.ts
test('扫描器识别全 6 类注入形态（每类 fixture 都产 edge）', () => {
  const edges = scanDbCapabilityEdges('tsconfig.src.json');
  const kinds = new Set(edges.filter((e) => e.file.includes('db-sink-fixtures')).map((e) => e.kind));
  for (const k of ['ctor-param', 'deps-prop', 'route-param', 'capture', 'factory-indirect']) {
    assert.ok(kinds.has(k), `扫描器未识别形态 ${k}`);
  }
});

test('变异：新增未登记 sink（deps-prop fixture）→ ratchet 报红', async () => {
  // 断言 fixture 的 edge 不在 inventory → runRatchet() 返回非零/抛
  const { collectUnregisteredEdges } = await import('../../../scripts/db-sink-scanner.mjs');
  const unreg = collectUnregisteredEdges('tsconfig.src.json');
  // fixture edge 故意不登记 → 必在未登记集里（证明扫描器真会拦未登记 sink）
  assert.ok(unreg.some((e) => e.file.includes('db-sink-fixtures/deps-prop')));
});
```
> 注：fixture 目录**故意不登记进 inventory**——它们的存在正是「未登记 sink → 扫描器红」的活体证明。但 `check:db-access` 主跑须**排除 fixture 目录**（否则 CI 恒红）；扫描器加 `excludeGlobs: ['src/test/**']`，变异测试单独对 fixture 跑 `collectUnregisteredEdges` 验证识别能力。

- [ ] **Step 3: 补扫描器识别 route-param/capture/factory-indirect + `collectUnregisteredEdges` + fixture 排除**

在 `scanDbCapabilityEdges` 的 visit 里补：
- route-param：`registerXxxRoutes(app, db, ...)` 的函数参数——Task 1 的 fn-param 已覆盖参数类型判定，此处确认 route 注册函数也被扫（它们就是 fn-param，`kind` 细分为 route-param 当函数名匹配 `/^register.*Routes$/`）。
- capture：变量声明/箭头函数体内引用了 DB-capability 类型的自由变量——遍历函数体找引用了外层 db 绑定的标识符（`checker.getSymbolAtLocation` 判其类型是 DB 能力）。
- factory-indirect：`new XxxService(db)` / `new SqliteEventLedger(opts.db)` 这类把 db 实参传给构造调用——遍历 `ts.isNewExpression`/`ts.isCallExpression`，实参类型是 DB 能力则记 factory-indirect edge（归到含此调用的 enclosing 符号）。
- `collectUnregisteredEdges(tsconfigPath)`：`scanDbCapabilityEdges` 结果 filter 掉 inventory 已登记 id + 排除 `src/test/` → 返回未登记 edge。主 `check:db-access` 用它，非空 → 退出 1。

- [ ] **Step 4: 运行确认通过**

Run: `npx tsx --test src/test/unit/db-sink-scanner.test.ts`
Expected: PASS（6 类识别 + 变异 fixture 未登记检测）

- [ ] **Step 5: Commit**

```bash
git add scripts/db-sink-scanner.mjs src/test/support/db-sink-fixtures/ src/test/unit/db-sink-scanner.test.ts
git commit -m "feat(shard): 扫描器补齐 6 类注入形态 + 变异 fixture 自证（未登记 sink→红）"
```

---

## Task 3: 升级 `db-access-inventory.ts` 到 source→sink 级 + 登记全部已知 sink

**Files:**
- Modify: `src/storage/db-access-inventory.ts`（加 `disposition` 字段 + 纠正 buildAppServices + 登记已知 sink）
- Test: `src/test/unit/db-access-inventory-completeness.test.ts`

**Interfaces:**
- Consumes: Task 1/2 的 edge id 格式。
- Produces: `DB_ACCESS_INVENTORY` 每条目加 `disposition: 'resolver'|'coordinator'|'mixed-scope'|'per-shard-worker'|'root-only'|'known-limitation'`；`buildAppServices` 从 `explicit-per-request` 改分类 + 拆成员；新增 spec §3-A0 #4-7 的 sink。

- [ ] **Step 1: 写失败测试（inventory 完整性 + 处置状态）**

```typescript
// src/test/unit/db-access-inventory-completeness.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DB_ACCESS_INVENTORY } from '../../storage/db-access-inventory.js';

test('每个 inventory 条目都有 disposition 处置状态', () => {
  for (const p of DB_ACCESS_INVENTORY) {
    assert.ok(p.disposition, `${p.id} 缺 disposition`);
  }
});

test('已知 sink 都在册（buildAppServices 成员/TaskQueue/LegalHold/NudgePushBridge/独立 worker/全局 worker-timer/Auth）', () => {
  const ids = DB_ACCESS_INVENTORY.map((p) => p.id).join('\n');
  for (const needle of [
    'app-services',            // buildAppServices 长期服务
    'task-queue',              // TaskQueue
    'legal-hold-service',      // LegalHold 间接 sink
    'nudge-push-bridge',       // NudgePushBridge
    'main-observability-worker', // 独立入口
    'settlement-reconciliation-worker', // 全局 worker 类
    'media-retention-worker',  // GDPR 擦除
    'auth-service',            // mixed-scope
  ]) {
    assert.ok(ids.includes(needle), `已知 sink 未登记：${needle}`);
  }
});

test('buildAppServices 不再被错分类为 explicit-per-request', () => {
  const bas = DB_ACCESS_INVENTORY.find((p) => p.id.includes('app-services'));
  assert.ok(bas);
  assert.notEqual(bas.category, 'explicit-per-request');  // Codex 核实：全是长期 sink，非 per-request
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx tsx --test src/test/unit/db-access-inventory-completeness.test.ts`
Expected: FAIL（`disposition` 字段不存在 / 已知 sink 未登记 / buildAppServices 仍错分类）

- [ ] **Step 3: 升级 inventory**

在 `DbAccessPoint` 接口加 `readonly disposition?: DbAccessDisposition;`（新 union 类型），全条目补 `disposition`；`buildAppServices` 改分类为 `longlived-root-capture` + note 说明「~15 长期 DB 服务，Plan 1 逐成员 resolver/coordinator 化」；新增 spec §3-A0 #4-7 的 sink 条目（nudge-push-bridge / main-observability-worker / settlement-reconciliation-worker / dual-write-flush-worker / media-retention-worker / task-queue / legal-hold-service / auth-service，各带 disposition 处置结论——照 spec §4.1/§5.1/§5.2 的定性：Auth=mixed-scope、MediaRetention=per-shard-worker、独立 worker=per-shard-worker 等）。

> 实现者注：处置结论照 spec：Auth→`mixed-scope`、全局跨租户 worker（Settlement/DualWriteFlush/MediaRetention/RuntimeRecovery）→`per-shard-worker`、buildAppServices 成员→`resolver`（除个别 mixed-scope）、平台表→`coordinator`。**本 task 只填「计划处置」标签，不实现下沉**（下沉是 Plan 1/2）。

- [ ] **Step 4: 运行确认通过**

Run: `npx tsx --test src/test/unit/db-access-inventory-completeness.test.ts`
Expected: PASS（3 测试）

- [ ] **Step 5: Commit**

```bash
git add src/storage/db-access-inventory.ts src/test/unit/db-access-inventory-completeness.test.ts
git commit -m "feat(shard): inventory 升级 source→sink 级（加 disposition + 纠正 buildAppServices + 登记全部已知 sink）"
```

---

## Task 4: 把扫描器接进 `check:db-access` 放开门 + golden

**Files:**
- Modify: `scripts/check-db-access-ratchet.mjs`（改为调用 `db-sink-scanner.mjs` 的 `collectUnregisteredEdges`，保留原 file 级作补充）
- Test: `src/test/unit/db-sink-scanner.test.ts`（加「全仓无未登记 edge」端到端断言）

**Interfaces:**
- Consumes: Task 2 `collectUnregisteredEdges`、Task 3 升级后的 inventory。
- Produces: `npm run check:db-access` = 类型驱动 edge 门（未登记 edge → 退出 1）。

- [ ] **Step 1: 写失败/守护测试（全仓当前无未登记 edge）**

```typescript
// 追加到 src/test/unit/db-sink-scanner.test.ts
test('全仓（排除 fixture）无未登记 DB-capability edge——放开门基线', () => {
  const { collectUnregisteredEdges } = /* 已 import */ globalThis as never;
  const unreg = collectUnregisteredEdgesFn('tsconfig.src.json').filter((e) => !e.file.includes('db-sink-fixtures'));
  assert.deepEqual(unreg.map((e) => e.id), [], `存在未登记 DB-capability edge:\n${unreg.map((e) => e.id).join('\n')}`);
});
```
> 这条测试跑起来必须绿——即 Task 3 已把全仓所有真实 edge 登记完。若红，说明还有真实 sink 没登记（Task 3 补登，不是改测试放宽）。**这正是完整性门的自证**。

- [ ] **Step 2: 运行——预期先红（暴露未登记的真实 edge），补登 inventory 至绿**

Run: `npx tsx --test src/test/unit/db-sink-scanner.test.ts`
Expected: 初次可能 FAIL（列出未登记 edge）→ 把它们登进 inventory（Task 3 的续补）→ PASS。**红时补 inventory，绝不改扫描器放宽或加白名单绕过。**

- [ ] **Step 3: 改 `check-db-access-ratchet.mjs` 调扫描器**

```javascript
// scripts/check-db-access-ratchet.mjs（改）
import { collectUnregisteredEdges } from './db-sink-scanner.mjs';
const unreg = collectUnregisteredEdges('tsconfig.src.json').filter((e) => !e.file.includes('src/test/'));
if (unreg.length > 0) {
  console.error(`✗ DB-访问 ratchet：${unreg.length} 个未登记 DB-capability edge：`);
  for (const e of unreg) console.error(`  - ${e.id} (${e.kind})`);
  process.exit(1);
}
console.log(`✓ DB-capability ratchet：全部 edge 已登记 + 处置`);
// （保留原 file 级扫描作补充网，或明确移除——实现者定，二者不冲突）
```

- [ ] **Step 4: 跑 check:db-access + 全 sharding 单测确认绿**

Run: `npm run check:db-access && npx tsx --test src/test/unit/db-sink-scanner.test.ts src/test/unit/db-access-inventory-completeness.test.ts`
Expected: PASS（放开门绿——全仓 edge 已登记）

- [ ] **Step 5: Commit**

```bash
git add scripts/check-db-access-ratchet.mjs src/test/unit/db-sink-scanner.test.ts
git commit -m "feat(shard): check:db-access 升级为类型驱动 edge 门（未登记 DB-capability→红）"
```

---

## 收尾（全 task 完成后）

- [ ] **本地全量门**（约束：merge 前必跑 test:golden 全门，见 memory `merge-gate-must-run-test-golden`）

Run: `npm run test:golden`
Expected: EXIT 0。**关键**：`check:db-access` 现在是类型驱动 edge 门——若红，说明有未登记 DB-capability edge，补 inventory（Task 3 续补），不放宽扫描器。本 Plan 不改运行逻辑，故 unit/integration/parity 应零回归。

- [ ] **最终整片 code review**（subagent-driven-development 终审：最强模型审全分支，尤其扫描器的类型判定是否真类型驱动而非退化成名字匹配 + 6 类变异 fixture 是否真 pin）。

---

## Self-Review（writing-plans 自检）

**Spec 覆盖**：spec §3-A0（AST sink 盘点 + 6 类 + TypeChecker + 变异 fixture + 每 edge 对应稳定 ID）→ Task 1（骨架 TypeChecker 枚举）+ Task 2（6 类 + fixture）+ Task 3（inventory 升级 + 已知 sink 登记）+ Task 4（接进 check:db-access 门）。§3-A0「已知必纳入 sink #1-7」→ Task 3 完整性测试逐个断言在册。

**Placeholder 扫描**：无 TBD；扫描器代码给了 TS API 骨架 + 实现者注明确「按 TS 6.0.3 真实 API 落地」的点（`isTypeAssignableTo` / enclosing 名取法 / dbSymbols 填充）——这些是「以真实 TS API 为准」的合理委托，非占位（给了具体 API 名 + fallback 策略）。

**类型一致性**：`Edge` 结构（id/file/kind/symbol）跨 Task 1/2 一致；`scanDbCapabilityEdges`/`collectUnregisteredEdges` 签名跨 Task 一致；`disposition` union（Task 3）与 spec §3-A0 处置状态一致（resolver/coordinator/mixed-scope/per-shard-worker/root-only/known-limitation）。

**关键风险自查**：Task 2 的 fixture 目录**故意不登记**——必须确保主 `check:db-access` 排除 `src/test/`（否则 CI 恒红）。已在 Task 2 Step 2 注 + Task 4 Step 3 filter 明确。变异测试单独对 fixture 跑 `collectUnregisteredEdges` 验识别，不进主门。

**边界**：本 Plan **不改任何运行逻辑**（约束 1）——sink 实际下沉是 Plan 1/2/3。Plan 0 交付 = 可 CI 验证的完整性门 + 全仓 edge 已登记 + 处置计划。这是后续放开 fail-closed 的前提。
