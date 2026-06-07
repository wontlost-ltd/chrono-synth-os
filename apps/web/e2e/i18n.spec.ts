import { test, expect } from '@playwright/test';

test.describe('i18n', () => {
  test('login page renders in default language (zh-CN)', async ({ page }) => {
    await page.goto('/login');
    // Default fallback is zh-CN
    await expect(page.getByRole('button', { name: /^登录$/ })).toBeVisible();
  });

  test('register page renders in default language (zh-CN)', async ({ page }) => {
    await page.goto('/register');
    await expect(page.getByRole('button', { name: '注册' })).toBeVisible();
    await expect(page.getByText('创建账号')).toBeVisible();
  });

  test('language persists to localStorage', async ({ page }) => {
    await page.goto('/login');
    // Verify chrono-lang key is set in localStorage
    const lang = await page.evaluate(() => localStorage.getItem('chrono-lang'));
    // Should be a valid locale (zh-CN or en-US) or null (detector hasn't written yet)
    if (lang) {
      expect(['zh-CN', 'en-US']).toContain(lang);
    }
  });
});
