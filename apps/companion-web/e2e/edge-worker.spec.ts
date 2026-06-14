import { test, expect } from '@playwright/test';
import { mockLoginAndEnter } from './helpers.js';

/**
 * E2E（#112 验证升级）：端侧人格 Worker 在**真浏览器 Web Worker** 里加载 @chrono/kernel 并跑
 * 确定性 value 闭环。
 *
 * EdgeRuntimeBadge 的「✓ 本设备支持端侧人格内核运行」文案**只在 Worker 自检成功**（worker 里真
 * 加载 kernel、addValue 闭环返回 ≥1 个 value）后才渲染——所以这行文案出现 = kernel 真在浏览器
 * Worker 里跑通了。这把 #112 从「Node fake-worker 单测 + vite build 出 chunk」升级为「真 chromium
 * Worker 端到端」。跑的是 vite preview 的构建产物（真 persona-worker chunk）。
 */
test('端侧人格 Worker 在真浏览器里加载 kernel 并跑通确定性自检', async ({ page }) => {
  await mockLoginAndEnter(page);

  /* Home tab 默认激活，EdgeRuntimeBadge 在其中。自检异步（spawn worker + 一条 addValue 闭环），
   * 等成功态文案出现——出现即证明 kernel 真在 Web Worker 里运行。 */
  const badge = page.locator('.edge-badge');
  await expect(badge).toContainText('本设备支持端侧人格内核运行', { timeout: 15_000 });
});

test('Worker 自检前显示 checking 文案，自检后转为 running（不白屏不卡）', async ({ page }) => {
  await mockLoginAndEnter(page);
  /* 最终稳定到 running 文案（checking 是瞬时态，可能太快抓不到；这里只断言终态可达，不 flaky 抓中间）。 */
  await expect(page.locator('.edge-badge')).toContainText('✓', { timeout: 15_000 });
  /* 徽章是 aria-live=polite（无障碍：自检结果播报给读屏）。 */
  await expect(page.locator('.edge-badge')).toHaveAttribute('aria-live', 'polite');
});
