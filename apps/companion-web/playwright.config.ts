import { defineConfig, devices } from '@playwright/test';

/**
 * companion-web 真浏览器 E2E（给 #112 Edge Web Worker + #115 语音 ASR 补单测之外的真环境验证）。
 *
 * 关键：webServer 跑 `vite preview`（**构建产物**，非 dev），这样端侧人格 Worker 是真打包出的
 * persona-worker chunk——E2E 才能验证「kernel 真在浏览器 Web Worker 里加载运行」（#112 的核心论点）。
 * preview 前先 build（command 串 build && preview）。
 *
 * E2E 不依赖后端：用 page.route 把 /auth/login 与 /companion/me/perceive mock 掉，只验证前端行为
 * （Edge Worker 纯客户端 + 语音 ASR→转写→提交流程）。与 apps/web 的 playwright 约定一致。
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'html',
  use: {
    baseURL: 'http://localhost:4173',
    locale: 'zh-CN',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    /* 屏蔽 PWA Service Worker：它对 /api/v1/companion/me* 做 StaleWhileRevalidate，会抢在
     * page.route mock 之前拦截请求（导致 502/缓存副本），干扰 E2E。SW 行为不在本套验证范围
     * （这里验 Edge Worker + 语音 ASR），直接 block。 */
    serviceWorkers: 'block',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    /* 先 build 再 preview——E2E 跑构建产物，Worker chunk 是真打包出来的。 */
    command: 'npm run build && npm run preview -- --port 4173 --strictPort',
    url: 'http://localhost:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
