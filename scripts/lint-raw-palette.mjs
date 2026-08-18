#!/usr/bin/env node
/**
 * 禁止在 apps/web 直接使用 Tailwind 裸调色板色（text-gray-500 / bg-blue-600 …）。
 *
 * 为什么需要这道门：`lint:contrast` 是基于**语义 token 对**做计算的，
 * 结构上看不见硬编码的调色板色——所以 `text-gray-600`（在 dark canvas 上
 * 只有 2.63，远低于 AA 4.5）这类问题它一个都抓不到。axe E2E 能抓，但只覆盖
 * 已纳入路由清单且默认渲染出来的节点。这道静态门补的就是这两者之间的缝。
 *
 * 历史：迁移前 apps/web 有 124 处裸 gray，其中 45 处作文本用且实测不达 AA
 * （gray-500 4.11 / gray-600 2.63 / gray-700 1.93）。
 *
 * 允许清单（ALLOW）只用于确有理由的例外，新增须在此写明原因。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const TARGET = join(ROOT, 'apps/web/src');

/** Tailwind 默认调色板色名——语义 token（surface/text/border/primary…）不在此列。 */
const PALETTE = [
  'slate', 'gray', 'zinc', 'neutral', 'stone',
  'red', 'orange', 'amber', 'yellow', 'lime', 'green', 'emerald', 'teal',
  'cyan', 'sky', 'blue', 'indigo', 'violet', 'purple', 'fuchsia', 'pink', 'rose',
];
const UTIL = 'text|bg|border|ring|from|to|via|divide|outline|decoration|shadow|fill|stroke|placeholder|accent|caret';
const RE = new RegExp(`\\b(?:${UTIL})-(?:${PALETTE.join('|')})-\\d{2,3}\\b`, 'g');

/**
 * 例外清单：`文件相对路径 → 原因`。
 * 空清单即「零容忍」；确需例外时在此登记，让下一个人看得到理由。
 */
const ALLOW = new Map([
  // 例：['src/features/x/Chart.tsx', '图表系列色需固定色相，不随主题变化'],
]);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(tsx?|css)$/.test(name)) out.push(p);
  }
  return out;
}

let violations = 0;
let scanned = 0;
for (const file of walk(TARGET)) {
  const rel = relative(join(ROOT, 'apps/web'), file);
  scanned += 1;
  if (ALLOW.has(rel)) continue;
  const text = readFileSync(file, 'utf8');
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    const hits = line.match(RE);
    if (!hits) return;
    for (const hit of hits) {
      violations += 1;
      console.error(`  ✖ ${rel}:${i + 1}  ${hit}`);
    }
  });
}

if (violations > 0) {
  console.error(`\n裸调色板色门：${scanned} 个文件中发现 ${violations} 处。`);
  console.error('请改用语义 token（text-text-primary / text-text-secondary /');
  console.error('border-border / bg-surface-elevated / text-primary-text …），');
  console.error('它们随主题切换且已被 lint:contrast 覆盖。');
  console.error('确有例外请登记到 scripts/lint-raw-palette.mjs 的 ALLOW 并写明原因。');
  process.exit(1);
}
console.log(`✓ 裸调色板色门：${scanned} 个文件，无硬编码调色板色。`);
