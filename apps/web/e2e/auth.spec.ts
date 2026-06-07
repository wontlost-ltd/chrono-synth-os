import { test, expect } from '@playwright/test';

test.describe('Authentication', () => {
  test('redirects unauthenticated users to /login', async ({ page }) => {
    await page.goto('/dashboard');
    await expect(page).toHaveURL(/\/login/);
  });

  test('login page renders with form fields', async ({ page }) => {
    await page.goto('/login');
    await expect(page.getByLabel(/邮箱|Email/i)).toBeVisible();
    await expect(page.getByLabel(/密码|Password/i)).toBeVisible();
    await expect(page.getByRole('button', { name: /^(登录|Login)$/i })).toBeVisible();
  });

  test('login page has link to register', async ({ page }) => {
    await page.goto('/login');
    await expect(page.getByRole('link', { name: /注册|Register/i })).toBeVisible();
  });

  test('register page renders with form fields', async ({ page }) => {
    await page.goto('/register');
    await expect(page.getByLabel(/邮箱|Email/i)).toBeVisible();
    const passwordFields = page.getByRole('textbox').or(page.locator('input[type="password"]'));
    await expect(passwordFields.first()).toBeVisible();
    await expect(page.getByRole('button', { name: /注册|Register/i })).toBeVisible();
  });

  test('register page has link to login', async ({ page }) => {
    await page.goto('/register');
    await expect(page.getByRole('link', { name: /登录|Login/i })).toBeVisible();
  });

  test('login shows validation on empty submit', async ({ page }) => {
    await page.goto('/login');
    await page.getByRole('button', { name: /^(登录|Login)$/i }).click();
    // Form should still be on login page (no navigation)
    await expect(page).toHaveURL(/\/login/);
  });

  test('navigation between login and register', async ({ page }) => {
    await page.goto('/login');
    await page.getByRole('link', { name: /注册|Register/i }).click();
    await expect(page).toHaveURL(/\/register/);
    await page.getByRole('link', { name: /登录|Login/i }).click();
    await expect(page).toHaveURL(/\/login/);
  });
});
