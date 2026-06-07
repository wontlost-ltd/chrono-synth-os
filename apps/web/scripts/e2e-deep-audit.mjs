#!/usr/bin/env node
// 深度 UI E2E 审计 v2：
//   1. 访问所有静态路由（30+）
//   2. 在每页点击所有可见按钮（非破坏性）
//   3. 在每页填充所有 input（避免破坏数据）
//   4. 抓全量 console error / network 4xx-5xx / unhandled promise rejection
//   5. 输出 bug 报告 + 截图（仅 failed 页）

import { chromium } from 'playwright';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';

const BASE = process.env.BASE ?? 'http://localhost:5173';
const EMAIL = process.env.ADMIN_EMAIL;
const PW = process.env.ADMIN_PW;
const SHOTS = '/tmp/e2e-deep-audit-shots';

if (!EMAIL || !PW) {
  console.error('Usage: ADMIN_EMAIL=... ADMIN_PW=... node e2e-deep-audit.mjs');
  process.exit(1);
}
if (!existsSync(SHOTS)) mkdirSync(SHOTS, { recursive: true });

/* All static routes (no :param) the user can actually navigate to */
const ROUTES = [
  '/dashboard',
  '/simulations',
  '/simulations/new',
  '/values',
  '/system',
  '/billing',
  '/settings',
  '/enterprise',
  '/admin/config',
  '/admin/safety/drift',
  '/admin/tool-permissions',
  '/admin/agency-authorizations',
  '/admin/tool-invocations',
  '/agent/oauth/google',
  '/agent/confirmations',
  '/avatars',
  '/knowledge-sources',
  '/knowledge-sources/create',
  '/personas',
  '/persona-core',
  '/growth',
  '/marketplace',
  '/conflicts',
];

const findings = [];

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();

const consoleErrors = [];
const networkErrors = [];
const unhandledRejections = [];

page.on('console', m => {
  if (m.type() === 'error') consoleErrors.push({ url: page.url(), text: m.text().slice(0, 240) });
});
page.on('response', r => {
  const status = r.status();
  const u = r.url();
  if (status >= 400 && u.includes('/api/')) {
    networkErrors.push({ pageUrl: page.url(), status, apiUrl: u.replace(/^https?:\/\/[^/]+/, ''), method: r.request().method() });
  }
});
page.on('pageerror', e => {
  unhandledRejections.push({ url: page.url(), text: String(e).slice(0, 240) });
});

/* === Login === */
await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
await page.fill('#email', EMAIL);
await page.fill('#password', PW);
await page.getByRole('button', { name: /^Login$/ }).first().click();
await page.waitForResponse(r => r.url().includes('/api/v1/auth/login') && r.status() === 200, { timeout: 15000 });
await page.waitForTimeout(1200);
console.log('Logged in.\n');

/* === Walk each route + interact === */
for (const route of ROUTES) {
  const before = { console: consoleErrors.length, network: networkErrors.length, rejections: unhandledRejections.length };

  /* Navigate via SPA pushState (don't reload — preserves in-memory token) */
  await page.evaluate(p => {
    history.pushState(null, '', p);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, route);
  await page.waitForTimeout(2000);

  /* === Interaction phase === */
  const interactions = { buttonsClicked: 0, inputsFilled: 0, selectsChanged: 0, linksFollowed: 0 };

  /* 1) Click all visible non-destructive buttons on the page (skip submit-destroy-revoke-delete-logout) */
  const dangerWord = /revoke|delete|删除|撤销|logout|退出|skip|cancel|关闭|close|sign\s*out|登出/i;
  const buttons = await page.locator('button:visible').elementHandles();
  for (const btn of buttons.slice(0, 12)) {
    const text = ((await btn.textContent()) ?? '').trim();
    if (!text || dangerWord.test(text)) continue;
    /* Avoid type=submit on forms (would mutate data) */
    const type = await btn.getAttribute('type');
    if (type === 'submit') continue;
    /* Avoid the global navigation collapse / theme switch noise */
    if (/menu|theme|主题|collapse|展开|toggle/i.test(text)) continue;

    try {
      await btn.click({ timeout: 1500, trial: false });
      interactions.buttonsClicked++;
      await page.waitForTimeout(300);
      /* If a modal opened, press Escape */
      await page.keyboard.press('Escape');
      await page.waitForTimeout(200);
    } catch { /* skip detached/disabled */ }
  }

  /* 2) Fill all visible text inputs (without submitting) */
  const inputs = await page.locator('input:visible:not([type=password]):not([type=hidden]):not([type=file]):not([type=submit]):not([readonly]):not([disabled])').elementHandles();
  for (const inp of inputs.slice(0, 8)) {
    try {
      const type = (await inp.getAttribute('type')) ?? 'text';
      const placeholder = (await inp.getAttribute('placeholder')) ?? '';
      const synthetic =
        type === 'number' ? '1' :
        type === 'email' ? 'audit@example.com' :
        type === 'url' ? 'https://example.com' :
        type === 'tel' ? '+15555550100' :
        /search|filter|搜索/i.test(placeholder) ? 'demo' :
        'audit-test';
      await inp.fill(synthetic, { timeout: 800 });
      interactions.inputsFilled++;
    } catch { /* skip */ }
  }

  /* 3) Change selects (pick second option if available — first usually = "All") */
  const selects = await page.locator('select:visible:not([disabled])').elementHandles();
  for (const sel of selects.slice(0, 4)) {
    try {
      const opts = await sel.$$('option');
      if (opts.length >= 2) {
        const val = await opts[1].getAttribute('value');
        if (val !== null) {
          await sel.selectOption(val, { timeout: 800 });
          interactions.selectsChanged++;
        }
      }
    } catch { /* skip */ }
  }

  await page.waitForTimeout(1000);

  /* === Tally + render check === */
  const bodyText = (await page.locator('body').innerText().catch(() => '')).slice(0, 5000);
  const renderProblems = [];
  if (/Load failed|加载失败|data is undefined|Something went wrong|页面崩溃/i.test(bodyText)) {
    renderProblems.push('error-banner');
  }
  if (bodyText.trim().length < 150) renderProblems.push('body-empty');

  const finding = {
    route,
    interactions,
    consoleErrorDelta: consoleErrors.length - before.console,
    networkErrorDelta: networkErrors.length - before.network,
    rejectionDelta: unhandledRejections.length - before.rejections,
    renderProblems,
    sampleConsole: consoleErrors[before.console]?.text?.slice(0, 160) ?? null,
    sampleRejection: unhandledRejections[before.rejections]?.text?.slice(0, 160) ?? null,
    sampleNetwork: networkErrors[before.network] ?? null,
  };
  findings.push(finding);

  const isFail =
    finding.consoleErrorDelta > 0 ||
    finding.networkErrorDelta > 0 ||
    finding.rejectionDelta > 0 ||
    renderProblems.length > 0;

  console.log(
    `${isFail ? '✗' : '✓'} ${route.padEnd(40)} ` +
    `clicks=${interactions.buttonsClicked} inputs=${interactions.inputsFilled} selects=${interactions.selectsChanged} | ` +
    `console=${finding.consoleErrorDelta} net=${finding.networkErrorDelta} thrown=${finding.rejectionDelta} ` +
    `${renderProblems.length ? '[' + renderProblems.join(',') + ']' : ''}`
  );
  if (finding.sampleRejection) console.log(`    ↳ thrown: ${finding.sampleRejection.slice(0, 150)}`);
  if (finding.sampleNetwork) console.log(`    ↳ net:    ${finding.sampleNetwork.method} ${finding.sampleNetwork.apiUrl} → ${finding.sampleNetwork.status}`);
  if (finding.sampleConsole && !finding.sampleNetwork) console.log(`    ↳ console: ${finding.sampleConsole.slice(0, 150)}`);

  /* Screenshot only failed pages */
  if (isFail) {
    await page.screenshot({ path: `${SHOTS}/${route.replace(/\//g, '_')}.png` }).catch(() => {});
  }
}

await browser.close();

/* Aggregate */
const networkByApi = new Map();
for (const e of networkErrors) {
  const k = `${e.method} ${e.apiUrl} → ${e.status}`;
  networkByApi.set(k, (networkByApi.get(k) ?? 0) + 1);
}
const networkTop = [...networkByApi.entries()].sort((a, b) => b[1] - a[1]);

const rejectionsBySig = new Map();
for (const e of unhandledRejections) {
  const sig = e.text.split('\n')[0].slice(0, 100);
  if (!rejectionsBySig.has(sig)) rejectionsBySig.set(sig, e);
}

console.log('\n=== Network error hotspots ===');
for (const [k, n] of networkTop.slice(0, 20)) console.log(`  ${String(n).padStart(3)}×  ${k}`);

console.log('\n=== Unique thrown errors ===');
for (const e of rejectionsBySig.values()) console.log(`  ${e.url.replace(BASE, '')}:  ${e.text.slice(0, 160)}`);

const report = {
  base: BASE,
  runAt: new Date().toISOString(),
  totalRoutes: ROUTES.length,
  passedRoutes: findings.filter(f => f.consoleErrorDelta === 0 && f.networkErrorDelta === 0 && f.rejectionDelta === 0 && f.renderProblems.length === 0).length,
  findings,
  networkTop,
  unhandledRejections: [...rejectionsBySig.values()],
};
writeFileSync('/tmp/e2e-deep-audit.json', JSON.stringify(report, null, 2));
console.log(`\n${report.passedRoutes}/${report.totalRoutes} routes passed.`);
console.log(`Report: /tmp/e2e-deep-audit.json`);
console.log(`Failure shots: ${SHOTS}/`);
