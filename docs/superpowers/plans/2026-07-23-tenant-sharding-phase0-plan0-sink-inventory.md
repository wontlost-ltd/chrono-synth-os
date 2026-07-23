# 分片 Phase 0 · Plan 0：DB-capability edge 扫描器 + sink 盘点 + 放开门 Implementation Plan

> 状态：第 2 轮修订（采纳 Codex Plan 复审 52/100 退回——scanner 假完整/edge ID owner 级/canonical type 解析错/形态漏扫等 10 项，全核验真实代码）。
> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development。步骤用 checkbox（`- [ ]`）追踪。

**Goal:** 建一个类型驱动（TS `Program+TypeChecker`）的 **edge 级** DB-capability 扫描器 + 升级 `db-access-inventory.ts` 到 sink 级，使「每条持有 DB 能力的 source→sink edge 都有明确处置 + 接线状态」可被 CI 自动验证——后续 Plan 1/2/3 放开 fail-closed 的完整性前提。**核心不变量：扫描器宁可 fail-closed（canonical type 解析失败/遇未知语法边界/Program 不健康 → 退出非零），也绝不「漏扫却报绿」。**

**Architecture:** 三层 API 分离（Codex 退回 #2）：
- `enumerateDbCapabilityEdges(program, checker, { includeTests })` — **底层内核**，不隐式过滤路径；对每个 declaration/参数/属性/调用实参用 `checker.getTypeAtLocation`（不要求显式 `node.type`）判是否 DB 能力（canonical `IDatabase`/`SyncWriteUnitOfWork` 或结构兼容/别名/union 分量/generic 约束），产 **edge 级**结果（不按 owner 合并）。
- `collectUnregisteredEdges(edges, inventory)` — **纯比较**，无路径过滤：edge id 不在 inventory → 未登记。
- `scanProductionDbCapabilityEdges()` — **唯一**应用 production scope（排除 `src/test/**`）+ Program 健康断言，供主门 `check:db-access` 调。

**scope 诚实（Codex #8）**：本门覆盖 **Node server `src` production surface**（`tsconfig.src.json`：main.ts / main-desktop.ts / main-observability-worker.ts / src/workers / src/server/services / src/**），**不含** `packages/*/src`、`apps/*/src`、`scripts/**`。全文不称「全仓」。

**Tech Stack:** TypeScript 6.0.3（`ts.createProgram`/`getTypeChecker`/`isTypeAssignableTo` 已核实可用）。扫描器 = 纯 Node ESM（`scripts/db-sink-scanner.mjs`）。inventory 是 `src/storage/db-access-inventory.ts`——**`.mjs` 不能 import `.ts`**（Codex #9）：扫描器读 inventory 用 `readFileSync + 正则解析 id`（镜像现有 ratchet `check-db-access-ratchet.mjs:53` 的 `readFileSync(...'.ts','utf-8')` 手法），非 import。

## Global Constraints

1. **不改运行逻辑**：只加扫描器 + 改 `db-access-inventory.ts` 数据 + 测试；不碰任何 src 运行代码（sink 下沉是 Plan 1/2/3）。
2. **fail-closed 优先**：canonical DB/UoW type 解析失败、Program 有致命 diagnostic、root file 为空、遇「含 DB capability 但未知语法边界」→ **扫描器退出非零**，绝不返回空/部分 edge 静默报绿。
3. **edge 级 ID（非 owner 级）**：`id = <file>#<owner>::<kind>::<canonical-callee-or-target>::<param-or-prop>`——同一函数内不同 callee/target/param 是**不同** edge，禁按 owner 合并（Codex #1）。
4. **类型驱动非名字**：用 `checker.getTypeAtLocation` + `isTypeAssignableTo(t, uowType)`（逐 union 分量）+ `getAliasedSymbol`，处理 alias/结构兼容/inferred/union·optional/intersection/generic 约束（Codex #4/#5/#6）。禁 `getBaseTypes` fallback（漏纯结构实现）。
5. **每类形态逐文件逐 edge pin**（Codex #3）：表驱动，6 fixture 各自断言「产精确 kind 的 edge + edge id 含具体 target/param + 删登记后进 unregistered」。
6. **disposition 必填 + wiringStatus 分离**（Codex #10）：`disposition`（目标处置）**必填**（非 optional）；另加 `wiringStatus: 'planned'|'wired'|'verified'`——Plan 0 允许 `planned`；放开 fail-closed（Plan 3）要求所有危险 edge `verified` 且 `known-limitation` 不用于可能错-shard 的 edge。
7. **中文注释**；接进 `test:golden` 的 `check:db-access`；不改运行时行为故现有全测试零回归。
8. **测试位置**：`src/test/unit/db-sink-scanner.test.ts`；fixture 放 `src/test/support/db-sink-fixtures/`（主门 production scope 排除 `src/test/`，fixture 测试用 `includeTests:true` 走同一内核）。

---

## File Structure

- `scripts/db-sink-scanner.mjs` — 三层 API 扫描器（核心）。
- `src/storage/db-access-inventory.ts` — 升级 sink 级（`disposition` 必填 + `wiringStatus` + 纠正 buildAppServices + 登记已知 sink）。
- `scripts/check-db-access-ratchet.mjs` — 改调 `scanProductionDbCapabilityEdges` + `collectUnregisteredEdges`。
- `src/test/support/db-sink-fixtures/{ctor-param,deps-prop,route-param,capture,factory-indirect,type-alias}.ts` — 6 类变异 fixture。
- `src/test/unit/db-sink-scanner.test.ts` — 纯类型判定单元测 + 6 类逐文件 pin + Program 健康/sentinel + fail-closed 测。
- `src/test/unit/db-access-inventory-completeness.test.ts` — inventory 每条目 disposition+wiringStatus + 已知 sink 在册 + buildAppServices 纠正。

---

## Task 1: 类型判定内核 + canonical type fail-closed + Program 健康门

**Files:**
- Create: `scripts/db-sink-scanner.mjs`（`resolveCanonicalDbTypes` + `isDbCapabilityType` + `buildProgram` + 健康断言）
- Test: `src/test/unit/db-sink-scanner.test.ts`（纯类型判定 + fail-closed）

**Interfaces:**
- Produces: `buildProgram(tsconfigPath) → { program, checker, uowType }`（含 canonical `SyncWriteUnitOfWork` type，解析失败抛）；`isDbCapabilityType(type, checker, uowType) → boolean`（逐 union 分量 assignableTo）。

**关键真实契约（已核实）**：
- canonical type 来自 **`.d.ts`**：`tsconfig.src.json`（`rootDir:src` + kernel 是 `references` 项）→ `SyncWriteUnitOfWork` 解析到 `packages/kernel/dist/ports/sync-unit-of-work.d.ts`（**不是** `src/.ts`，该 .d.ts 已存在）。`IDatabase` 在 `src/storage/database.ts:27` `extends SyncWriteUnitOfWork`。
- 解析路径：从 `src/storage/database.ts` 的 `IDatabase` export symbol 出发（`checker.getExportsOfModule` 或找该文件 InterfaceDeclaration），`getAliasedSymbol` 解 alias，取其类型；`SyncWriteUnitOfWork` 从 `IDatabase` 的 heritage 或直接从 kernel module export 解析。
- `isTypeAssignableTo(t, uowType)` 判结构兼容——但对 `IDatabase | undefined` 不直接返 true，须 `type.isUnion() ? type.types.some(...) : isTypeAssignableTo(...)`。

- [ ] **Step 1: 写纯类型判定 fixture + 失败测试**

先建最小类型样本（放 fixture 目录，本 task 只用 type-alias/negative）：
```typescript
// src/test/support/db-sink-fixtures/type-alias.ts
// canonical / alias / 结构兼容 / union / generic / 非 DB negative —— 供类型判定单元测
import type { IDatabase } from '../../../storage/database.js';
import type { SyncWriteUnitOfWork } from '@chrono/kernel';
export type DbAlias = IDatabase;                          // 别名
export interface StructuralDb { prepare: IDatabase['prepare']; execute: IDatabase['execute']; transaction: IDatabase['transaction']; transactionRollback: IDatabase['transactionRollback']; queryOne: IDatabase['queryOne']; queryMany: IDatabase['queryMany']; close: IDatabase['close']; }  // 结构兼容（不 extends）
export function optionalDb(db?: IDatabase): void { void db; }         // union | undefined
export function genericDb<T extends SyncWriteUnitOfWork>(tx: T): void { void tx; }  // generic 约束
export interface NotDb { foo: string; }                   // negative control
```
```typescript
// src/test/unit/db-sink-scanner.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildProgram, isDbCapabilityType } from '../../../scripts/db-sink-scanner.mjs';

test('canonical DB/UoW type 解析成功（否则 fail-closed）', () => {
  const { uowType } = buildProgram('tsconfig.src.json');
  assert.ok(uowType, 'canonical SyncWriteUnitOfWork 未解析——扫描器应 fail-closed 而非空扫');
});

test('类型判定：canonical/alias/结构兼容/union/generic 都判 DB 能力；negative 不判', () => {
  const { program, checker, uowType } = buildProgram('tsconfig.src.json');
  // 从 type-alias.ts 取各样本的类型（实现者按 AST 定位对应节点）
  const probe = (symbolName) => /* 取该 export 的类型 */ null;
  assert.equal(isDbCapabilityType(probe('DbAlias'), checker, uowType), true);
  assert.equal(isDbCapabilityType(probe('StructuralDb'), checker, uowType), true);   // 结构兼容（禁 getBaseTypes fallback 才能过）
  assert.equal(isDbCapabilityType(probe('NotDb'), checker, uowType), false);         // negative
});

test('fail-closed：canonical type 解析失败 → buildProgram 抛（不返回空 uowType）', () => {
  assert.throws(() => buildProgram('tsconfig.does-not-exist.json'));
});
```

- [ ] **Step 2: 运行确认失败** — `npx tsx --test src/test/unit/db-sink-scanner.test.ts`（FAIL：模块不存在）

- [ ] **Step 3: 写 `buildProgram` + `isDbCapabilityType`（fail-closed + 结构兼容 + Program 健康）**

```javascript
// scripts/db-sink-scanner.mjs
import ts from 'typescript';
import { readFileSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const SENTINELS = ['src/main.ts', 'src/main-desktop.ts', 'src/main-observability-worker.ts', 'src/server/app.ts'];

export function buildProgram(tsconfigPath = 'tsconfig.src.json') {
  const configPath = join(ROOT, tsconfigPath);
  const parsed = ts.getParsedCommandLineOfConfigFile(configPath, {}, {
    ...ts.sys, onUnRecoverableConfigFileDiagnostic: (d) => { throw new Error(`tsconfig 解析失败: ${d.messageText}`); },
  });
  if (!parsed || parsed.fileNames.length === 0) throw new Error('Program root files 为空——fail-closed');
  const program = ts.createProgram(parsed.fileNames, parsed.options);
  const checker = program.getTypeChecker();
  /* Program 健康：sentinel 生产入口必须在 Program（tsconfig 路径错→sentinel 缺→fail-closed，防空扫假绿）。 */
  const roots = new Set(program.getSourceFiles().map((sf) => relative(ROOT, sf.fileName)));
  for (const s of SENTINELS) if (![...roots].some((r) => r === s)) throw new Error(`sentinel 缺失 ${s}——Program 范围不对，fail-closed`);
  /* canonical UoW type：从 database.ts 的 IDatabase 解析（extends SyncWriteUnitOfWork）。 */
  const uowType = resolveCanonicalUowType(program, checker);
  if (!uowType) throw new Error('canonical SyncWriteUnitOfWork 未解析——fail-closed（绝不空扫报绿）');
  return { program, checker, uowType, parsed };
}

function resolveCanonicalUowType(program, checker) {
  const dbFile = program.getSourceFiles().find((sf) => relative(ROOT, sf.fileName) === 'src/storage/database.ts');
  if (!dbFile) return undefined;
  let uow;
  ts.forEachChild(dbFile, (node) => {
    if (ts.isInterfaceDeclaration(node) && node.name.text === 'IDatabase') {
      const t = checker.getTypeAtLocation(node);
      uow = t;  // IDatabase 本身即 DB 能力上界（extends UoW）；判定用 assignableTo(t, IDatabase-or-UoW)
    }
  });
  return uow;
}

/** 逐 union 分量 assignableTo（IDatabase|undefined 不直接过）；禁 getBaseTypes fallback。 */
export function isDbCapabilityType(type, checker, uowType) {
  if (!type) return false;
  if (type.isUnion?.()) return type.types.some((t) => isDbCapabilityType(t, checker, uowType));
  if (type.isIntersection?.()) return type.types.some((t) => isDbCapabilityType(t, checker, uowType));
  // generic 约束：T extends SyncWriteUnitOfWork → 取 constraint
  const constraint = type.isTypeParameter?.() ? checker.getBaseConstraintOfType(type) : undefined;
  if (constraint && isDbCapabilityType(constraint, checker, uowType)) return true;
  // 结构兼容：能赋给 uowType（IDatabase）即 DB 能力。undefined/null/primitive 不能赋 → false。
  try { return checker.isTypeAssignableTo(type, uowType); } catch { return false; }
}
```
> 实现者注：`resolveCanonicalUowType` 若 IDatabase 定位不到 → 返回 undefined → buildProgram 抛（fail-closed）。`isTypeAssignableTo(type, uowType)` 用 IDatabase 作上界（比 UoW 更严，避免把只读 UoW 也算——但 spec 要 UoW 也算 DB 能力，故 uowType 取 IDatabase 的 apparent/或单独解析 SyncWriteUnitOfWork；实现者确认用哪个作上界并在测试固定：结构兼容 `StructuralDb`（含 UoW 全方法）须判 true）。`probe` 取节点类型照 TS AST（找 export 声明 → getTypeAtLocation）。

- [ ] **Step 4: 运行确认通过** — 3 测试（canonical 解析 / 类型判定含结构兼容+negative / fail-closed 抛）

- [ ] **Step 5: Commit** — `git add scripts/db-sink-scanner.mjs src/test/support/db-sink-fixtures/type-alias.ts src/test/unit/db-sink-scanner.test.ts && git commit -m "feat(shard): DB-capability 类型判定内核（canonical fail-closed + 结构兼容/union/generic + Program sentinel 门)"`（结尾 Co-Authored-By）

---

## Task 2: edge 级枚举 — 全注入形态 + edge 级 ID（禁 owner 合并）

**Files:**
- Modify: `scripts/db-sink-scanner.mjs`（`enumerateDbCapabilityEdges`——参/属性/deps-prop/route-param/capture/factory-indirect/对象包装 + edge 级 id + 未知边界 fail-closed）
- Create: fixture `{ctor-param,deps-prop,route-param,capture,factory-indirect}.ts`
- Test: `src/test/unit/db-sink-scanner.test.ts`（6 类逐文件逐 edge pin + owner 合并回归）

**Interfaces:**
- Produces: `enumerateDbCapabilityEdges(program, checker, uowType, { includeTests }) → Edge[]`；`Edge = { id, file, owner, kind, target, param }`，`id = <file>#<owner>::<kind>::<target>::<param>`。

**关键（Codex 退回逐条）**：
- **edge 级 ID（#1）**：同一 owner 内 `new RuntimeRecoveryWorker(db)` / `new NudgePushBridge({db})` / `registerXxxRoutes(app, db)` 是 3 条不同 edge（不同 target/param），id 各异，**禁 byId owner 合并**。回归测试：同函数加第二个 sink → unregistered 非空。
- **capture（#4）**：不只 Identifier——对 `PropertyAccessExpression`（`this.db`/`this.deps.db`/`opts.db`）、`ElementAccessExpression`、`BindingElement`（解构）、`ShorthandPropertyAssignment`、`AsExpression`/括号 整体调 `getTypeAtLocation` 判 DB 能力；capture 须验引用声明在**当前函数作用域外**（否则是本地 param 非捕获）。
- **factory-indirect（#5）**：不只直接 DB 实参——`new Service({db})`（对象字面量属性）、`new Service(options)`（options.db: IDatabase）、`return {db}`、`arr.push(db)`、`map.set(k, db)`。做法：看**被调目标参数类型**是否含 DB capability（`checker.getResolvedSignature` 取参数类型），对象字面量则把属性映射到 target property。
- **inferred（#6）**：`private readonly db = os.getDatabase()`（无 `node.type`）——对 declaration/name/initializer 调 `getTypeAtLocation`，**不要求 `node.type` 存在**。
- **未知边界 fail-closed（#6）**：遇到「表达式类型含 DB capability 但落在枚举器未覆盖的语法 kind」→ 记为 `unknown-boundary` edge 并使门红（宁可误报也不漏）。

- [ ] **Step 1: 写 5 个 fixture（各一形态最小样本）+ 表驱动 pin 测试**

```typescript
// 表驱动逐文件断言（Codex #3）
const FIXTURE_TABLE = [
  ['ctor-param.ts', 'ctor-param'], ['deps-prop.ts', 'deps-prop'], ['route-param.ts', 'route-param'],
  ['capture.ts', 'capture'], ['factory-indirect.ts', 'factory-indirect'],
];
for (const [file, kind] of FIXTURE_TABLE) {
  test(`fixture ${file} 产 ${kind} edge + edge id 含 target/param`, () => {
    const { program, checker, uowType } = buildProgram('tsconfig.src.json');
    const edges = enumerateDbCapabilityEdges(program, checker, uowType, { includeTests: true })
      .filter((e) => e.file.includes(`db-sink-fixtures/${file}`));
    assert.ok(edges.some((e) => e.kind === kind), `${file} 未产 ${kind} edge`);
    assert.ok(edges.every((e) => e.id.split('::').length >= 4), 'edge id 非 edge 级（缺 target/param 段）');
  });
  test(`fixture ${file} 删登记 → 进 unregistered`, () => {
    const { program, checker, uowType } = buildProgram('tsconfig.src.json');
    const edges = enumerateDbCapabilityEdges(program, checker, uowType, { includeTests: true });
    const unreg = collectUnregisteredEdges(edges, /* 空 inventory */ new Set());
    assert.ok(unreg.some((e) => e.file.includes(`db-sink-fixtures/${file}`)));
  });
}
test('回归：同一 owner 内新增第二个 sink 不被 owner 合并吞掉', () => {
  // capture.ts 里放两个不同 target 的 sink → 断言 2 条独立 edge（非合并 1 条）
  const { program, checker, uowType } = buildProgram('tsconfig.src.json');
  const edges = enumerateDbCapabilityEdges(program, checker, uowType, { includeTests: true })
    .filter((e) => e.file.includes('db-sink-fixtures/factory-indirect'));
  const targets = new Set(edges.map((e) => e.target));
  assert.ok(targets.size >= 2, '同 owner 多 target 被错误合并');   // fixture 放两个 new X(db)/new Y(db)
});
```
（fixture 样本略——每个含该形态；factory-indirect.ts 放 ≥2 个不同 `new X(db)` 证 edge 级。）

- [ ] **Step 2: 运行确认失败**（enumerate 未实现）

- [ ] **Step 3: 写 `enumerateDbCapabilityEdges`（全形态 + edge 级 id + 未知边界 fail-closed）**

（按上「关键」逐条实现：visit 参数/属性用 `getTypeAtLocation` 不要求 node.type；PropertyAccess/ElementAccess/BindingElement 整体判；new/call 用 `getResolvedSignature` 看目标参类型含 DB capability，对象字面量映射属性；capture 验作用域外；未知语法边界含 DB capability → `unknown-boundary` edge。id = `${rel}#${owner}::${kind}::${target}::${param}`。`{includeTests}` 控是否排 `src/test/`。**不做 byId owner 合并**，只去重完全相同 id。）

- [ ] **Step 4: 运行确认通过**（6 类逐文件 pin + edge 级 + 合并回归全绿）

- [ ] **Step 5: Commit** — `feat(shard): edge 级枚举全注入形态（property-access/对象包装/inferred/capture + 未知边界 fail-closed）`

---

## Task 3: 升级 inventory 到 sink 级（disposition 必填 + wiringStatus + 登记全部已知 sink）

**Files:**
- Modify: `src/storage/db-access-inventory.ts`
- Test: `src/test/unit/db-access-inventory-completeness.test.ts`

**Interfaces:**
- `DbAccessPoint` 加 `readonly disposition: DbAccessDisposition`（**必填**）+ `readonly wiringStatus: 'planned'|'wired'|'verified'`；id 用 edge 级格式（Task 2）。

- [ ] **Step 1: 写完整性失败测试**（每条目 disposition+wiringStatus 必填非空；已知 sink `app-services`/`task-queue`/`legal-hold-service`/`nudge-push-bridge`/`main-observability-worker`/`settlement-reconciliation-worker`/`dual-write-flush-worker`/`media-retention-worker`/`runtime-recovery-worker`/`auth-service` 都在册；buildAppServices 非 `explicit-per-request`；`known-limitation` disposition 的条目断言其 note 说明「不可能错-shard」的理由）

- [ ] **Step 2: 运行确认失败**

- [ ] **Step 3: 升级 inventory**（`disposition` 必填 union（resolver/coordinator/mixed-scope/per-shard-worker/root-only/known-limitation）+ `wiringStatus`（Plan 0 全填 `planned`）+ 纠正 buildAppServices 为 longlived-root-capture + 逐成员拆条目 + 新增 §3-A0 #4-7 全部已知 sink，disposition 照 spec 定性：Auth=mixed-scope、跨租户 worker=per-shard-worker、buildAppServices 成员=resolver）

- [ ] **Step 4: 运行确认通过**

- [ ] **Step 5: Commit** — `feat(shard): inventory 升级 sink 级（disposition 必填+wiringStatus+登记全部已知 sink+纠正 buildAppServices)`

---

## Task 4: production scope 主门 + 全 edge 已登记基线 + 接 check:db-access

**Files:**
- Modify: `scripts/db-sink-scanner.mjs`（`scanProductionDbCapabilityEdges` + `collectUnregisteredEdges` 纯比较 + 读 inventory id 用 readFileSync 正则）
- Modify: `scripts/check-db-access-ratchet.mjs`（调 production 门）
- Test: `src/test/unit/db-sink-scanner.test.ts`（production 基线绿 + Program 健康门测）

**Interfaces:**
- `scanProductionDbCapabilityEdges() → Edge[]`（`buildProgram` + `enumerate({includeTests:false})`）；`collectUnregisteredEdges(edges, inventoryIds: Set)`（纯比较）；`readInventoryIds()`（`readFileSync('src/storage/db-access-inventory.ts')` 正则抽 `id: '...'`——`.mjs` 不 import `.ts`）。

- [ ] **Step 1: 写「production 无未登记 edge」基线测试**（`collectUnregisteredEdges(scanProductionDbCapabilityEdges(), readInventoryIds())` === []；含具体未登记 id 的诊断输出）+ Program 健康门测（sentinel 缺 → 抛）

- [ ] **Step 2: 运行——预期先红，暴露真实未登记 edge**：把它们逐条登进 inventory（Task 3 续补，disposition+wiringStatus:planned）→ 至绿。**红时补 inventory，绝不改扫描器放宽/加白名单。** 若某形态 edge 数异常少（如 factory-indirect 生产里一条没有）→ 警惕扫描器漏扫该形态，回 Task 2 补，非跳过。

- [ ] **Step 3: 改 `check-db-access-ratchet.mjs` 调 production 门**（`scanProductionDbCapabilityEdges` + `collectUnregisteredEdges(edges, readInventoryIds())`；非空 → 列 id+kind 退出 1；保留原 file 级作补充网）

- [ ] **Step 4: `npm run check:db-access` + 全 scanner/inventory 测试绿**

- [ ] **Step 5: Commit** — `feat(shard): check:db-access 升级 production edge 门（未登记 DB-capability edge→红）`

---

## 收尾（全 task 完成后）

- [ ] **本地全量门**：`npm run test:golden`（EXIT 0；本 Plan 不改运行逻辑故 unit/integration/parity 零回归；`check:db-access` 现为 edge 门——红则补 inventory 非放宽）。
- [ ] **最终整片 code review**（最强模型审：重点核**扫描器是否真类型驱动而非退化名字匹配、canonical type 是否真从 .d.ts 解析成功且解析失败真 fail-closed、6 类形态是否真逐一被生产代码或 fixture 覆盖、edge 级 ID 是否真防 owner 合并、有无扫描器漏扫某形态导致的假完整**——这是隔离门的门，假完整=灾难）。

## Self-Review（writing-plans 自检）

**Spec 覆盖**：§3-A0（类型驱动 TypeChecker + 6 类形态 + 变异 fixture + 每 edge 稳定 ID + fail-closed）→ Task 1（类型判定内核 + canonical fail-closed + Program 健康）+ Task 2（edge 级全形态枚举）+ Task 3（inventory sink 级）+ Task 4（production 门）。已知 sink #1-7 → Task 3 完整性测试。

**采纳 Codex Plan 复审 10 项**：①edge 级 ID（Task 2 id 格式+合并回归）②三层 API 分离（enumerate/collect/scanProduction）③6 类逐文件表驱动 pin ④canonical type 从 .d.ts + 解析失败 fail-closed（Task 1）⑤property-access/对象包装/inferred/union/generic（Task 1/2）⑥未知边界 fail-closed ⑦Program sentinel/diagnostic 健康门 ⑧scope 诚实「Node server src」非全仓 ⑨`.mjs` 读 inventory 用 readFileSync 正则非 import ⑩disposition 必填 + wiringStatus 分离。

**假完整防线（最关键）**：扫描器漏扫是最致命的假绿——防线 = ①fail-closed（canonical/sentinel/未知边界任一异常即红，不空扫）②6 类 fixture 证识别能力 ③终审专项核「有无漏扫形态」④wiringStatus 使「planned≠verified」，放开门（Plan 3）要 verified。诚实承认：fixture 只证「已知形态能识别」，证不了「无第 7 类未知形态」——故未知语法边界 fail-closed 是兜底（遇 DB capability 但语法 kind 未覆盖 → 红，逼人显式处理）。

**类型一致性**：`Edge`（id/file/owner/kind/target/param）跨 Task 2/4 一致；`buildProgram`/`enumerateDbCapabilityEdges`/`collectUnregisteredEdges`/`scanProductionDbCapabilityEdges` 三层签名一致；`disposition`/`wiringStatus` union 与 spec 处置状态一致。
