#!/usr/bin/env node
/**
 * `lint-mobile-contrast` 的自测。
 *
 * 为什么必须有：这道门的两个严重缺陷（跨行样式漏报、暗色屏底色推错）
 * **都不会让任何检查变红**——门自己坏了，却依然打印「全部达标」并 exit 0，
 * 比没有门更危险。交叉审查用变异测试抓到后固化为自测。
 *
 * 关键用例是「跨行 + 单行**同时**注入等价劣化」：只测单行会重演那次假绿。
 */
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const SCRIPT = new URL('./lint-mobile-contrast.mjs', import.meta.url).pathname;
const SRC = readFileSync(SCRIPT, 'utf8');

function runOn(files) {
  const root = mkdtempSync(join(tmpdir(), 'mobile-lint-selftest-'));
  const src = join(root, 'apps/mobile/src');
  mkdirSync(src, { recursive: true });
  for (const [name, body] of Object.entries(files)) writeFileSync(join(src, name), body);
  mkdirSync(join(root, 'scripts'), { recursive: true });
  writeFileSync(join(root, 'scripts/l.mjs'), SRC);
  let code = 0;
  let out = '';
  try {
    out = execFileSync(process.execPath, [join(root, 'scripts/l.mjs')], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    code = e.status ?? 1;
    out = `${e.stdout ?? ''}${e.stderr ?? ''}`;
  }
  rmSync(root, { recursive: true, force: true });
  return { code, out };
}

const CASES = [
  /* ── 审计 #439：含嵌套花括号的样式项整条从检查里消失 ──
   * 原实现 `matchAll(/\{[^{}]*\}/gs)` 的 `[^{}]` 只能匹配最内层花括号。
   * 下面三条用**同一个必不达标的颜色**，唯一变量是嵌套属性——三条必须同结论，
   * 否则就是「加个阴影就退出检查」的原缺陷。 */
  {
    name: '#439：无嵌套花括号的不达标色 → 应报（基准）',
    files: { 'a.tsx': "const s = { bad: { fontSize: 13, color: '#F1F5F9' } };\n" },
    expect: 1,
  },
  {
    name: '#439：含 shadowOffset 嵌套对象，同一不达标色 → 仍应报',
    files: {
      'a.tsx': "const s = { bad: { fontSize: 13, shadowOffset: { width: 0, height: 1 }, color: '#F1F5F9' } };\n",
    },
    expect: 1,
  },
  {
    name: '#439：含 transform 数组嵌套，同一不达标色 → 仍应报',
    files: {
      'a.tsx': "const s = { bad: { fontSize: 13, transform: [{ scale: 1.1 }], color: '#F1F5F9' } };\n",
    },
    expect: 1,
  },
  {
    name: '#439：含嵌套且**达标**的色 → 不报（别把功能一起关掉）',
    files: {
      'a.tsx': "const s = { ok: { fontSize: 13, shadowOffset: { width: 0, height: 1 }, color: '#1F2937' } };\n",
    },
    expect: 0,
  },

  /* ⚠️ 审计 #418：原正则写死「单引号 + 恰好 6 位 hex」，3/4/8 位与双引号全部逃逸。
   * 生产实例 ConflictInboxScreen.tsx 的 `color: '#fff'` 从未被评估过。 */
  {
    name: '审计 #418：3 位 hex 不达标 → 应报（曾完全逃逸）',
    /* #999 在白底上约 2.85:1，远低于 4.5 阈值。 */
    files: { 'a.tsx': "const s = { bad: { fontSize: 12, color: '#999' } };\n" },
    expect: 1,
  },
  {
    name: '审计 #418：双引号 hex 不达标 → 应报（曾完全逃逸）',
    files: { 'a.tsx': 'const s = { bad: { fontSize: 12, color: "#CBD5E1" } };\n' },
    expect: 1,
  },
  /* 对照：3 位 hex 达标的必须放行 —— 证明 lum() 的归一化是对的
   * （不展开会算出 NaN，比较恒假 ⇒ 静默放行，那是把漏检换成假绿）。 */
  {
    name: '审计 #418 对照：3 位 hex 达标 → 放行（验证 lum 归一化非 NaN）',
    files: { 'a.tsx': "const s = { ok: { fontSize: 12, color: '#000' } };\n" },
    expect: 0,
  },
  {
    name: '单行样式不达标 → 应报',
    files: { 'a.tsx': "const s = { container: { backgroundColor: '#F8FAFC' },\n  bad: { fontSize: 12, color: '#CBD5E1' } };\n" },
    expect: 1,
  },
  {
    name: '★跨行样式不达标 → 应报（曾静默漏掉 15 处）',
    files: {
      'a.tsx': "const s = {\n  container: { backgroundColor: '#F8FAFC' },\n  bad: {\n    fontSize: 12,\n    color: '#CBD5E1',\n  },\n};\n",
    },
    expect: 1,
  },
  {
    name: '★暗色屏用 screen 命名根样式 → 浅色文字应判达标（曾误报整屏）',
    files: {
      'a.tsx': "const s = {\n  screen: { backgroundColor: '#0F172A' },\n  ok: {\n    fontSize: 12,\n    color: '#94A3B8',\n  },\n};\n",
    },
    expect: 0,
  },
  {
    name: '样式块自带 backgroundColor → 以它为底判定',
    files: {
      'a.tsx': "const s = { container: { backgroundColor: '#F8FAFC' },\n  ok: { fontSize: 15, color: '#FFFFFF', backgroundColor: '#1E3A8A' } };\n",
    },
    expect: 0,
  },
  {
    name: '≥18px 用 3.0 阈值（大字放宽）',
    files: { 'a.tsx': "const s = { container: { backgroundColor: '#FFFFFF' },\n  big: { fontSize: 20, color: '#767676' } };\n" },
    expect: 0,
  },
  {
    name: '带原因的豁免 → 放行',
    files: {
      'a.tsx': "const s = { container: { backgroundColor: '#F8FAFC' },\n  // lint-mobile-contrast-ignore-next-line 该文字落在深色按钮底上，实测 6.29 达标\n  ok: { fontSize: 12, color: '#CBD5E1' } };\n",
    },
    expect: 0,
  },
  {
    name: '无原因的豁免 → 应报',
    files: {
      'a.tsx': "const s = { container: { backgroundColor: '#F8FAFC' },\n  // lint-mobile-contrast-ignore-next-line\n  ok: { fontSize: 12, color: '#CBD5E1' } };\n",
    },
    expect: 1,
  },
  {
    name: 'backgroundColor/borderColor 不当文本色',
    files: { 'a.tsx': "const s = { container: { backgroundColor: '#F8FAFC' },\n  x: { fontSize: 12, borderColor: '#CBD5E1', color: '#1E293B' } };\n" },
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
  console.error(`\nlint-mobile-contrast 自测：${failed}/${CASES.length} 条不通过。`);
  process.exit(1);
}
console.log(`✓ lint-mobile-contrast 自测：${CASES.length}/${CASES.length} 通过。`);
