#!/usr/bin/env node
// UI v2 视觉特征验证 — 对 production NAS 跑断言式检查
//
// 用法：BASE=https://chrono-synth-beta.wontlost.com \
//      ADMIN_EMAIL=admin@beta.test ADMIN_PW=*** \
//      node scripts/verify-ui-v2.mjs
//
// 验证 5 个 group：
//   G1: 主题加载（data-theme=dark，page bg 深色）
//   G2: Brand identity（wordmark 渐变文字 + 沙漏 logo + tenant badge）
//   G3: Sidebar（14 个 SVG icons + active nav rail）
//   G4: AdminToolPermissions UI v2（chip-mono + scope badges + table tier）
//   G5: EnterpriseConsole v2.1（4 色 KPI accent rails + gradient tab underline）

import { chromium } from 'playwright';

const BASE = process.env.BASE ?? 'https://chrono-synth-beta.wontlost.com';
const EMAIL = process.env.ADMIN_EMAIL;
const PW = process.env.ADMIN_PW;

if (!EMAIL || !PW) {
  console.error('Usage: BASE=... ADMIN_EMAIL=... ADMIN_PW=... node verify-ui-v2.mjs');
  process.exit(1);
}

const results = [];
function record(group, name, passed, detail = '') {
  results.push({ group, name, passed, detail });
  const tag = passed ? '✓' : '✗';
  console.log(`${tag} [${group}] ${name}${detail ? '  → ' + detail : ''}`);
}

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
const page = await ctx.newPage();

/* === G1: Theme ============================================== */
await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });

const themeInitial = await page.evaluate(() => ({
  attr: document.documentElement.getAttribute('data-theme'),
  surface: getComputedStyle(document.documentElement).getPropertyValue('--color-surface').trim(),
  bodyBg: getComputedStyle(document.body).backgroundColor,
}));
record('G1', 'data-theme="dark" 已应用', themeInitial.attr === 'dark', `attr=${themeInitial.attr}`);
record('G1', 'page bg is deep navy (#050914)', themeInitial.surface === '#050914', `surface=${themeInitial.surface}`);

/* === G2 + G3 + G4: Need login ============================================== */
await page.fill('#email', EMAIL);
await page.fill('#password', PW);
await page.getByRole('button', { name: /^Login$/ }).first().click();
await page.waitForResponse(r => r.url().includes('/api/v1/auth/login') && r.status() === 200, { timeout: 20000 });
await page.waitForTimeout(2000);

/* G2: Brand identity (sidebar wordmark + logo + tenant badge) */
const brand = await page.evaluate(() => {
  const wm = document.querySelector('aside .text-gradient-brand');
  const logoSvg = document.querySelector('aside [aria-hidden="true"] svg');
  const tenantBadge = Array.from(document.querySelectorAll('aside')).flatMap(a =>
    Array.from(a.querySelectorAll('div'))
  ).find(el => /TENANT/i.test(el.textContent ?? ''));
  return {
    wordmarkPresent: !!wm,
    wordmarkText: wm?.textContent ?? null,
    wordmarkBgImage: wm ? getComputedStyle(wm).backgroundImage : null,
    wordmarkUsesBgClipText: wm ? getComputedStyle(wm).backgroundClip === 'text' || getComputedStyle(wm).webkitBackgroundClip === 'text' : false,
    logoSvgPresent: !!logoSvg,
    tenantBadgePresent: !!tenantBadge,
  };
});
record('G2', 'Wordmark "ChronoSynth" present', brand.wordmarkPresent && brand.wordmarkText === 'ChronoSynth', brand.wordmarkText ?? 'missing');
record('G2', 'Wordmark uses gradient background-clip:text', brand.wordmarkUsesBgClipText, brand.wordmarkBgImage?.slice(0, 60) ?? 'none');
record('G2', 'Hourglass logo SVG present', brand.logoSvgPresent);
record('G2', 'Tenant badge visible', brand.tenantBadgePresent);

/* G3: Sidebar icons + active state */
const sidebar = await page.evaluate(() => {
  const svgs = document.querySelectorAll('aside nav svg');
  const activeLinks = document.querySelectorAll('aside .nav-active-rail');
  return {
    iconCount: svgs.length,
    activeCount: activeLinks.length,
  };
});
record('G3', 'Sidebar has ≥10 SVG line icons', sidebar.iconCount >= 10, `${sidebar.iconCount} icons`);
record('G3', 'At least one active nav has rail accent (.nav-active-rail)', sidebar.activeCount >= 1, `${sidebar.activeCount} active`);

/* G4: AdminToolPermissions table */
await page.evaluate(() => {
  history.pushState(null, '', '/admin/tool-permissions');
  window.dispatchEvent(new PopStateEvent('popstate'));
});
await page.waitForTimeout(3000);

const adminTools = await page.evaluate(() => {
  const chips = document.querySelectorAll('.chip-mono');
  const scopeBadges = Array.from(document.querySelectorAll('span'))
    .filter(s => /^(read|write|execute)$/i.test(s.textContent?.trim() ?? ''));
  const rows = document.querySelectorAll('table tbody tr');
  const hasErrorBanner = /Load failed|data is undefined/i.test(document.body.innerText);
  const thead = document.querySelector('thead');
  const theadBg = thead ? getComputedStyle(thead).backgroundColor : null;
  return {
    chipCount: chips.length,
    scopeBadgeCount: scopeBadges.length,
    rowCount: rows.length,
    hasErrorBanner,
    theadBg,
  };
});
record('G4', 'AdminToolPermissions renders rows (envelope unwrap fix)', adminTools.rowCount > 10, `${adminTools.rowCount} rows`);
record('G4', 'NO "Load failed" error banner', !adminTools.hasErrorBanner);
record('G4', 'Persona chips render as .chip-mono', adminTools.chipCount > 0, `${adminTools.chipCount} chips`);
record('G4', 'Scope badges (READ/WRITE/EXECUTE) visible', adminTools.scopeBadgeCount > 0, `${adminTools.scopeBadgeCount} badges`);
record('G4', 'Table header has indigo tint background', adminTools.theadBg !== null && adminTools.theadBg !== 'rgba(0, 0, 0, 0)', adminTools.theadBg ?? 'transparent');

/* G5: EnterpriseConsole v2.1 (KPI accent rails + tab gradient) */
await page.evaluate(() => {
  history.pushState(null, '', '/enterprise');
  window.dispatchEvent(new PopStateEvent('popstate'));
});
await page.waitForTimeout(3000);

const enterprise = await page.evaluate(() => {
  /* MetricTile accent rails are absolute-positioned divs with linear-gradient bg */
  const tiles = Array.from(document.querySelectorAll('.rounded-xl.border'));
  const tilesWithRail = tiles.filter(t => {
    const rail = t.querySelector('[aria-hidden="true"]');
    if (!rail) return false;
    const cs = getComputedStyle(rail);
    return cs.backgroundImage?.includes('linear-gradient');
  });

  /* Active tab — selected one has absolute-positioned underline span */
  const activeTab = document.querySelector('[role="tab"][aria-selected="true"]');
  const underline = activeTab?.querySelector('[aria-hidden="true"]');
  const underlineBg = underline ? getComputedStyle(underline).backgroundImage : null;

  return {
    tileCount: tiles.length,
    railCount: tilesWithRail.length,
    activeTabPresent: !!activeTab,
    activeTabUnderlineHasGradient: !!underlineBg && underlineBg.includes('linear-gradient'),
    activeTabUnderlineBg: underlineBg?.slice(0, 80) ?? null,
  };
});
record('G5', 'EnterpriseConsole has ≥4 cards', enterprise.tileCount >= 4, `${enterprise.tileCount} cards`);
record('G5', '≥3 cards have gradient accent rail', enterprise.railCount >= 3, `${enterprise.railCount} rails`);
record('G5', 'Active tab present', enterprise.activeTabPresent);
record('G5', 'Active tab underline uses brand gradient', enterprise.activeTabUnderlineHasGradient, enterprise.activeTabUnderlineBg ?? 'none');

/* === Summary ============================================== */
await browser.close();

const passed = results.filter(r => r.passed).length;
const total = results.length;
const byGroup = results.reduce((acc, r) => {
  if (!acc[r.group]) acc[r.group] = { pass: 0, total: 0 };
  acc[r.group].total++;
  if (r.passed) acc[r.group].pass++;
  return acc;
}, {});

console.log('\n=== Summary ===');
for (const [g, s] of Object.entries(byGroup)) {
  console.log(`  ${g}: ${s.pass}/${s.total}`);
}
console.log(`\nTOTAL: ${passed}/${total} passed`);

if (passed < total) {
  console.log('\n=== Failed assertions ===');
  for (const r of results.filter(x => !x.passed)) {
    console.log(`  ✗ [${r.group}] ${r.name}  ${r.detail}`);
  }
  process.exit(1);
}
