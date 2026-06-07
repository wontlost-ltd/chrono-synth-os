import { test, expect } from '@playwright/test';

test.describe('Onboarding', () => {
  test('onboarding page redirects to login when unauthenticated', async ({ page }) => {
    await page.goto('/onboarding');
    await expect(page).toHaveURL(/\/login/);
  });

  test('settings page redirects to login when unauthenticated', async ({ page }) => {
    await page.goto('/settings');
    await expect(page).toHaveURL(/\/login/);
  });

  test('simulations list redirects to login when unauthenticated', async ({ page }) => {
    await page.goto('/simulations');
    await expect(page).toHaveURL(/\/login/);
  });

  test('onboarding v2 redirects to login when unauthenticated', async ({ page }) => {
    await page.goto('/onboarding/v2');
    await expect(page).toHaveURL(/\/login/);
  });
});
