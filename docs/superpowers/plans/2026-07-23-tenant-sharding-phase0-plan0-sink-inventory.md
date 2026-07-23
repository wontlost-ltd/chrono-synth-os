# 分片 Phase 0 · Plan 0：DB-capability edge 扫描器 + sink 盘点 + 放开门 Implementation Plan

> 状态：第 8 轮修订（实现中 Codex 又裁决 carrier 压缩：81% edge 是 OS-facade 传递展开→压成一条 carrier sink+resolved provenance 验来源非按类型放行；加 Task 2.6）。前轮 spec Codex 96、Plan 0 Codex 95。
> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development。步骤用 checkbox（`- [ ]`）追踪。

**Goal:** 建一个类型驱动（TS `Program+TypeChecker`）的 DB-capability 扫描器（保留全量 edge 作机器证据图）+ 升级 `db-access-inventory.ts` 到 **semantic sink 级**，使「每个 semantic sink 有明确处置 + 每条传播 edge 可归因（linked-to-sink / ephemeral / terminal-escape）+ 无 unknown」可被 CI 自动验证——后续 Plan 1/2/3 放开 fail-closed 的完整性前提。**核心不变量：扫描器宁可 fail-closed（canonical 解析失败/Program 不健康/递归预算超限/无法归因的 edge → 退出非零），也绝不「漏扫却报绿」。**

**粒度（Codex 第 7 轮裁决——7701 syntax edge 不可手工登记）**：人工 inventory 登记 **semantic sink**，全量 edge 留机器证据图：
- **semantic sink（人工登记，精确到成员/capability path）**：① **A 接收/存储点**（A1-A4：ctor/fn/method 参数、parameter property、class field、deps/property signature）；② **terminal-B-escape**（无法机械证明落到某 A 点、且能力可能跨调用/作用域/生命周期存活的 B edge：module export / timer·closure·worker capture / 动态 assignment / container write map.set / 逃逸到未知调用方的 return / 传给外部·any·动态边界的 call）。
- **B 传播 edge（不登记，机器归因三态）**：`linked-to-sink`（能机械定位终点=已登记 A 点，如 `new Service(db)`→`Service.ctor(db)`）/ `ephemeral`（机械证明能力不逃逸：仅同步传给明确 per-request 函数、不返回不存字段不注册 callback 不写容器）/ `terminal-escape`（升级为 semantic sink 登记）/ `unknown`（解析失败/预算超限/callee 不明且未升级 escape → **门红**）。

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
5. **每类形态逐文件逐 edge pin**（Codex #3）：表驱动，全部 fixture（A1-A4 接收 + B1-B8 转移）各自 deepEqual 完整期望集「产精确 kind 的 edge + edge id 含具体 target/param + 删登记后进 unregistered」。
6. **disposition 必填 + wiringStatus 分离**（Codex #10）：`disposition`（目标处置）**必填**（非 optional）；另加 `wiringStatus: 'planned'|'wired'|'verified'`——Plan 0 允许 `planned`；放开 fail-closed（Plan 3）要求所有危险 edge `verified` 且 `known-limitation` 不用于可能错-shard 的 edge。
7. **中文注释**；接进 `test:golden` 的 `check:db-access`；不改运行时行为故现有全测试零回归。
8. **测试位置**：`src/test/unit/db-sink-scanner.test.ts`；fixture 放 `src/test/support/db-sink-fixtures/`（主门 production scope 排除 `src/test/`，fixture 测试用 `includeTests:true` 走同一内核）。

---

## File Structure

- `scripts/db-sink-scanner.mjs` — 三层 API 扫描器（核心）。
- `scripts/db-sink-scanner.d.mts` — 扫描器的类型声明（供 `tsx`/strict TS 测试 import 时有声明，避免 `npm run typecheck` 无声明模块错误，Codex #4）。
- `src/storage/db-access-inventory.ts` — 升级 sink 级（`disposition` 必填 + `wiringStatus` + 纠正 buildAppServices + 登记已知 sink）。
- `scripts/check-db-access-ratchet.mjs` — 改调 `scanProductionDbCapabilityEdges` + `collectUnregisteredEdges`。
- `src/test/support/db-sink-fixtures/{type-alias,ctor-param,deps-prop,route-param,capture,factory-indirect,wrapped,export-transfer,pair,sink-decl,function-like}.ts` — 变异 fixture（覆盖 A1-A4 接收 + B1-B8 转移各形态）。
- `src/test/unit/db-sink-scanner.test.ts` — 纯类型判定单元测 + 全 FIXTURE_EXPECT 逐文件 deepEqual pin + Program 健康/sentinel + fail-closed 测。
- `src/test/unit/db-access-inventory-completeness.test.ts` — inventory 每条目 disposition+wiringStatus + 已知 sink 在册 + buildAppServices 纠正。

---

## Task 1: 类型判定内核 + canonical type fail-closed + Program 健康门

**Files:**
- Create: `scripts/db-sink-scanner.mjs`（`buildProgram` + `resolveCanonicalUowType` + `isDbCapabilityType` + 健康断言）
- Create: `scripts/db-sink-scanner.d.mts`（导出上述函数签名 + `Edge` 类型，供 TS 测试 import 有声明）
- Create: `src/test/support/db-sink-fixtures/tsconfig.sentinel-missing.json`（只 include 无 sentinel 的文件，测 Program 健康 fail-closed）
- Test: `src/test/unit/db-sink-scanner.test.ts`（纯类型判定 + fail-closed + Program 健康）

**Interfaces:**
- Produces: `buildProgram(tsconfigPath) → { program, checker, uowType }`（含 canonical `SyncWriteUnitOfWork` type，解析失败抛）；`isDbCapabilityType(type, checker, uowType) → boolean`（逐 union 分量 assignableTo）。

**关键真实契约（已核实——canonical 上界必须是 `SyncWriteUnitOfWork` 非 `IDatabase`，Codex 退回 #1）**：
- **capability 上界 = `SyncWriteUnitOfWork`**（`packages/kernel/src/ports/sync-unit-of-work.ts:15`，`extends SyncReadUnitOfWork`——成员仅 `queryOne/queryMany/execute/transaction`）。`IDatabase`（`database.ts:27` extends UoW，**额外**要求 `dialect/exec/prepare/transactionRollback/close`）是**更严**的子集——若用 IDatabase 作上界，任何只持 `SyncWriteUnitOfWork` 的长期 service/closure（如 `fromUnitOfWork(tx)` 传的 tx）会被**漏扫**。故 `isTypeAssignableTo(t, uowType)` 的 `uowType` **必须**是 `SyncWriteUnitOfWork` 的 type（不是 IDatabase）。`IDatabase` 只作额外分类标签，不作检测上界。
- canonical 解析（fail-closed）：tsconfig.src.json（kernel 是 `references` 项）→ `SyncWriteUnitOfWork` 解析到 `packages/kernel/dist/ports/sync-unit-of-work.d.ts`（已存在）。**从 `src/storage/database.ts` 的 `IDatabase` interface 的 heritage clause（`extends SyncWriteUnitOfWork`）取其基类型 symbol → `getAliasedSymbol` 解 alias → 取 `SyncWriteUnitOfWork` 的 type**；或直接从 kernel module export 找 `SyncWriteUnitOfWork` export symbol。解析不到 → 抛（fail-closed）。**无「实现者确认用哪个」的开放决策——就是 SyncWriteUnitOfWork。**
- `isTypeAssignableTo(t, uowType)`：`IDatabase|undefined` 不直接返 true → `type.isUnion() ? type.types.some(...) : isTypeAssignableTo(...)`（逐分量）。

- [ ] **Step 1: 写纯类型判定 fixture + 失败测试**

先建最小类型样本（放 fixture 目录，本 task 只用 type-alias/negative）：
```typescript
// src/test/support/db-sink-fixtures/type-alias.ts
// canonical / alias / 结构兼容 / union / generic / 非 DB negative —— 供类型判定单元测
import type { IDatabase } from '../../../storage/database.js';
import type { SyncWriteUnitOfWork } from '@chrono/kernel';
export type DbAlias = IDatabase;                          // 别名
// 结构兼容：只含 SyncWriteUnitOfWork 的 4 个方法（queryOne/queryMany/execute/transaction），
// 不 extends、不含 IDatabase 的 dialect/exec/prepare/close——必须判 true（证上界是 UoW 非 IDatabase）。
export interface StructuralUow { queryOne: SyncWriteUnitOfWork['queryOne']; queryMany: SyncWriteUnitOfWork['queryMany']; execute: SyncWriteUnitOfWork['execute']; transaction: SyncWriteUnitOfWork['transaction']; }
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

test('类型判定：canonical/alias/结构兼容(纯UoW)/union/generic 都判 DB 能力；negative 不判', () => {
  const { program, checker, uowType } = buildProgram('tsconfig.src.json');
  // probeType：取 type-alias.ts 里某声明的**目标类型**——类型别名取其别名类型；
  // 函数取**指定参数**的类型（optionalDb 取 db 参、genericDb 取 tx 参），非函数整体类型（Codex 第3轮 #4）。
  const probeType = (declName, paramName) => /* 实现者：AST 定位该 export 声明；若给 paramName 则取该参数节点 getTypeAtLocation */ null;
  assert.equal(isDbCapabilityType(probeType('DbAlias'), checker, uowType), true);            // 别名类型
  assert.equal(isDbCapabilityType(probeType('StructuralUow'), checker, uowType), true);      // 纯 UoW 4 方法（证上界=UoW 非 IDatabase）
  assert.equal(isDbCapabilityType(probeType('optionalDb', 'db'), checker, uowType), true);   // db 参类型 IDatabase|undefined（逐分量）
  assert.equal(isDbCapabilityType(probeType('genericDb', 'tx'), checker, uowType), true);    // tx 参类型 T extends UoW（getBaseConstraintOfType）
  assert.equal(isDbCapabilityType(probeType('NotDb'), checker, uowType), false);             // negative control
});

test('fail-closed：tsconfig 不存在 → buildProgram 抛（不返回空 uowType）', () => {
  assert.throws(() => buildProgram('tsconfig.does-not-exist.json'));
});

test('fail-closed：Program 建出但 sentinel 缺（传只含无关文件的 tsconfig）→ 抛，不空扫报绿', () => {
  // 实现者：造一个临时 tsconfig 只 include 一个无 sentinel 的文件，断言 buildProgram 抛「sentinel 缺失」
  //（证「Program 存在但范围不对」也 fail-closed，非只测 tsconfig 不存在）
  assert.throws(() => buildProgram('src/test/support/db-sink-fixtures/tsconfig.sentinel-missing.json'), /sentinel 缺失/);
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
  /* Program 健康（fail-closed，Codex #4）：config/options/syntactic 致命 diagnostic 或 sentinel 缺 → 抛，
   * 防「Program 建出来了但源码解析残缺/canonical 类型不可信」时静默空扫报绿。 */
  const fatal = [
    ...program.getConfigFileParsingDiagnostics(),
    ...program.getOptionsDiagnostics(),
    ...program.getGlobalDiagnostics(),
    ...program.getSyntacticDiagnostics(),  // 语法错=源码没被正确解析→类型不可信
  ].filter((d) => d.category === ts.DiagnosticCategory.Error);
  if (fatal.length > 0) throw new Error(`Program 致命 diagnostic ${fatal.length} 条——fail-closed: ${ts.flattenDiagnosticMessageText(fatal[0].messageText, '\n')}`);
  const checker = program.getTypeChecker();
  /* sentinel 生产入口必须在 Program（tsconfig 路径错→sentinel 缺→fail-closed）。 */
  const roots = new Set(program.getSourceFiles().map((sf) => relative(ROOT, sf.fileName)));
  for (const s of SENTINELS) if (!roots.has(s)) throw new Error(`sentinel 缺失 ${s}——Program 范围不对，fail-closed`);
  // 注：不校验全库 semantic diagnostics（跨包类型噪音多）——只 config/options/syntactic 致命项 + canonical 解析 + sentinel。
  /* canonical UoW type：从 database.ts 的 IDatabase 解析（extends SyncWriteUnitOfWork）。 */
  const uowType = resolveCanonicalUowType(program, checker);
  if (!uowType) throw new Error('canonical SyncWriteUnitOfWork 未解析——fail-closed（绝不空扫报绿）');
  return { program, checker, uowType, parsed };
}

/** 解析 canonical SyncWriteUnitOfWork 的 type（capability 上界——非 IDatabase！IDatabase 更严会漏纯 UoW sink）。
 * 从 IDatabase 的 heritage `extends SyncWriteUnitOfWork` 取基类型 symbol，getAliasedSymbol 解 alias。 */
function resolveCanonicalUowType(program, checker) {
  const dbFile = program.getSourceFiles().find((sf) => relative(ROOT, sf.fileName) === 'src/storage/database.ts');
  if (!dbFile) return undefined;
  let uowType;
  ts.forEachChild(dbFile, (node) => {
    if (ts.isInterfaceDeclaration(node) && node.name.text === 'IDatabase' && node.heritageClauses) {
      for (const h of node.heritageClauses) {
        for (const t of h.types) {
          const sym = checker.getSymbolAtLocation(t.expression);
          const target = sym && sym.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(sym) : sym;
          if (target && target.name === 'SyncWriteUnitOfWork') {
            uowType = checker.getDeclaredTypeOfSymbol(target);  // canonical UoW type（.d.ts）
          }
        }
      }
    }
  });
  return uowType;  // 未解析 → undefined → buildProgram 抛（fail-closed）
}

/** 逐 union 分量 assignableTo（IDatabase|undefined 不直接过）；禁 getBaseTypes fallback。 */
export function isDbCapabilityType(type, checker, uowType) {
  if (!type) return false;
  if (type.isUnion?.()) return type.types.some((t) => isDbCapabilityType(t, checker, uowType));
  if (type.isIntersection?.()) return type.types.some((t) => isDbCapabilityType(t, checker, uowType));
  // generic 约束：T extends SyncWriteUnitOfWork → 取 constraint
  const constraint = type.isTypeParameter?.() ? checker.getBaseConstraintOfType(type) : undefined;
  if (constraint && isDbCapabilityType(constraint, checker, uowType)) return true;
  // 结构兼容：能赋给 uowType（SyncWriteUnitOfWork）即 DB 能力。undefined/null/primitive 不能赋 → false。
  // ⚠️ 绝不 try/catch→return false（Codex #1：吞异常=静默漏扫假绿）。checker 抛异常 → 带 context 重抛 → 扫描器退出非零（fail-closed）。
  return checker.isTypeAssignableTo(type, uowType);
}
// isDbCapabilityType 的任何调用点若担心 checker 抛，须在**顶层** catch 后**重抛带 node/file context**（fail-closed），
// 绝不在此吞成 false。getResolvedSignature/getTypeAtLocation/getBaseConstraintOfType 同理——异常→重抛，非默认「非 DB」。
```
> 实现者注：`resolveCanonicalUowType` 定位不到 SyncWriteUnitOfWork → undefined → buildProgram 抛（fail-closed）。**上界固定为 `SyncWriteUnitOfWork`（非 IDatabase）**——`StructuralUow`（仅 4 个 UoW 方法）须判 true 是这个选择的验收锚（用 IDatabase 作上界此断言会红）。`getDeclaredTypeOfSymbol` 取 interface symbol 的声明类型。`probe` 取节点类型照 TS AST（找 export 声明 → `getTypeAtLocation`）。若 `isTypeAssignableTo(structuralUow, uowType)` 因 TS 结构判定细节返 false，实现者改用 `checker.getPropertiesOfType(uowType).every(p => getPropertyOfType(candidate, p.name))` 的成员覆盖判定——核心不变量：**只持 UoW 4 方法的类型必须判 DB 能力**。

- [ ] **Step 4: 运行确认通过** — 3 测试（canonical 解析 / 类型判定含结构兼容+negative / fail-closed 抛）

- [ ] **Step 4b: 写 `scripts/db-sink-scanner.d.mts`**（`export function buildProgram(p?: string): { program: import('typescript').Program; checker: import('typescript').TypeChecker; uowType: import('typescript').Type }; export function isDbCapabilityType(...): boolean;` + `Edge` 类型——Task 2 补 enumerate/collect/scanProduction 签名）。确认 `npm run typecheck` 对 test import scanner 无「无声明模块」错。

- [ ] **Step 5: Commit** — `git add scripts/db-sink-scanner.mjs scripts/db-sink-scanner.d.mts src/test/support/db-sink-fixtures/ src/test/unit/db-sink-scanner.test.ts && git commit -m "feat(shard): DB-capability 类型判定内核（canonical=SyncWriteUnitOfWork fail-closed + 结构兼容/union/generic + Program 健康门)"`（结尾 Co-Authored-By）

---

## Task 2: edge 级枚举 — 全注入形态 + edge 级 ID（禁 owner 合并）

**Files:**
- Modify: `scripts/db-sink-scanner.mjs`（`enumerateDbCapabilityEdges`——参/属性/deps-prop/route-param/capture/factory-indirect/对象包装 + edge 级 id + 未知边界 fail-closed）
- Create: fixture `{ctor-param,deps-prop,route-param,capture,factory-indirect,wrapped,export-transfer,pair,sink-decl,function-like}.ts`（wrapped=options.db/return{db}/{...deps}；export-transfer=export default db + export{db2}；pair=双 IDatabase 属性证 active-stack visited；sink-decl=无 initializer 的 ctor 参属性+字段）
- Test: `src/test/unit/db-sink-scanner.test.ts`（全 FIXTURE_EXPECT 逐文件逐 edge deepEqual pin + owner 合并回归 + active-stack 双 path）

**Interfaces:**
- Produces: `enumerateDbCapabilityEdges(program, checker, uowType, { includeTests }) → Edge[]`；`Edge = { id, file, owner, kind, target, param }`，`id = <file>#<owner>::<kind>::<target>::<param>`。

**关键（Codex 退回逐条）**：
- **edge 级 ID（#1）**：同一 owner 内 `new RuntimeRecoveryWorker(db)` / `new NudgePushBridge({db})` / `registerXxxRoutes(app, db)` 是 3 条不同 edge（不同 target/param），id 各异，**禁 byId owner 合并**。回归测试：同函数加第二个 sink → unregistered 非空。
- **capture（#4）**：不只 Identifier——对 `PropertyAccessExpression`（`this.db`/`this.deps.db`/`opts.db`）、`ElementAccessExpression`、`BindingElement`（解构）、`ShorthandPropertyAssignment`、`AsExpression`/括号 整体调 `getTypeAtLocation` 判 DB 能力；capture 须验引用声明在**当前函数作用域外**（否则是本地 param 非捕获）。
- **factory-indirect / wrapped capability（#5 + Codex 第 3 轮 #2——需正式「含 DB 能力」谓词）**：`new Service({db})` / `new Service(options)`（options.db 是 UoW，整体 options 类型**不**可赋 UoW）/ `return {db}` / `{ ...deps }` / `[db]` / `arr.push(db)`。整体表达式类型不可赋 UoW，故 `isDbCapabilityType` 不够——加正式谓词 **`findDbCapabilityPaths(type, checker, uowType): CapabilityPath[]`**：递归查类型的属性/union·intersection 分量/tuple·array element/对象 spread 结果，记完整 property path（如 `options.db`、`deps.nested.db`）。
- **visited 语义 = 当前递归栈 active-set（仅防真环），退出分支时移除**（Codex 第 4 轮 #4——**不是全局 visited**：全局会漏 `{ primary: IDatabase; replica: IDatabase }` 的第二条 path，因 IDatabase 首次访问后被全局标记）。或等价用 memoize `type→相对 capability 后缀 paths`（不同父路径下重新加前缀）。
- **深度/节点预算超限 → 产 `unknown-boundary` edge（带 boundary/file/property-path context）**，非返「无能力」/无上下文布尔。
- 递归遇 checker 异常 → 带 context 重抛（fail-closed，不吞成空）。
- **inferred（#6）**：`private readonly db = os.getDatabase()`（无 `node.type`）——对 declaration/name/initializer 调 `getTypeAtLocation`，**不要求 `node.type` 存在**。
- **fail-closed boundary taxonomy——两大组：capability 接收/存储 + capability 转移，每类绑 `SyntaxKind`（Codex 多轮：#2 定分母 / 第 3 轮 export·spread / 第 4 轮**接收边界+named export+visited**）**。枚举器遍历有限 boundary 全集，每 boundary 用 `findDbCapabilityPaths` 判携带 DB 能力：
  
  **A. capability 接收/存储边界（sink declaration——最典型 sink，无 initializer 也算）**：
  - A1 **所有 function-like 参数** — 用 **`ts.isFunctionLike(node)`**（非手列，避免漏 `FunctionExpression`/`SetAccessorDeclaration`/`GetAccessor`）：覆盖 `ConstructorDeclaration`/`MethodDeclaration`/`FunctionDeclaration`/`FunctionExpression`/`ArrowFunction`/`SetAccessorDeclaration`。类型声明层的 callback 契约补 `MethodSignature`/`CallSignatureDeclaration`/`ConstructSignatureDeclaration`/`FunctionTypeNode` 的参数。
  - A2 **parameter property** — `constructor(private readonly db: IDatabase)`（Parameter 带 accessibility/readonly 修饰符）
  - A3 **class 字段** — `PropertyDeclaration`（有无 initializer 都算）
  - A4 **interface/type 属性** — `PropertySignature`（deps 类型的 db 属性）
  
  **边界重叠 specificity precedence（Codex 第 5 轮 #2——否则 edge 基线随遍历顺序不定）**：一个语法位置命中多类时取**最具体**的一个 kind，不重复产 edge：
  - parameter property（A2）**只归 A2**，不再归 A1（A2 是 A1 严格子集）。
  - 参数带 default initializer（如 `constructor(db = hostDb)`）：sink 声明归 A1/A2；**B1 initializer 只在该 initializer 本身是独立需处置的 transfer（如 default 值是 `os.getDatabase()`）时另产**，且 fixture 精确断言。
  - class field 带 initializer：声明归 A3；initializer 的 transfer 若独立需处置另产 B1，否则不重复。
  - 规则：**sink declaration 采用最具体 kind；transfer（B1）只在独立处置时另产**——inventory 基线稳定、可 deepEqual。
  
  **B. capability 转移边界**：
  - B1 **declaration/param/binding initializer** — `VariableDeclaration.initializer`、`Parameter.initializer`、`BindingElement.initializer`
  - B2 **call/ctor argument** — `CallExpression.arguments`、`NewExpression.arguments`
  - B3 **assignment** — `BinaryExpression` operator ∈ {`=`, `||=`, `&&=`, `??=`}（含 `this.db = ...`）
  - B4 **aggregate wrapping** — `ObjectLiteralExpression`（`PropertyAssignment`/`ShorthandPropertyAssignment`/`SpreadAssignment`）、`ArrayLiteralExpression`（`SpreadElement`/element）
  - B5 **return/yield** — `ReturnStatement`、`YieldExpression`
  - B6 **collection/container write** — `arr.push(db)`/`map.set(k, db)`（CallExpression method 名匹配 + 实参携带能力）
  - B7 **closure/timer/event/worker capture** — 函数体内引用作用域外 DB 绑定（`Identifier`/`PropertyAccessExpression` resolve 到外层声明）
  - B8 **module/export transfer** — `ExportAssignment`（`export default db`/`export = db`）+ `ExportDeclaration`/`NamedExports`/`ExportSpecifier`（`export { db }`/`export { db as default }`）
  
  遍历每个 boundary，**三态**（Codex 第 5 轮——不携带能力的普通参数不产 unknown）：① `findDbCapabilityPaths` 空（无能力路径）→ **跳过**；② 有能力路径且可归某 kind → **known edge**；③ 有能力路径但无法归任何 kind / 预算超限 → **`unknown-boundary` edge**。`unknown-boundary` 非空 → 门红。**分母 = A1-A4 + B1-B8 各自 SyntaxKind 集**（有限可遍历）。**Plan 0 实现时发现任何 production 同步 capability-transfer/acceptance 语法不在此表 → 必须补进 taxonomy（非留后续）**；spec §10「后续」只指跨函数污点推断，不含同步边界。

- [ ] **Step 1: 写全部 fixture（A1-A4 接收 + B1-B8 转移各形态最小样本）+ 表驱动 deepEqual pin 测试**

```typescript
// 表驱动逐文件 deepEqual 完整期望集（Codex #3——非 some(kind)，防占位 target/param + 漏 edge）。
// 每个 fixture 的期望 edge 全集（owner/kind/target/param/id）由实现者按 fixture 内容固定填全。
const FIXTURE_EXPECT = {
  'ctor-param.ts':       [{ owner: 'CtorParamFixture', kind: 'ctor-param', target: 'CtorParamFixture', param: 'db' }],
  'deps-prop.ts':        [{ owner: 'FixtureDeps', kind: 'deps-prop', target: 'FixtureDeps', param: 'db' }],
  'route-param.ts':      [{ owner: 'registerFixtureRoutes', kind: 'route-param', target: 'registerFixtureRoutes', param: 'db' }],
  'capture.ts':          [{ owner: 'makeTimer', kind: 'capture', target: 'makeTimer', param: 'db' }],
  'factory-indirect.ts': [ // ≥2 不同 target 证 edge 级不合并
    { owner: 'FactoryFixture', kind: 'factory-indirect', target: 'ServiceA', param: 'db' },
    { owner: 'FactoryFixture', kind: 'factory-indirect', target: 'ServiceB', param: 'db' },
  ],
  // wrapped capability（Codex 第3轮 #2）：整体类型不可赋 UoW，靠 findDbCapabilityPaths 递归识别
  'wrapped.ts': [
    { owner: 'wrapOptions', kind: 'factory-indirect', target: 'Service', param: 'options.db' },   // new Service(options)，options.db 是 UoW
    { owner: 'wrapReturn', kind: 'return', target: 'return', param: 'db' },                        // return { db }
    { owner: 'wrapSpread', kind: 'aggregate-wrapping', target: 'object', param: '...deps' },       // { ...deps }（deps 含 db）
  ],
  // module/export transfer（第 9 类；含 ExportAssignment + NamedExports）
  'export-transfer.ts': [
    { owner: '<module>', kind: 'module-export', target: 'default', param: 'db' },                  // export default db
    { owner: '<module>', kind: 'module-export', target: 'named', param: 'db2' },                   // export { db2 }
  ],
  // 双能力属性（Codex 第4轮 #4）：pin active-stack visited——两条 path 都要出，全局 visited 会漏第二条
  'pair.ts': [
    { owner: 'Pair', kind: 'deps-prop', target: 'Pair', param: 'primary' },
    { owner: 'Pair', kind: 'deps-prop', target: 'Pair', param: 'replica' },
  ],
  // 无 initializer 的 sink declaration（Codex 第4轮 #2）：ctor 参数属性 + 无初始化字段
  'sink-decl.ts': [
    { owner: 'SinkService', kind: 'ctor-param', target: 'SinkService', param: 'db' },              // constructor(private readonly db: IDatabase)
    { owner: 'SinkStore', kind: 'field-decl', target: 'SinkStore', param: 'db' },                  // private db: IDatabase（无 initializer）
  ],
  // FunctionExpression + setter（Codex 第6轮建议：显式 pin 防实现者手列节点漏掉，验 ts.isFunctionLike 真覆盖）
  'function-like.ts': [
    { owner: 'fnExpr', kind: 'fn-param', target: 'fnExpr', param: 'db' },                          // const fnExpr = function(db: IDatabase){}
    { owner: 'DbHolder.database', kind: 'fn-param', target: 'set database', param: 'db' },         // set database(db: IDatabase)
  ],
};
for (const [file, expected] of Object.entries(FIXTURE_EXPECT)) {
  test(`fixture ${file}：产出的 edge 全集精确匹配（deepEqual，非 some）`, () => {
    const { program, checker, uowType } = buildProgram('tsconfig.src.json');
    const got = enumerateDbCapabilityEdges(program, checker, uowType, { includeTests: true })
      .filter((e) => e.file.includes(`db-sink-fixtures/${file}`))
      .map((e) => ({ owner: e.owner, kind: e.kind, target: e.target, param: e.param }))
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    assert.deepEqual(got, [...expected].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
  });
}
test('单-ID-删除 mutation：从完整 inventory 删一个指定 id → unregistered 恰为该 edge，其余仍登记', () => {
  const { program, checker, uowType } = buildProgram('tsconfig.src.json');
  const edges = enumerateDbCapabilityEdges(program, checker, uowType, { includeTests: true })
    .filter((e) => e.file.includes('db-sink-fixtures'));
  const allIds = new Set(edges.map((e) => e.id));
  const victim = edges.find((e) => e.file.includes('deps-prop')).id;
  allIds.delete(victim);                                    // 只删一个
  const unreg = collectUnregisteredEdges(edges, allIds);
  assert.deepEqual(unreg.map((e) => e.id), [victim]);       // 恰好只有被删那条未登记
});
```
> fixture 样本（实现者建全 FIXTURE_EXPECT 列出的全部；关键：`factory-indirect.ts` 放 `new ServiceA(db)` + `new ServiceB(db)` 两不同 target 证 edge 级不合并；`capture.ts` 用 `this.db`/闭包证 property-access capture）。`FIXTURE_EXPECT` 的 id 段实现者补全（含完整 `<file>#<owner>::<kind>::<target>::<param>`），deepEqual 精确到 owner/kind/target/param。

- [ ] **Step 2: 运行确认失败**（enumerate 未实现）

- [ ] **Step 3: 写 `enumerateDbCapabilityEdges`（遍历 A1-A4 + B1-B8 boundary taxonomy + `findDbCapabilityPaths` + edge 级 id + 未知边界 fail-closed）**

遍历上「关键」的**接收边界 A1-A4（ctor/method 参数、parameter property、PropertyDeclaration、PropertySignature——无 initializer 也算）** + **转移边界 B1-B8（decl init / call·ctor arg / assignment 含 `||=`&`&&=`&`??=` / aggregate wrapping 含 spread / return·yield / collection write / capture / module·export 含 `ExportDeclaration`）**。每个 boundary 取其类型 `getTypeAtLocation`（不要求 node.type），用 **`findDbCapabilityPaths`**（非仅 `isDbCapabilityType`——要抓 `options.db` 这种包裹）**三态**判：① 空（无能力路径）→ 跳过；② 有能力可归 kind → known edge；③ 有能力不可分类/预算超限 → `unknown-boundary` edge（门红）。new/call 用 `getResolvedSignature` 取目标参类型跑 findDbCapabilityPaths；capture 验引用声明在函数作用域外。id = `${rel}#${owner}::${kind}::${target}::${param}`（param 可含 property path 如 `options.db`）。`{includeTests}` 控是否排 `src/test/`。**不做 byId owner 合并**，只去重完全相同 id。**任何 checker/API 异常带 context 重抛（fail-closed），绝不吞成「非 DB」。**

- [ ] **Step 4: 运行确认通过**（全 FIXTURE_EXPECT 逐文件 deepEqual pin + edge 级 + 合并回归 + active-stack 双 path 全绿）

- [ ] **Step 5: Commit** — `feat(shard): edge 级枚举全注入形态（property-access/对象包装/inferred/capture + 未知边界 fail-closed）`

---

## Task 2.5: 修扫描器过度触发 + edge 归因分类（Codex 第 7 轮裁决，Task 1-3 已实现后新增）

> Task 1/2 产 7701 edge（含 1269 unknown-boundary 误报 + 1356 return + 1352 route-param 噪音）。根因：`findDbCapabilityPaths` 递归所有属性（含方法/原型面/库类型）→ 对 AppConfig/app 等大类型预算爆 + 把 DTO/service 方法面误判含 UoW。本 task 修过度触发 + 加 edge 归因，使门可维护。

**Files:**
- Modify: `scripts/db-sink-scanner.mjs`（`findDbCapabilityPaths` 只递归数据属性 + edge `classifyPropagation`）
- Modify: `scripts/db-sink-scanner.d.mts`
- Test: `src/test/unit/db-sink-scanner.test.ts`

**关键（Codex 第 7 轮）**：
- **findDbCapabilityPaths 收窄（消 unknown/return 噪音，但不牺牲完整性）**：只递归**数据属性**——跳方法签名/原型方法/函数对象表面；primitive/标准库容器原型不展开；array/tuple 直接取 element type 不遍历 map/filter 方法；类型图 memoize（同类型不重复展开）+ cycle guard（兄弟重复路径仍展开=active-stack）。记预算超限时 root type + 最深 path + 声明来源。**收窄后 unknown 应降到 ~0；仍超预算→门红（不改成「未发现 DB」，不按 AppConfig/Options 名字白名单——按「可证明的声明类别/来源」剪枝）**。
- **route-param kind 收窄**：当前把所有 FunctionDeclaration 的 DB 参叫 route-param（过宽）→ 改为一般 `fn-param`；仅经 route registration 识别的函数标 `route-param`。
- **edge 归因 `classifyPropagation(edge, checker) → 'linked-to-sink'|'ephemeral'|'terminal-escape'|'unknown'`**（Codex 第 7 轮二）：
  - `linked-to-sink`：能机械定位终点=已扫描 A 点（`new Service(db)`→`Service.ctor(db)`；`h.db=db`→`Holder.db`；`{db}`传已解析参→对应 deps A 点）——记 `edge.sinkId=<终点 semantic sink id>`。
  - `ephemeral`：机械证明不逃逸（仅同步传给明确 per-request 函数、不 return/不存字段/不注册 callback/不写容器）。
  - `terminal-escape`：无法映射 A 点且能力可能跨调用/作用域/生命周期存活（module export / timer·closure·worker capture / 动态 assignment / container write / 逃逸未知调用方的 return / 传外部·any·动态边界 call）——必须升级为 semantic sink 登记。
  - `unknown`：解析失败/预算超限/callee 不明且未升级 escape → 门红。

- [ ] **Step 1: 写失败测试**：① unknown-boundary 收窄后 production `unknown` 数 === 0（`scanProductionDbCapabilityEdges().filter(e=>e.disposition==='unknown').length===0`）；② DTO/service 方法面 fixture（`return rows`/返回含方法的对象）不产 edge；③ classifyPropagation：`new Service(db)` fixture → linked-to-sink 且 sinkId 指向 Service ctor；`export default db` → terminal-escape；纯同步 use → ephemeral。
- [ ] **Step 2: 运行确认失败**（当前 unknown=1269≠0；classifyPropagation 未定义）
- [ ] **Step 3: 修 findDbCapabilityPaths（数据属性 only + memoize）+ 加 classifyPropagation + route-param 收窄**
- [ ] **Step 4: 运行确认通过**（unknown=0 + 归因三态 + 方法面不误报）
- [ ] **变异自证**：临时恢复递归方法面 → unknown 数暴涨测试红；临时把 terminal-escape（export default db）误判 ephemeral → escape 测试红。还原复绿。
- [ ] **Step 5: Commit** — `fix(shard): 扫描器收窄数据属性递归(消 unknown 误报)+edge 归因分类(linked/ephemeral/escape/unknown)`

---

## Task 2.6: capability-carrier 压缩 + resolved provenance（Codex 第 8 轮裁决）

> Task 2.5 后仍 11067 edge，实测 **8976 条（81%）是 OS-facade 传递展开**（`tenantOS.core.values.tx`…）：`findDbCapabilityPaths` 对类型为 `ChronoSynthOS`/`TenantOS`/`CoreRhythmLayer`/store 类的参数递归展开内部每个 `.tx`。**Codex 裁决：压缩成一条 carrier sink 对，但不能按类型名当「安全 opaque」**——这些 facade 可被 `new ChronoSynthOS({db:hostDb})` 直接构造、store 可被 `new RetrievalService(new CognitiveMemoryGraph(hostDb))` 单独拎出，按类型放行会漏真错-shard。

**Files:** Modify `scripts/db-sink-scanner.mjs` + `.d.mts`；Test `src/test/unit/db-sink-scanner.test.ts`；Create `db-sink-fixtures/carrier-{safe,unsafe}.ts`

**关键（Codex 第 8 轮）**：
- **carrier 识别（结构可证明，非名字/目录）**：类型满足 ① 有稳定命名声明 ② 本身不可赋 UoW ③ 其 field/ctor 参/property 最终含已枚举的 capability sink（内部 UoW）——则是 `capability-carrier`。一个 carrier 参数/字段 → **一条 `carrier-param`/`carrier-field` semantic sink**（param=carrier 标识符如 `tenantOS`），内部 `.tx` paths 存 `edge.capabilityPaths` 作证据元数据，**不逐 path 产人工 edge**。
- **内部 store 直接 sink 仍保留**：`CognitiveMemoryGraph.ctor::tx`/`NarrativeStore.ctor::tx`/`CoreRhythmLayer.ctor::db`/`ChronoSynthOS config::db` 仍是独立 semantic sink（它们决定 carrier 怎么拿到 db，不可隐藏）。
- **provenance 验证（carrier 传播 edge 的关键，不能只看类型放行）**：carrier 被传给函数/存字段时，`classifyPropagation` 追其**来源**：
  - 来源 = `TenantOSFactory.getTenantOS(tid)` / `os.getCore(pid)`（resolver 入口，producer-manifest 登记）→ `linked-to-resolved-carrier`（安全）。
  - 来源 = `new ChronoSynthOS(...)` / `new CognitiveMemoryGraph(hostDb)` / `deps.os` / 未知函数返回 → `unresolved-carrier`（**门红**，不自动放行）。
  - **producer-manifest**（Plan 0 不改生产类型故不用 nominal brand，用 manifest + 有限 provenance 跟踪）：登记 `{producer:'TenantOSFactory.getTenantOS', produces:'tenant-resolved-os'}` + `{producer:'ChronoSynthOS.getCore', produces:'tenant-persona-core'}`；scanner 跟踪 `getTenantOS(tid)→alias→.core→getCore(pid)→下游实参` 有限链，无法证明来源 → unresolved（红）。
- **fixture 正反**：`carrier-safe.ts`（`factory.getTenantOS(tid)` 传下游 → linked-to-resolved-carrier）+ `carrier-unsafe.ts`（`new ChronoSynthOS()` / `new CognitiveMemoryGraph(hostDb)` 传下游 → unresolved-carrier 红）。

- [ ] **Step 1: 写失败测试**：① production carrier-param edge 数 << 8976（facade `.tx` 展开压成 carrier sink，内部 paths 进 capabilityPaths 元数据）；② carrier-safe fixture → linked-to-resolved-carrier；③ carrier-unsafe（new 直构）→ unresolved-carrier（门应视为红/未归因）；④ 内部 store ctor（CognitiveMemoryGraph.ctor::tx）仍在 edge 集。
- [ ] **Step 2: 运行确认失败**
- [ ] **Step 3: 实现 carrier 压缩 + producer-manifest provenance + classifyPropagation 扩 linked-to-resolved-carrier/unresolved-carrier**
- [ ] **Step 4: 运行确认通过**（edge 总数大降 + carrier 归因 + 内部 store sink 保留）
- [ ] **变异自证**：① 关掉 carrier 压缩 → edge 数暴涨回 ~11067；② 把 unsafe（new 直构）误判 resolved → carrier-unsafe 测试红（证 provenance 真验来源非按类型放行）。还原复绿。
- [ ] **Step 5: Commit** — `fix(shard): capability-carrier 压缩(facade→一条 sink)+resolved provenance(来源须 factory/getCore 非 new 直构)`

---

## Task 3: 升级 inventory 到 semantic sink 级（Codex 第 7 轮粒度——非全 edge）

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

## Task 4: production 主门（semantic sink 归因门）+ 接 check:db-access

**Files:**
- Modify: `scripts/db-sink-scanner.mjs`（`scanProductionDbCapabilityEdges` + `evaluateGate(edges, inventoryIds)`）
- Modify: `scripts/check-db-access-ratchet.mjs`（调 evaluateGate）
- Test: `src/test/unit/db-sink-scanner.test.ts`

**门契约（Codex 第 7+8 轮——含 carrier provenance）**：`evaluateGate` pass iff 五者全成立：
1. **semantic sink 完整**：所有 A 接收点（直接 DB/UoW + carrier-param/field）+ 内部 store 直接 sink + terminal-escape 都有精确 inventory id + disposition + wiringStatus（`unregisteredSemanticSinks === []`）。
2. **传播可归因**：每条非 terminal B edge ∈ {linked-to-sink, linked-to-resolved-carrier, ephemeral}（`unlinkedPropagationEdges === []`）。
3. **无 unknown**：`unknownEdges === []`。
4. **terminal-escape 有处置**：`terminalEscapesWithoutDisposition === []`。
5. **carrier 来源已解析**：每个 carrier 传播来源 = 登记的 resolver/factory producer（getTenantOS/getCore），`unresolvedCarrierSources === []`（`new ChronoSynthOS()`/`new CognitiveMemoryGraph(hostDb)`/未知来源 → 红）。
形式：`gate passes iff unknownEdges===[] && unregisteredSemanticSinks===[] && unlinkedPropagationEdges===[] && terminalEscapesWithoutDisposition===[] && unresolvedCarrierSources===[]`。**保留原 file 级 DB ratchet**（覆盖直接 query/execute/transaction 使用面）。carrier 内部 `.tx` paths 存证据不逐条登记；直接构造 carrier/store 的 db 来源仍走正常 sink 检查（不被 carrier 压缩吞掉）。

- [ ] **Step 1: 写门测试**：`evaluateGate(scanProductionDbCapabilityEdges(), readInventoryIds())` 返回四类空集诊断结构；各类非空时含具体 id/file/kind 诊断。Program 健康门测（sentinel 缺→抛）。
- [ ] **Step 2: 运行——预期先红，暴露真实 semantic sink + terminal-escape**：把 A 点 + terminal-escape 登进 inventory（Task 3 续补，wiringStatus:planned）；B 传播 edge 确认 linked-to-sink/ephemeral（linked 的 sinkId 指向已登记 A 点）→ 至绿。**红时补 inventory / 修 classifyPropagation 归因（若某 B edge 应 linked 却判 unknown 是归因 bug），绝不加白名单绕过。** unknown 若因扫描器漏归因→回 Task 2.5 修，非登记成 known-limitation。
- [ ] **Step 3: 改 `check-db-access-ratchet.mjs` 调 evaluateGate**（四类任一非空 → 列诊断退出 1；保留 file 级补充网）
- [ ] **Step 4: `npm run check:db-access` + 全 scanner/inventory 测试绿**
- [ ] **Step 5: Commit** — `feat(shard): check:db-access 升级 semantic sink 归因门（sink 未登记/edge 未归因/unknown 非空→红）`

---

## 收尾（全 task 完成后）

- [ ] **本地全量门**：`npm run test:golden`（EXIT 0；本 Plan 不改运行逻辑故 unit/integration/parity 零回归；`check:db-access` 现为 edge 门——红则补 inventory 非放宽）。
- [ ] **最终整片 code review**（最强模型审：重点核**扫描器是否真类型驱动而非退化名字匹配、canonical type 是否真从 .d.ts 解析成功且解析失败真 fail-closed、A1-A4+B1-B8 各形态是否真逐一被生产代码或 fixture 覆盖、edge 级 ID 是否真防 owner 合并、有无扫描器漏扫某形态导致的假完整**——这是隔离门的门，假完整=灾难）。

## Self-Review（writing-plans 自检）

**Spec 覆盖**：§3-A0（类型驱动 TypeChecker + A1-A4 接收+B1-B8 转移形态 + 变异 fixture + 每 edge 稳定 ID + fail-closed）→ Task 1（类型判定内核 + canonical fail-closed + Program 健康）+ Task 2（edge 级全形态枚举）+ Task 3（inventory sink 级）+ Task 4（production 门）。已知 sink #1-7 → Task 3 完整性测试。

**采纳 Codex Plan 复审 10 项**：①edge 级 ID（Task 2 id 格式+合并回归）②三层 API 分离（enumerate/collect/scanProduction）③全形态逐文件 deepEqual 表驱动 pin ④canonical type 从 .d.ts + 解析失败 fail-closed（Task 1）⑤property-access/对象包装/inferred/union/generic（Task 1/2）⑥未知边界 fail-closed ⑦Program sentinel/diagnostic 健康门 ⑧scope 诚实「Node server src」非全仓 ⑨`.mjs` 读 inventory 用 readFileSync 正则非 import ⑩disposition 必填 + wiringStatus 分离。

**假完整防线（最关键）**：扫描器漏扫是最致命的假绿——防线 = ①fail-closed（canonical/sentinel/未知边界任一异常即红，不空扫）②全形态 fixture 证识别能力（含无-initializer sink decl / 双能力 path / 包裹 / export）③终审专项核「有无漏扫形态」④wiringStatus 使「planned≠verified」，放开门（Plan 3）要 verified。诚实承认：fixture 只证「已知形态能识别」，证不了「无 taxonomy 外未知形态」——故未知边界三态 fail-closed 是兜底（有能力路径但不落任何 kind/预算超限 → unknown-boundary 红，逼人显式处理）。

**类型一致性**：`Edge`（id/file/owner/kind/target/param）跨 Task 2/4 一致；`buildProgram`/`enumerateDbCapabilityEdges`/`collectUnregisteredEdges`/`scanProductionDbCapabilityEdges` 三层签名一致；`disposition`/`wiringStatus` union 与 spec 处置状态一致。
