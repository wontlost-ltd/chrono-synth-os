import { test, expect } from '@playwright/test';

/**
 * Simulation flow E2E tests.
 * These tests run against the dev server without a real backend,
 * so they focus on page rendering and client-side navigation.
 * Full integration tests require both backend and frontend running.
 */
test.describe('Simulation Pages', () => {
  // Without auth token, all protected routes redirect to /login.
  // These tests verify the redirect behavior works correctly.

  test('dashboard redirects to login when unauthenticated', async ({ page }) => {
    await page.goto('/dashboard');
    await expect(page).toHaveURL(/\/login/);
  });

  test('new simulation wizard redirects to login when unauthenticated', async ({ page }) => {
    await page.goto('/simulations/new');
    await expect(page).toHaveURL(/\/login/);
  });

  test('path comparison redirects to login when unauthenticated', async ({ page }) => {
    await page.goto('/simulations/test-id/paths');
    await expect(page).toHaveURL(/\/login/);
  });

  test('branch explorer redirects to login when unauthenticated', async ({ page }) => {
    await page.goto('/simulations/test-id/branches');
    await expect(page).toHaveURL(/\/login/);
  });

  test('stress test redirects to login when unauthenticated', async ({ page }) => {
    await page.goto('/simulations/test-id/stress');
    await expect(page).toHaveURL(/\/login/);
  });

  test('milestones redirects to login when unauthenticated', async ({ page }) => {
    await page.goto('/simulations/test-id/milestones');
    await expect(page).toHaveURL(/\/login/);
  });

  test('values redirects to login when unauthenticated', async ({ page }) => {
    await page.goto('/values');
    await expect(page).toHaveURL(/\/login/);
  });

  test('system status redirects to login when unauthenticated', async ({ page }) => {
    await page.goto('/system');
    await expect(page).toHaveURL(/\/login/);
  });

  test('billing redirects to login when unauthenticated', async ({ page }) => {
    await page.goto('/billing');
    await expect(page).toHaveURL(/\/login/);
  });

  test('unknown route renders the 404 page (P3.9; not auth-gated)', async ({ page }) => {
    /* The catch-all renders <NotFound />. URL stays put; assert we see
     * the rendered 404 surface. */
    await page.goto('/nonexistent-page');
    await expect(page).toHaveURL(/\/nonexistent-page/);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  });

  test('simulation ID redirect works', async ({ page }) => {
    // /simulations/:id should redirect to /simulations/:id/paths
    await page.goto('/simulations/some-id');
    // Then AuthGuard redirects to /login since unauthenticated
    await expect(page).toHaveURL(/\/login/);
  });
});
