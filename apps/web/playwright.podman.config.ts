/**
 * Playwright config for podman E2E.
 *
 * Targets the chrono-synth-web nginx container (running at 127.0.0.1:8080)
 * which proxies to the chrono-synth-os backend (127.0.0.1:3000). No dev
 * server is started; the stack must be up via podman-compose first:
 *
 *   podman compose -f .claude/plan/artifacts/podman-compose.yml up -d
 *   PLAYWRIGHT_BASE_URL=http://127.0.0.1:8080 \
 *     npx playwright test --config=playwright.podman.config.ts
 */

import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e/podman',
  fullyParallel: false, // serial — real backend, avoid contention
  retries: 0,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:8080',
    locale: 'zh-CN',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  /* No webServer: assume the podman stack is already running. */
});
