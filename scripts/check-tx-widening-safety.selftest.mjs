#!/usr/bin/env node
/**
 * `check-tx-widening-safety` 的自测。
 *
 * 为什么必须有：本仓的门坏过多次，且**每次都是静默假绿** —— 门自己失效却照常
 * 打印 ✓ 并 exit 0，比没有门更危险（见 SQL 棘轮 #411/#428、mobile 对比度门）。
 *
 * 判据统一用**退出码**：门必须以 1 表示「发现违规」，**≥2 视为基础设施错误**
 * （脚本崩了/依赖缺失），不能当成「检出违规」—— 否则一个语法错误会被读成
 * 「门工作正常」。
 */
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const SCRIPT = new URL('./check-tx-widening-safety.mjs', import.meta.url).pathname;
const SRC = readFileSync(SCRIPT, 'utf8');

/**
 * 在临时根目录里跑一份门的副本。
 *
 * @param files    相对仓库根的文件表
 * @param targets  覆写 KNOWN_TARGETS（[名字, 实现路径]）
 * @param baseline 覆写 NESTED_TX_BASELINE（[路径, 处数]）
 */
function runOn(files, targets, baseline) {
  const root = mkdtempSync(join(tmpdir(), 'txwiden-selftest-'));
  try {
    for (const [rel, body] of Object.entries(files)) {
      const full = join(root, rel);
      mkdirSync(join(full, '..'), { recursive: true });
      writeFileSync(full, body);
    }
    mkdirSync(join(root, 'scripts'), { recursive: true });

    const tRows = targets.map(([n, p]) => `  ['${n}', '${p}'],`).join('\n');
    const bRows = baseline.map(([p, n]) => `  ['${p}', ${n}],`).join('\n');
    let patched = SRC
      .replace(/const KNOWN_TARGETS = new Map\(\[[\s\S]*?\n\]\);/, `const KNOWN_TARGETS = new Map([\n${tRows}\n]);`)
      .replace(/const NESTED_TX_BASELINE = new Map\(\[[\s\S]*?\n\]\);/, `const NESTED_TX_BASELINE = new Map([\n${bRows}\n]);`);
    if (patched === SRC) throw new Error('自测无法替换常量——门的结构变了，请更新本自测');
    writeFileSync(join(root, 'scripts/g.mjs'), patched);

    let code = 0;
    let out = '';
    try {
      out = execFileSync(process.execPath, [join(root, 'scripts/g.mjs')], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      code = e.status ?? -1;
      out = `${e.stdout ?? ''}${e.stderr ?? ''}`;
    }
    return { code, out };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const CAST = (target) => `import type { SyncWriteUnitOfWork } from '@chrono/kernel';
export function f(tx: unknown): void {
  ${target}(tx as SyncWriteUnitOfWork, {});
}
`;
const CAST_NEW = (target) => `import type { SyncWriteUnitOfWork } from '@chrono/kernel';
export function f(tx: unknown): unknown {
  return new ${target}(tx as SyncWriteUnitOfWork);
}
`;
const HELPER_CLEAN = `export function h(tx: { execute(c: unknown): void }): void { tx.execute({}); }\n`;
const HELPER_NESTED = `export function h(tx: { transaction(f: () => void): void }): void {
  tx.transaction(() => { /* 嵌套 */ });
}
`;

let failed = 0;
/** 期望检出违规：只接受 1；≥2 是门自己崩了，不算检出。 */
function expectBlock(name, { code, out }) {
  if (code === 1) return;
  failed++;
  console.error(code >= 2 || code < 0
    ? `✖ ${name}：门自身出错（RC=${code}），这不算「检出违规」\n${out}`
    : `✖ ${name}：预期检出违规（RC=1），实际 RC=${code}\n${out}`);
}
function expectPass(name, { code, out }) {
  if (code === 0) return;
  failed++;
  console.error(`✖ ${name}：预期通过（RC=0），实际 RC=${code}\n${out}`);
}

/* ── 基本行为 ── */
expectPass('无 cast 时通过',
  runOn({ 'src/a.ts': 'export const x = 1;\n' }, [['h', 'src/h.ts']], []));

expectPass('已登记目标 + helper 不自开事务 → 放行',
  runOn({ 'src/a.ts': CAST('h'), 'src/h.ts': HELPER_CLEAN }, [['h', 'src/h.ts']], []));

expectPass('`new Ctor(tx as …)` 形态也能识别',
  runOn({ 'src/a.ts': CAST_NEW('C'), 'src/c.ts': HELPER_CLEAN }, [['C', 'src/c.ts']], []));

/* ── 核心：未登记目标必须拒 ── */
expectBlock('★未登记的 cast 目标 → 拒绝★',
  runOn({ 'src/a.ts': CAST('mystery'), 'src/h.ts': HELPER_CLEAN }, [['h', 'src/h.ts']], []));

/* ── 核心：登记的 helper 新增嵌套事务必须拒 ── */
expectBlock('★已登记 helper 内新增 .transaction( → 拒绝★',
  runOn({ 'src/a.ts': CAST('h'), 'src/h.ts': HELPER_NESTED }, [['h', 'src/h.ts']], []));

expectPass('嵌套事务已登记进基线 → 放行（已知安全例外）',
  runOn({ 'src/a.ts': CAST('h'), 'src/h.ts': HELPER_NESTED }, [['h', 'src/h.ts']], [['src/h.ts', 1]]));

expectBlock('基线内文件**超出**冻结处数 → 拒绝',
  runOn({ 'src/a.ts': CAST('h'), 'src/h.ts': HELPER_NESTED + HELPER_NESTED }, [['h', 'src/h.ts']], [['src/h.ts', 1]]));

expectBlock('基线松弛（实际已清零仍留在基线）→ 提示收紧',
  runOn({ 'src/a.ts': CAST('h'), 'src/h.ts': HELPER_CLEAN }, [['h', 'src/h.ts']], [['src/h.ts', 1]]));

expectBlock('已登记 helper 的实现文件不存在 → 拒绝（路径漂移）',
  runOn({ 'src/a.ts': CAST('h') }, [['h', 'src/gone.ts']], []));

/* ── 范围：测试目录豁免，但豁免须按 / 边界 ── */
expectPass('src/test 下的 cast 豁免（夹具不构成生产风险）',
  runOn({ 'src/test/a.ts': CAST('mystery') }, [['h', 'src/h.ts']], []));

expectBlock('src/testing 不是 src/test（豁免须按 / 边界）',
  runOn({ 'src/testing/a.ts': CAST('mystery') }, [['h', 'src/h.ts']], []));

if (failed > 0) {
  console.error(`\n✖ tx 放宽守卫自测：${failed} 条失败——门本身不可信，先修门。`);
  process.exit(1);
}
console.log('✓ tx 放宽守卫自测：11 条全过。');
