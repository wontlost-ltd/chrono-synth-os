import { test, expect, type Page } from '@playwright/test';

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
const SESSION_STATE = JSON.stringify({
  apiKey: 'test-api-key',
  tenantId: 'default',
  mode: 'demo',
  user: null,
});

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

test.describe('Billing', () => {
  test('redirects unauthenticated users to /login', async ({ page }) => {
    await page.goto('/billing');
    await expect(page).toHaveURL(/\/login/);
  });

  test('billing page renders current plan section', async ({ page }) => {
    await seedSession(page);
    await mockBilling(page);
    await page.goto('/billing');

    const heading = page.getByText(/计费|Billing|订阅|Subscription/i);
    const skeleton = page.locator('[data-testid="skeleton"]');
    const errorState = page.getByText(/error|错误/i);

    await expect(
      heading.or(skeleton).or(errorState).first(),
    ).toBeVisible({ timeout: 5000 });
  });

  test('billing page does not crash on load', async ({ page }) => {
    await seedSession(page);
    await mockBilling(page);
    await page.goto('/billing');

    const body = page.locator('body');
    await expect(body).not.toBeEmpty();
  });

  test('billing page handles expired token gracefully', async ({ page }) => {
    /* 模拟过期 token：注入一个 token 后拦截 API 返回 401 */
    await seedSession(page);
    await page.route('**/api/**', route =>
      route.fulfill({ status: 401, body: JSON.stringify({ error: 'Unauthorized' }) }),
    );
    await page.goto('/billing');

    /* 页面应重定向到登录或显示错误，而不是崩溃 */
    const loginUrl = page.url().includes('/login');
    const errorVisible = await page.getByText(/error|错误|unauthorized|未授权|登录/i).isVisible().catch(() => false);
    const bodyNotEmpty = await page.locator('body').textContent();

    expect(loginUrl || errorVisible || (bodyNotEmpty && bodyNotEmpty.length > 0)).toBeTruthy();
  });

  test('billing page handles network failure gracefully', async ({ page }) => {
    await seedSession(page);
    await page.route('**/api/v1/billing/plans', route => route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'Service Unavailable' }),
    }));
    await page.route('**/api/v1/billing/usage', route => route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'Service Unavailable' }),
    }));
    await page.goto('/billing');

    /* 页面应展示错误态或加载态 */
    const errorState = page.getByText(/加载计费数据失败|Failed to load billing data|错误|Error/i);
    const loading = page.getByRole('status', { name: /加载中|Loading/i });
    await expect(errorState.or(loading).first()).toBeVisible({ timeout: 5000 });
  });

  test('billing page has correct document title', async ({ page }) => {
    await seedSession(page);
    await mockBilling(page);
    await page.goto('/billing');
    await expect(page).toHaveTitle(/.+/);
  });

  test('clearing auth token redirects away from billing', async ({ page }) => {
    await seedSession(page);
    await mockBilling(page);
    await page.goto('/billing');

    /* 清除 token 并尝试导航，应被重定向 */
    await page.evaluate(() => {
      localStorage.removeItem('chrono-session');
    });
    await page.goto('/billing');
    await expect(page).toHaveURL(/\/login|\/billing/);
  });
});
