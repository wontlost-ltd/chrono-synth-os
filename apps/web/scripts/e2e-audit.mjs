#!/usr/bin/env node
// 全量 UI E2E 审计：跑过 dashboard + 9 个 admin/protected 路由，
// 抓所有 console error + 4xx/5xx network + 渲染异常（empty content、error banner）。
//
// 用法：ADMIN_EMAIL=... ADMIN_PW=... node scripts/e2e-audit.mjs
// 输出：JSON 报告 → /tmp/e2e-audit-report.json + stdout 摘要

import { chromium } from 'playwright';

const BASE = process.env.BASE ?? 'https://chrono-synth-beta.wontlost.com';
const EMAIL = process.env.ADMIN_EMAIL;
const PW = process.env.ADMIN_PW;

if (!EMAIL || !PW) {
  console.error('Usage: ADMIN_EMAIL=... ADMIN_PW=... node e2e-audit.mjs');
  process.exit(1);
}

const ROUTES = [
  '/dashboard',
  '/avatars',
  '/values',
  '/system',
  '/billing',
  '/settings',
  '/enterprise',
  '/admin/tool-permissions',
  '/admin/tool-invocations',
  '/admin/agency-authorizations',
  '/admin/safety/drift',
  '/admin/config',
];

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();

const findings = [];
const consoleErrors = [];
const networkErrors = [];

page.on('console', m => {
  if (m.type() === 'error') consoleErrors.push({ url: page.url(), text: m.text().slice(0, 200) });
});
page.on('response', r => {
  const status = r.status();
  const url = r.url();
  if (status >= 400 && url.includes('/api/')) {
    networkErrors.push({ pageUrl: page.url(), status, apiUrl: url.replace(BASE, ''), method: r.request().method() });
  }
});

/* Login */
await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
await page.fill('#email', EMAIL);
await page.fill('#password', PW);
await page.getByRole('button', { name: /^Login$/ }).first().click();
await page.waitForResponse(r => r.url().includes('/api/v1/auth/login') && r.status() === 200, { timeout: 15000 });
await page.waitForTimeout(1200);

console.log(`Logged in as ${EMAIL}, starting audit of ${ROUTES.length} routes…\n`);

/* Walk each route via SPA pushState — avoids hard reload session drop */
for (const route of ROUTES) {
  /* Reset error counters for this route */
  const baseConsoleCount = consoleErrors.length;
  const baseNetworkCount = networkErrors.length;

  await page.evaluate(p => {
    history.pushState(null, '', p);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, route);

  /* Give React Query time to fire + settle */
  await page.waitForTimeout(2500);

  /* Detect "load failed" / error banners in the page body */
  const bodyText = (await page.locator('body').innerText()).slice(0, 5000);
  const renderProblems = [];
  if (/Load failed|加载失败|data is undefined|Something went wrong/i.test(bodyText)) {
    renderProblems.push('error-banner-visible');
  }
  if (bodyText.trim().length < 200) {
    renderProblems.push('body-nearly-empty');
  }

  const finding = {
    route,
    consoleErrorCount: consoleErrors.length - baseConsoleCount,
    networkErrorCount: networkErrors.length - baseNetworkCount,
    renderProblems,
    sampleConsoleError: consoleErrors[baseConsoleCount]?.text ?? null,
    sampleNetworkError: networkErrors[baseNetworkCount] ?? null,
  };
  findings.push(finding);

  const status =
    finding.consoleErrorCount === 0 && finding.networkErrorCount === 0 && renderProblems.length === 0
      ? '✓'
      : '✗';
  console.log(`${status} ${route}  console=${finding.consoleErrorCount}  network=${finding.networkErrorCount}  render=${renderProblems.length ? renderProblems.join(',') : 'ok'}`);
  if (finding.sampleNetworkError) {
    console.log(`    ↳ ${finding.sampleNetworkError.method} ${finding.sampleNetworkError.apiUrl} → ${finding.sampleNetworkError.status}`);
  }
  if (finding.sampleConsoleError) {
    console.log(`    ↳ console: ${finding.sampleConsoleError.slice(0, 120)}`);
  }
}

await browser.close();

/* Tally network 4xx/5xx hotspots */
const byApi = new Map();
for (const e of networkErrors) {
  const k = `${e.method} ${e.apiUrl} → ${e.status}`;
  byApi.set(k, (byApi.get(k) ?? 0) + 1);
}
const top = [...byApi.entries()].sort((a, b) => b[1] - a[1]);

console.log('\n=== Network error hotspots ===');
for (const [k, n] of top.slice(0, 20)) console.log(`  ${n}×  ${k}`);

console.log('\n=== Console error sample ===');
const uniqConsole = [...new Map(consoleErrors.map(e => [e.text.slice(0, 80), e])).values()];
for (const e of uniqConsole.slice(0, 15)) console.log(`  ${e.text.slice(0, 160)}`);

/* Write JSON report */
import { writeFileSync } from 'node:fs';
const report = { base: BASE, runAt: new Date().toISOString(), findings, networkHotspots: top, consoleSample: uniqConsole.slice(0, 30) };
writeFileSync('/tmp/e2e-audit-report.json', JSON.stringify(report, null, 2));
console.log('\nReport: /tmp/e2e-audit-report.json');
