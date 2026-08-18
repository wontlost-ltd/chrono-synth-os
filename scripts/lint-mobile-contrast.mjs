#!/usr/bin/env node
/**
 * apps/mobile 的色彩对比度门。
 *
 * 为什么单独写一个：现有三道门都够不着 mobile——
 *   - `lint:raw-palette` 按 **Tailwind 类名**匹配，RN 用 StyleSheet 对象，没有类名
 *   - `lint:contrast` 按 **语义 token 对**计算，mobile 没有 token 体系
 *   - axe E2E 只跑 web
 * 结果是 mobile 的 190 处硬编码 hex **零门覆盖**。
 *
 * 做法：解析 StyleSheet 里同时带 `fontSize` 与 `color` 的样式条目，
 * 与「该样式自身的 backgroundColor → 同文件容器底 → 屏幕默认底」逐级回退
 * 求出的底色比对，按 WCAG 判 AA（≥18px 用 3.0，否则 4.5）。
 *
 * ⚠️ 已知局限：无法跟踪「文字在 A 组件、底色在 B 组件」的跨组件组合
 * （如按钮文字样式与按钮容器样式分开定义）。这类需人工确认，
 * 故支持 `// lint-mobile-contrast-ignore-next-line <原因>` 行级豁免。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const TARGET = join(ROOT, 'apps/mobile/src');

/** RN 无主题切换，屏幕默认底色（多数 container 用 #F8FAFC）。 */
const DEFAULT_BG = '#F8FAFC';

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

const lum = (hex) => {
  const h = hex.replace('#', '');
  const ch = [0, 2, 4].map((i) => {
    const c = parseInt(h.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
};
const ratio = (a, b) => {
  const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m);
  return +((x + 0.05) / (y + 0.05)).toFixed(2);
};

let violations = 0;
let checked = 0;
for (const file of walk(TARGET)) {
  const text = readFileSync(file, 'utf8');
  const rel = relative(join(ROOT, 'apps/mobile'), file);
  const lines = text.split('\n');

  /* 行级豁免 */
  const exempt = new Set();
  lines.forEach((l, i) => {
    const m = l.match(/lint-mobile-contrast-ignore-next-line\b(.*)$/);
    if (m) {
      if (m[1].replace(/[\s\p{P}\p{S}*/]/gu, '').length < 6) {
        violations += 1;
        console.error(`  ✖ ${rel}:${i + 1}  豁免标记缺原因说明（需 ≥6 个非标点字符）`);
      }
      exempt.add(i + 1);
    }
  });

  /* 该文件的容器底色：优先 container 的 backgroundColor */
  const cm = text.match(/container:\s*\{[^}]*backgroundColor:\s*'(#[0-9a-fA-F]{6})'/s);
  const fileBg = cm ? cm[1] : DEFAULT_BG;

  lines.forEach((line, i) => {
    if (exempt.has(i)) return;
    /* 同一条样式里同时出现 fontSize 与 color 才判定——只有这样才能确定
     * 它是文本、以及字号阈值。 */
    const size = line.match(/fontSize:\s*(\d+)/);
    const color = line.match(/(?<!background)(?<!border)[Cc]olor:\s*'(#[0-9a-fA-F]{6})'/);
    if (!size || !color) return;
    /* 同一条样式自带 backgroundColor 时以它为底 */
    const ownBg = line.match(/backgroundColor:\s*'(#[0-9a-fA-F]{6})'/);
    const bg = ownBg ? ownBg[1] : fileBg;
    const need = +size[1] >= 18 ? 3.0 : 4.5;
    const c = ratio(color[1], bg);
    checked += 1;
    if (c < need) {
      violations += 1;
      console.error(
        `  ✖ ${rel}:${i + 1}  ${color[1]} on ${bg} @${size[1]}px = ${c}（需 ${need}）`,
      );
    }
  });
}

if (violations > 0) {
  console.error(`\nmobile 对比度门：${checked} 处带字号的文本色中发现 ${violations} 处问题。`);
  console.error('若该文字实际落在别的容器底上（跨组件组合，本门跟不到），');
  console.error('请在该行上方加 `// lint-mobile-contrast-ignore-next-line <原因>` 并写明真实底色与实测值。');
  process.exit(1);
}
console.log(`✓ mobile 对比度门：${checked} 处带字号的文本色，全部达标。`);
