#!/usr/bin/env node
/**
 * `lint-raw-palette` 的自测——用固定 fixture 验证它**该报的报、不该报的不报**。
 *
 * 为什么需要：这道门本身没有测试，而它的绕过方式（长块吞并、字符串里的假标记、
 * 单字符原因）都不会让任何既有检查变红——只会让门**静默失效**。
 * 交叉审查用手工 fixture 抓到过三条，固化为自测防止复现。
 */
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const SCRIPT = new URL('./lint-raw-palette.mjs', import.meta.url).pathname;
const LINT_SRC = readFileSync(SCRIPT, 'utf8');

/** 在临时目录里造一个 apps/web/src 结构，跑 lint，返回 {code, out}。 */
function runOn(files) {
  const root = mkdtempSync(join(tmpdir(), 'lint-selftest-'));
  const src = join(root, 'apps/web/src');
  mkdirSync(src, { recursive: true });
  for (const [name, body] of Object.entries(files)) writeFileSync(join(src, name), body);
  /* lint 用 `new URL('..', import.meta.url)` 推 ROOT，故复制脚本到临时根的
   * scripts/ 下，让它把临时目录当仓库根。 */
  mkdirSync(join(root, 'scripts'), { recursive: true });
  writeFileSync(join(root, 'scripts/lint.mjs'), LINT_SRC);
  let code = 0, out = '';
  try {
    out = execFileSync(process.execPath, [join(root, 'scripts/lint.mjs')], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    code = e.status ?? 1;
    out = `${e.stdout ?? ''}${e.stderr ?? ''}`;
  }
  rmSync(root, { recursive: true, force: true });
  return { code, out };
}
const CASES = [
  /* ⚠️ 审计 #418：JSX **裸文本**冒充豁免指令 —— 既不带引号也不是注释，
   * 能通过「引号奇偶」判据关掉**下一行**的门，同时作为可见文字渲染到页面上。
   *
   * ⚠️ 用例必须让假指令**恰好在违规行的上一行**（ignore-next-line 的语义），
   * 否则根本不会触发豁免路径、两版行为相同（我第一版就隔了一行，变异存活）。
   * 实测对照：缺陷版把这段 JSX 文本当成指令、转而抱怨「缺原因说明」，
   * **真正的违规完全不报**；修复版正确报出 text-gray-600。 */
  {
    name: '审计 #418：JSX 裸文本冒充豁免指令 → 必须仍报下一行违规',
    files: {
      'a.tsx': 'export const A = (<div>\n  <p>随便一段可见文字 // lint-raw-palette-ignore-next-line 这是假指令不该生效</p>\n  <span className="text-gray-600" />\n</div>);\n',
    },
    expect: 1,
  },
  /* 对照：合法的 JSX 注释形式必须仍能豁免 —— 否则把功能一起关掉
   * （实测误伤过 Sidebar.tsx 两处既有豁免）。 */
  {
    name: '审计 #418 对照：JSX 注释形式的豁免 → 仍放行',
    files: {
      'a.tsx': 'export const A = (<div>\n  {/* lint-raw-palette-ignore-next-line 装饰性叠加层，不承载文本 */}\n  <span style={{ color: "#ff0000" }} />\n</div>);\n',
    },
    expect: 0,
  },
  {
    name: '裸调色板类名 → 应报',
    files: { 'a.tsx': 'export const A = <div className="text-gray-600" />;\n' },
    expect: 1,
  },
  {
    name: '语义 token → 不报',
    files: { 'a.tsx': 'export const A = <div className="text-text-secondary" />;\n' },
    expect: 0,
  },
  {
    name: 'ignore-next-line 带原因 → 不报',
    files: {
      'a.tsx': '/* lint-raw-palette-ignore-next-line 图表系列色需固定色相 */\nexport const A = { c: "#ff0000" };\n',
    },
    expect: 0,
  },
  {
    name: 'ignore 原因过短（单字符）→ 应报',
    files: { 'a.tsx': '/* lint-raw-palette-ignore-next-line x */\nexport const A = { c: "#ff0000" };\n' },
    expect: 1,
  },
  {
    name: '字符串里的假标记不生效 → 应报下一行',
    files: {
      'a.tsx': 'const doc = "// lint-raw-palette-ignore-next-line 这是文档不是指令";\nexport const A = { c: "#ff0000" };\n',
    },
    expect: 1,
  },
  {
    name: 'ignore-block 超长（无空行）→ 应报，不得吞并无关声明',
    files: {
      'a.tsx':
        '/* lint-raw-palette-ignore-block 编码色表需固定色相区分类别 */\nconst P = {\n'
        + Array.from({ length: 20 }, (_, i) => `  k${i}: "#ff00${String(i).padStart(2, '0')}",`).join('\n')
        + '\n};\nexport const LEAK = { c: "#ff0000" };\n',
    },
    expect: 1,
  },
  {
    name: '注释里引用旧色值 → 不报',
    files: { 'a.tsx': '/* 迁移说明：原为 #64748B，已换语义 token。 */\nexport const A = 1;\n' },
    expect: 0,
  },
  {
    name: 'var(--token, #fallback) → 不报',
    files: { 'a.tsx': 'export const A = { c: "var(--color-primary, #3b82f6)" };\n' },
    expect: 0,
  },
];

let failed = 0;
for (const c of CASES) {
  const { code } = runOn(c.files);
  const ok = code === c.expect;
  if (!ok) failed += 1;
  console.log(`  ${ok ? '✓' : '✖'} ${c.name}（期望 exit=${c.expect}，实得 ${code}）`);
}

if (failed > 0) {
  console.error(`\nlint-raw-palette 自测：${failed}/${CASES.length} 条不通过。`);
  process.exit(1);
}
console.log(`✓ lint-raw-palette 自测：${CASES.length}/${CASES.length} 通过。`);
