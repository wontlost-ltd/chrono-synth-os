/**
 * Playwright config for the Visual Regression baseline suite (EP-2.4 PR B).
 *
 * Why a separate config rather than reusing playwright.config.ts:
 *   - The default config has `testIgnore: ['visual-regression/**']` so the
 *     main `e2e` CI job doesn't trip over missing-platform baselines.
 *   - VR has different expectations (fixed viewport, no retries, single
 *     worker) that are unhelpful for the broader e2e sweep.
 *
 * Run locally:
 *   npx playwright test --config=playwright.visual-regression.config.ts
 *
 * Generate / refresh baselines:
 *   npx playwright test --config=playwright.visual-regression.config.ts --update-snapshots
 *
 * Run in CI: see .github/workflows/e2e.yml `vr-baseline` job. Note CI
 * runs in collect-mode (continue-on-error: true) for the first iteration
 * — see in-spec docstring for the rationale and the path to flipping
 * to a hard gate.
 */

import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e/visual-regression',
  fullyParallel: false, // Snapshots are deterministic only when serialised
  forbidOnly: !!process.env.CI,
  retries: 0, // Don't retry — flaky baselines should be visible, not hidden
  workers: 1,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'html',
  use: {
    baseURL: 'http://localhost:5173',
    locale: 'zh-CN',
    timezoneId: 'UTC',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:5173',
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
