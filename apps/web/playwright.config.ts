import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  // e2e/podman/ targets a podman-compose stack at 127.0.0.1:8080 with
  // a real backend behind nginx. The default config here drives the
  // dev vite server (npm run dev) without a backend, so the podman
  // spec's /healthz request 404s. Run those via playwright.podman.config.ts
  // when the podman stack is up.
  //
  // e2e/visual-regression/ runs in its own dedicated `vr-baseline` CI
  // job (see .github/workflows/e2e.yml) with collect-mode policy +
  // continue-on-error: true. Excluding from the default sweep prevents
  // the main e2e job from blocking on missing-platform baselines.
  testIgnore: ['podman/**', 'visual-regression/**'],
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'html',
  use: {
    baseURL: 'http://localhost:5173',
    locale: 'zh-CN',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'firefox',
      use: { ...devices['Desktop Firefox'] },
    },
    {
      name: 'webkit',
      use: { ...devices['Desktop Safari'] },
    },
    {
      name: 'mobile-chrome',
      use: { ...devices['Pixel 5'] },
    },
  ],
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:5173',
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
