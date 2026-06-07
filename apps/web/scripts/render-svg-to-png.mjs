#!/usr/bin/env node
// SVG → PNG 渲染（用 Playwright headless Chromium）
// 用法：node scripts/render-svg-to-png.mjs <svg-path> <png-path> <width> <height>
// 必须从 chrono-synth-web 工作目录运行（依赖本仓 playwright）

import { chromium } from 'playwright';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const [, , svgArg, pngArg, wArg, hArg] = process.argv;
if (!svgArg || !pngArg || !wArg || !hArg) {
  console.error('Usage: render-svg-to-png.mjs <svg> <png> <width> <height>');
  process.exit(1);
}

const svgPath = resolve(svgArg);
const pngPath = resolve(pngArg);
const width = parseInt(wArg, 10);
const height = parseInt(hArg, 10);

if (!existsSync(svgPath)) {
  console.error(`SVG not found: ${svgPath}`);
  process.exit(1);
}

const svgContent = readFileSync(svgPath, 'utf-8');
const html = `<!doctype html><html><head><style>
  html,body{margin:0;padding:0;width:${width}px;height:${height}px;overflow:hidden;background:transparent}
  svg{width:${width}px;height:${height}px;display:block}
</style></head><body>${svgContent}</body></html>`;

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width, height },
  deviceScaleFactor: 2,
});
const page = await ctx.newPage();
await page.setContent(html, { waitUntil: 'networkidle' });
await page.screenshot({ path: pngPath, omitBackground: false, type: 'png' });
await browser.close();

console.log(`✓ ${pngPath} (${width}×${height} @2x)`);
