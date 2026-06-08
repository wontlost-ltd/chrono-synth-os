import { test, expect } from '@playwright/test';

test.describe('Navigation', () => {
  test('root redirects to dashboard then login', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/login/);
  });

  test('unknown routes render the 404 page (not auth-gated)', async ({ page }) => {
    /* P3.9 changed the catch-all from `Navigate('/dashboard')` to a real
     * NotFound component. The 404 surface is intentionally not behind the
     * auth gate — telling someone "that path doesn't exist" doesn't leak
     * any data. The URL stays put; the page renders the branded 404. */
    await page.goto('/this-does-not-exist');
    await expect(page).toHaveURL(/\/this-does-not-exist/);
    /* The NotFound page renders an h1 with the title key */
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  });

  test('login page has correct document title', async ({ page }) => {
    await page.goto('/login');
    await expect(page).toHaveTitle(/.+/);
  });

  test('register page has correct document title', async ({ page }) => {
    await page.goto('/register');
    await expect(page).toHaveTitle(/.+/);
  });

  test('SSO callback page renders without crash', async ({ page }) => {
    const response = await page.goto('/sso/callback');
    expect(response?.ok()).toBeTruthy();
    await expect(page.locator('#root')).toBeAttached();
    await expect(page).toHaveURL(/\/sso\/callback/);
  });

  test('login page navigation elements are accessible', async ({ page }) => {
    await page.goto('/login');
    const loginButton = page.getByRole('button', { name: /^(登录|Login)$/i });
    await expect(loginButton).toBeVisible();
    await expect(loginButton).toBeEnabled();
  });

  test('register page navigation elements are accessible', async ({ page }) => {
    await page.goto('/register');
    const registerButton = page.getByRole('button', { name: /注册|Register/i });
    await expect(registerButton).toBeVisible();
    await expect(registerButton).toBeEnabled();
  });
});
