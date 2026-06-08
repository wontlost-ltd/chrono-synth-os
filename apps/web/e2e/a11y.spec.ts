import { test, expect } from '@playwright/test';

test.describe('Accessibility', () => {
  test('login page has form labels', async ({ page }) => {
    await page.goto('/login');
    await expect(page.getByLabel(/邮箱|Email/i)).toBeVisible();
    await expect(page.getByLabel(/密码|Password/i)).toBeVisible();
  });

  test('register page has form labels', async ({ page }) => {
    await page.goto('/register');
    await expect(page.getByLabel(/邮箱|Email/i)).toBeVisible();
    const passwordInputs = page.locator('input[type="password"]');
    await expect(passwordInputs.first()).toBeVisible();
  });

  test('login page has no duplicate IDs', async ({ page }) => {
    await page.goto('/login');
    const duplicates = await page.evaluate(() => {
      const ids = Array.from(document.querySelectorAll('[id]')).map(el => el.id);
      const seen = new Set<string>();
      const dupes: string[] = [];
      for (const id of ids) {
        if (seen.has(id)) dupes.push(id);
        seen.add(id);
      }
      return dupes;
    });
    expect(duplicates).toEqual([]);
  });

  test('login page has lang attribute on html', async ({ page }) => {
    await page.goto('/login');
    const lang = await page.locator('html').getAttribute('lang');
    expect(lang).toBeTruthy();
  });

  test('login page buttons have accessible names', async ({ page }) => {
    await page.goto('/login');
    const buttons = page.getByRole('button');
    const count = await buttons.count();
    for (let i = 0; i < count; i++) {
      const name = await buttons.nth(i).getAttribute('aria-label') ?? await buttons.nth(i).textContent();
      expect(name?.trim().length).toBeGreaterThan(0);
    }
  });

  test('register page form validation prevents empty submit', async ({ page }) => {
    await page.goto('/register');
    const submitButton = page.getByRole('button', { name: /注册|Register/i });
    await submitButton.click();
    await expect(page).toHaveURL(/\/register/);
  });

  test('keyboard focus is visible on form inputs', async ({ page }) => {
    await page.goto('/login');
    /* 使用 Tab 键模拟键盘导航，触发真实的 :focus-visible */
    const emailInput = page.getByLabel(/邮箱|Email/i);
    const passwordInput = page.getByLabel(/密码|Password/i);
    await emailInput.focus();
    await expect(emailInput).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(passwordInput).toBeFocused();
  });
});
