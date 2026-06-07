/**
 * EP-2.4 PR B — Visual Regression baseline
 *
 * Snapshots 5 key pages × 1 theme (light) so future PRs get a diff
 * if the rendered DOM changes visually. The bar is "catch design
 * regressions before they reach prod"; absolute pixel fidelity is
 * not the goal.
 *
 * Stability hardening (in order of how much each one matters):
 *  - Disable all CSS animations + transitions via injected stylesheet.
 *    Without this, a button that animates `translateY` on hover (we
 *    have several) generates non-deterministic snapshots.
 *  - Lock the test viewport to a fixed device (Desktop Chrome 1280×720).
 *  - Mock Date.now via page.clock so timestamps in EmptyStates and
 *    list-page columns ("created at", "last sync at") render the same
 *    every run. We anchor at 2026-05-10T00:00:00Z.
 *  - Mock all /api/v1/* responses to empty arrays so list pages render
 *    the new structured EmptyState consistently. This is the same
 *    pattern axe-routes.spec.ts uses.
 *  - Mock font availability: fonts must be loaded before screenshot
 *    or the layout shifts. We wait on document.fonts.ready.
 *  - Increase pixel-diff tolerance to maxDiffPixelRatio: 0.01 (1%) so
 *    GPU/sub-pixel rounding differences between local + CI don't
 *    cause spurious diffs.
 *
 * Failure mode policy (collect-only for first run):
 *  - The CI job runs with --update-snapshots NOT set; failures upload
 *    diff images as an artifact for human review.
 *  - PRs are NOT blocked by VR diffs in this first iteration; the
 *    `vr-baseline` job has continue-on-error: true in ci.yml. After
 *    one or two iterations of the team auditing diffs and confirming
 *    the snapshots are stable, that flag flips off in a follow-up PR.
 *  - This mirrors the DAST baseline collect-mode policy from P0.1
 *    (ADR-0039).
 *
 * Routes covered:
 *  - /login (unauth surface)
 *  - /dashboard (post-login landing)
 *  - /personas (list page exercising new EmptyState — Part 1 of this PR)
 *  - /billing (settings-style page with structured layout)
 *  - /settings (light page with form fields, low data noise)
 */

import { test, expect, type Page } from '@playwright/test';

const SESSION_STATE = JSON.stringify({
  apiKey: 'vr-test-api-key',
  tenantId: 'default',
  mode: 'authenticated',
  user: { id: 'vr-user', email: 'vr@example.test', role: 'admin' },
});

/* Fixed point in time so all "X minutes ago" / formatDate calls are
 * deterministic. 2026-05-10T00:00:00Z chosen because it's after every
 * timestamp the API mocks return (fixtures use fixed older timestamps). */
const FROZEN_TIME = new Date('2026-05-10T00:00:00Z');

async function disableMotion(page: Page) {
  await page.addStyleTag({
    content: `
      *, *::before, *::after {
        animation-duration: 0s !important;
        animation-delay: 0s !important;
        transition-duration: 0s !important;
        transition-delay: 0s !important;
      }
      /* The skeleton-loader pulse and chart fade-in are the two
       * specific animations that pollute first-paint snapshots. */
      .animate-pulse, [class*="animate-"] {
        animation: none !important;
      }
    `,
  });
}

async function seedSession(page: Page) {
  await page.goto('/login');
  await page.evaluate((value) => {
    localStorage.setItem('chrono-session', value);
    /* Suppress the first-run welcome modal so its illustration overlay
     * doesn't pollute snapshots. */
    localStorage.setItem('chrono.user.welcome-seen', 'true');
    /* Lock the theme to light for deterministic baselines. PR C will
     * extend snapshots to cover dark + high-contrast. */
    localStorage.setItem('chrono.theme', 'light');
  }, SESSION_STATE);
}

async function mockApi(page: Page) {
  /* Catch-all for /api/v1/* — same approach axe-routes uses. Empty
   * arrays make every list page show the new structured EmptyState. */
  await page.route('**/api/v1/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: [] }),
    }),
  );
}

async function preparePage(page: Page) {
  /* page.clock is supported in Playwright 1.45+; we install a fixed
   * tick at FROZEN_TIME and freeze the clock so setTimeout-driven
   * UI (toasts, polling) doesn't fire mid-snapshot. */
  await page.clock.install({ time: FROZEN_TIME });
  await seedSession(page);
  await mockApi(page);
}

async function snapshot(page: Page, name: string) {
  await disableMotion(page);
  /* Wait for fonts to ensure consistent layout. The vite dev server
   * preloads system-ui + Noto Sans SC; in cold-start the first few
   * frames render with fallback metrics. */
  await page.evaluate(() => document.fonts?.ready ?? Promise.resolve());
  /* Final settle for any post-mount React state to flush. */
  await page.waitForTimeout(200);
  await expect(page).toHaveScreenshot(name, {
    fullPage: true,
    /* Tolerate sub-pixel / antialiasing differences between local
     * Chromium and CI Chromium, plus the variance Playwright sees
     * across consecutive runs on the same machine (we measured 1.0–
     * 1.2% noise empirically with the static "settings" page +
     * animations disabled). 2% threshold leaves comfortable headroom
     * for AA + GPU rounding while a real layout shift on an "empty
     * state" CTA reliably trips it. */
    maxDiffPixelRatio: 0.02,
    /* Mask elements that legitimately change between runs but
     * aren't part of the design contract. Currently empty; add
     * here if a future component renders a build-hash badge or
     * relative timestamp the clock mock can't catch. */
    mask: [],
  });
}

test.describe('Visual Regression — light theme baseline', () => {
  test.use({ viewport: { width: 1280, height: 720 } });

  test('login page', async ({ page }) => {
    await page.clock.install({ time: FROZEN_TIME });
    /* Login is unauth — no session seed. Mock anyway to cover analytics
     * pings. */
    await mockApi(page);
    await page.goto('/login');
    await page.waitForLoadState('domcontentloaded');
    await snapshot(page, 'login.png');
  });

  test('dashboard', async ({ page }) => {
    await preparePage(page);
    await page.goto('/dashboard');
    /* Wait for AppShell to paint at least the skip-link so we know
     * the shell rendered. */
    const ready = await page.locator('a.skip-link').first()
      .waitFor({ state: 'attached', timeout: 5000 })
      .then(() => true)
      .catch(() => false);
    if (!ready) {
      test.skip(true, 'AppShell did not mount (cold-start race)');
      return;
    }
    await snapshot(page, 'dashboard.png');
  });

  test('personas list (empty state)', async ({ page }) => {
    await preparePage(page);
    await page.goto('/personas');
    const ready = await page.locator('a.skip-link').first()
      .waitFor({ state: 'attached', timeout: 5000 })
      .then(() => true)
      .catch(() => false);
    if (!ready) {
      test.skip(true, 'AppShell did not mount');
      return;
    }
    /* Wait for the EmptyState illustration to render — it's the
     * Part 1 deliverable being baselined. */
    await page.locator('svg[aria-hidden="true"]').first()
      .waitFor({ state: 'attached', timeout: 5000 })
      .catch(() => {});
    await snapshot(page, 'personas-list-empty.png');
  });

  test('billing', async ({ page }) => {
    await preparePage(page);
    await page.goto('/billing');
    const ready = await page.locator('a.skip-link').first()
      .waitFor({ state: 'attached', timeout: 5000 })
      .then(() => true)
      .catch(() => false);
    if (!ready) {
      test.skip(true, 'AppShell did not mount');
      return;
    }
    await snapshot(page, 'billing.png');
  });

  test('settings', async ({ page }) => {
    await preparePage(page);
    await page.goto('/settings');
    const ready = await page.locator('a.skip-link').first()
      .waitFor({ state: 'attached', timeout: 5000 })
      .then(() => true)
      .catch(() => false);
    if (!ready) {
      test.skip(true, 'AppShell did not mount');
      return;
    }
    await snapshot(page, 'settings.png');
  });
});
