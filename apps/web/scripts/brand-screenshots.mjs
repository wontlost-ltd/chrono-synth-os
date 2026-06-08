#!/usr/bin/env node
// 在 NAS beta 上跑 4 张品牌截图（SPA pushState 导航 + 清除前端 UI noise）。
// 用法：ADMIN_EMAIL=... ADMIN_PW=... node scripts/brand-screenshots.mjs <output-dir>

import { chromium } from 'playwright';
import { resolve, join } from 'node:path';
import { mkdirSync } from 'node:fs';

const BASE = process.env.BASE ?? 'https://chrono-synth-beta.wontlost.com';
const EMAIL = process.env.ADMIN_EMAIL;
const PW = process.env.ADMIN_PW;
const OUT = resolve(process.argv[2] ?? '/tmp/brand-screenshots');

if (!EMAIL || !PW) {
  console.error('Usage: ADMIN_EMAIL=... ADMIN_PW=... node brand-screenshots.mjs <out>');
  process.exit(1);
}

mkdirSync(OUT, { recursive: true });

const captures = [
  { viewport: { width: 1920, height: 1080 }, dsf: 2, path: '/admin/tool-permissions', file: '01-admin-tools.png',        waitFor: 2500 },
  { viewport: { width: 1920, height: 1080 }, dsf: 2, path: '/admin/tool-invocations', file: '02-tool-invocations.png',   waitFor: 2500 },
  { viewport: { width: 1920, height: 1080 }, dsf: 2, path: '/enterprise',             file: '03-enterprise-console.png', waitFor: 2500 },
  { viewport: { width: 1280, height: 720 },  dsf: 2, path: '/admin/tool-permissions', file: 'loom-thumb.png',            waitFor: 2500 },
];

const browser = await chromium.launch();

async function loginThenCapture(c) {
  const ctx = await browser.newContext({ viewport: c.viewport, deviceScaleFactor: c.dsf });
  const page = await ctx.newPage();

  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await page.fill('#email', EMAIL);
  await page.fill('#password', PW);
  await page.getByRole('button', { name: /^Login$/ }).first().click();
  await page.waitForResponse(r => r.url().includes('/api/v1/auth/login') && r.status() === 200, { timeout: 15000 });
  await page.waitForTimeout(1500);

  /* SPA navigation — avoids hard reload that drops in-memory access token */
  if (c.path !== '/dashboard') {
    await page.evaluate(p => {
      history.pushState(null, '', p);
      window.dispatchEvent(new PopStateEvent('popstate'));
    }, c.path);
  }
  await page.waitForTimeout(c.waitFor);

  /* Dismiss SetupChecklist + onboarding wizard via the same persisted state
     mechanism the app uses (see SetupChecklist.tsx storageKey). This avoids
     clicking buttons that may trigger backdrops or accidentally removing
     real layout chrome (sidebar is also an <aside>). */
  await page.evaluate(() => {
    try {
      localStorage.setItem('chrono.setup-checklist.v1', JSON.stringify({ dismissed: true, collapsed: false }));
    } catch { /* ignore */ }
  });

  /* Close any open modal by pressing Escape (preferred over DOM removal) */
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);

  /* Reload-free re-render: trigger a re-render by dispatching storage event */
  await page.evaluate(() => {
    window.dispatchEvent(new StorageEvent('storage', { key: 'chrono.setup-checklist.v1' }));
  });
  await page.waitForTimeout(500);

  const out = join(OUT, c.file);
  await page.screenshot({ path: out, fullPage: false });
  console.log(`✓ ${out}  (${page.url()})`);
  await ctx.close();
}

for (const c of captures) {
  try {
    await loginThenCapture(c);
  } catch (e) {
    console.warn(`✗ ${c.file}: ${e.message.slice(0, 200)}`);
  }
}

await browser.close();
console.log(`\nDone. Output: ${OUT}`);
