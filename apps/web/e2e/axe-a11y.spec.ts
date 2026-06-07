import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const SESSION_STATE = JSON.stringify({
  apiKey: 'test-api-key',
  tenantId: 'default',
  mode: 'demo',
  user: null,
});
const MOCK_PLANS = [
  {
    id: 'basic',
    name: 'Basic',
    limits: { maxSimulations: 5, maxPaths: 10, llmTokensPerMonth: 1000 },
  },
];
const MOCK_USAGE = {
  planId: 'basic',
  status: 'active',
  limits: MOCK_PLANS[0].limits,
  usage: { simulation: 1, paths: 2, llm_tokens: 100 },
  periodEnd: Date.now() + 86_400_000,
};

async function seedSession(page: Page) {
  await page.goto('/login');
  await page.evaluate((value) => {
    localStorage.setItem('chrono-session', value);
  }, SESSION_STATE);
}

async function mockBilling(page: Page) {
  await page.route('**/api/v1/billing/plans', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ data: MOCK_PLANS }),
  }));
  await page.route('**/api/v1/billing/usage', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ data: MOCK_USAGE }),
  }));
}

const PAGES = [
  { name: 'login', path: '/login' },
  { name: 'register', path: '/register' },
];

for (const { name, path } of PAGES) {
  test(`${name} page passes axe automated a11y checks`, async ({ page }) => {
    await page.goto(path);
    await page.waitForLoadState('networkidle');
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'best-practice'])
      .analyze();

    const violations = results.violations.filter(v => v.impact === 'critical' || v.impact === 'serious');
    if (violations.length > 0) {
      const summary = violations.map(v => `[${v.impact}] ${v.id}: ${v.description} (${v.nodes.length} nodes)`).join('\n');
      expect.soft(violations, `axe violations on ${name}:\n${summary}`).toEqual([]);
    }
  });
}

test('authenticated billing page passes axe checks', async ({ page }) => {
  await seedSession(page);
  await mockBilling(page);
  await page.goto('/billing');
  await page.waitForLoadState('networkidle');

  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa'])
    .analyze();

  const violations = results.violations.filter(v => v.impact === 'critical' || v.impact === 'serious');
  if (violations.length > 0) {
    const summary = violations.map(v => `[${v.impact}] ${v.id}: ${v.description} (${v.nodes.length} nodes)`).join('\n');
    expect.soft(violations, `axe violations on billing:\n${summary}`).toEqual([]);
  }
});
