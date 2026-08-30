#!/usr/bin/env node
/**
 * `tx as SyncWriteUnitOfWork` 重新放宽的安全守卫（审计 #440-4f）。
 *
 * ## 背景：这个 cast 不是逃逸口，但它撤掉的保护必须由别处补上
 *
 * `TransactionContext = Pick<SyncWriteUnitOfWork, 'queryOne'|'queryMany'|'execute'>`
 * （`src/persona-core/persona-core-source.ts`）—— 运行时对象**本来就是完整的
 * UoW**，收窄只是在**类型层**禁止深层代码自开嵌套事务（D1/D2 tx 捕获点设计）。
 *
 * `as SyncWriteUnitOfWork` 把它放宽回去，是为了传给确实需要写方法的 helper。
 * 这一步本身合理，但它同时**撤掉了「禁止嵌套事务」这道编译期保护** ——
 * 而本仓的 SQLite 驱动不支持嵌套事务：审计 #440-1 实测一旦嵌套，直接抛
 * `cannot start a transaction within a transaction`（当时 8 条用例红了 6 条）。
 *
 * ## 本门守的不变量
 *
 * 被 cast 传入的每个 helper，其**事务内可达路径**上不得出现 `.transaction(`。
 *
 * 这条比原审计记录里的「唯一入口今天是只读」准确得多 —— 后者事实上是错的
 * （实际 8 处 cast、多数是写路径），且「今天恰好只读」这种描述会过期。
 *
 * ## 已知且允许的例外
 *
 * `PersonaCognitiveMemoryGraph.buildState` → `refreshAndLoadWorkingMemory`
 * 确实调 `this.tx.transaction(...)`，但它在**只读顶层**路径上（
 * `getPersonaGraphSummary` / `queryPersonaGraph`，非 facade 事务内）；
 * 事务内路径只走 `projectMemory`，后者不自开事务。
 *
 * 故本门采用**棘轮**形态：冻结当前已知安全的例外，**新增的一律拒绝**。
 * 想加新例外就必须在这里写清楚它为什么安全 —— 这正是 review 时该被追问的。
 *
 * 纯 Node ESM，零依赖。
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** 扫描范围：src/ 全部（豁免测试——夹具里出现 cast 不构成生产风险）。 */
const SCAN_DIR = 'src';
const EXEMPT_PREFIXES = ['src/test'];

/** 放宽 cast 的信号。 */
const WIDENING = /as\s+SyncWriteUnitOfWork/;

/**
 * 被 cast 传入的 helper（构造器或函数名）→ 其实现所在文件。
 *
 * ⚠️ 新增 cast 目标时必须在这里登记，否则本门会拒 —— 这是有意的：
 * 登记的动作强制你去确认「这个 helper 的事务内路径会不会自开事务」。
 */
const KNOWN_TARGETS = new Map([
  ['PersonaCognitiveMemoryGraph', 'src/persona-core/persona-cognitive-memory.ts'],
  ['recordBusinessAuditLog', 'src/audit/audit-log-store.ts'],
  ['publishObservabilityEvent', 'src/observability/observability-outbox.ts'],
]);

/**
 * 已知安全的嵌套事务例外：`文件 → 冻结处数`。
 *
 * ⚠️ 只减不增。新增一处就必须在此登记并说明为什么它不在事务内路径上。
 */
const NESTED_TX_BASELINE = new Map([
  /* buildState → refreshAndLoadWorkingMemory：只读顶层路径专用；
   * 事务内路径只走 projectMemory（不自开事务）。见该文件 getCognitive 的注释。 */
  ['src/persona-core/persona-cognitive-memory.ts', 1],
]);

function walk(dir, out = []) {
  let entries;
  try { entries = readdirSync(dir); } catch { return out; }
  for (const name of entries) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (name.endsWith('.ts') && !name.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

const rel = (f) => relative(ROOT, f).split(sep).join('/');
const isExempt = (r) => EXEMPT_PREFIXES.some((p) => r === p || r.startsWith(p + '/'));

/* ── 1. 收集全部放宽点，解析它传给了哪个 helper ── */
const castSites = [];
for (const file of walk(join(ROOT, SCAN_DIR))) {
  const r = rel(file);
  if (isExempt(r)) continue;
  const src = readFileSync(file, 'utf8');
  if (!WIDENING.test(src)) continue;
  const lines = src.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!WIDENING.test(line)) continue;
    /* `new Foo(tx as ...` / `foo(tx as ...` —— 取紧邻左侧的标识符。 */
    const m = line.match(/(?:new\s+)?([A-Za-z_$][\w$]*)\s*\(\s*\w+\s+as\s+SyncWriteUnitOfWork/);
    castSites.push({ rel: r, line: i + 1, target: m ? m[1] : null, text: line.trim() });
  }
}

const unknown = castSites.filter((s) => s.target === null || !KNOWN_TARGETS.has(s.target));
if (unknown.length > 0) {
  console.error('✗ tx 放宽守卫：以下 `as SyncWriteUnitOfWork` 传给了**未登记**的目标\n');
  for (const s of unknown) {
    console.error(`  ${s.rel}:${s.line}  → ${s.target ?? '(解析不出目标)'}`);
    console.error(`      ${s.text}`);
  }
  console.error(
    '\n放宽 tx 会撤掉「禁止嵌套事务」这道编译期保护，而本仓 SQLite 不支持嵌套事务\n' +
    '（审计 #440-1 实测：抛 cannot start a transaction within a transaction）。\n' +
    '请先确认该 helper 的**事务内可达路径**上没有 `.transaction(`，\n' +
    '再把它登记进 scripts/check-tx-widening-safety.mjs 的 KNOWN_TARGETS。\n',
  );
  process.exit(1);
}

/* ── 2. **被实际 cast 到的** helper，其实现里嵌套事务处数不得超过冻结基线 ──
 *
 * ⚠️ 只校验实际用到的目标：登记表是白名单，允许列着当前没人 cast 的条目
 * （比如某处 cast 刚被移除）。若无条件校验全表，一个「登记了但没人用」的
 * 条目会让门在**无任何 cast** 的干净树上也报错 —— 自测第一条就是这么红的。 */
const usedTargets = new Set(castSites.map((s) => s.target));
const violations = [];
for (const [target, implPath] of KNOWN_TARGETS) {
  if (!usedTargets.has(target)) continue;
  let src;
  try {
    src = readFileSync(join(ROOT, implPath), 'utf8');
  } catch {
    violations.push({ implPath, kind: 'missing', target });
    continue;
  }
  const count = (src.match(/\.transaction\s*\(/g) ?? []).length;
  const frozen = NESTED_TX_BASELINE.get(implPath) ?? 0;
  if (count > frozen) violations.push({ implPath, kind: 'increased', target, count, frozen });
}

if (violations.length > 0) {
  console.error('✗ tx 放宽守卫：被 cast 传入的 helper 里新增了嵌套事务\n');
  for (const v of violations) {
    if (v.kind === 'missing') {
      console.error(`  ${v.implPath}  （${v.target} 的实现文件找不到——路径变了？请更新本门）`);
    } else {
      console.error(
        `  ${v.implPath}  （${v.target}：${v.count} 处 .transaction(，冻结基线 ${v.frozen} 处）`,
      );
    }
  }
  console.error(
    '\n这些 helper 会收到**已在事务中**的 tx。它们内部再开事务 → 运行时直接抛\n' +
    'cannot start a transaction within a transaction（审计 #440-1 实测）。\n' +
    '若新增的那处确实只在**只读顶层**路径上（如 buildState），请在\n' +
    'NESTED_TX_BASELINE 里登记并写明为什么它不在事务内路径上。\n',
  );
  process.exit(1);
}

/* 基线里有、实际已清零的：提示收紧，避免棘轮松弛。 */
const usedImpls = new Set(
  [...KNOWN_TARGETS.entries()].filter(([t]) => usedTargets.has(t)).map(([, p]) => p),
);
const stale = [...NESTED_TX_BASELINE.entries()].filter(([f, n]) => {
  if (!usedImpls.has(f)) return false;
  try {
    const c = (readFileSync(join(ROOT, f), 'utf8').match(/\.transaction\s*\(/g) ?? []).length;
    return c < n;
  } catch { return true; }
});
if (stale.length > 0) {
  console.error('✗ tx 放宽守卫：以下文件的嵌套事务已减少，请把基线收紧到实际值\n');
  for (const [f, n] of stale) console.error(`  ${f}  冻结 ${n} 处 → 实际更少`);
  process.exit(1);
}

console.log(
  `✓ tx 放宽守卫：${castSites.length} 处 as SyncWriteUnitOfWork，` +
  `目标均已登记（${KNOWN_TARGETS.size} 个 helper），无新增嵌套事务。`,
);
