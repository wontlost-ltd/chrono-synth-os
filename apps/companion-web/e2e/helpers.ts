import type { Page } from '@playwright/test';

/**
 * E2E 公用：mock /auth/login 并登录进 authed 外壳（不依赖真后端）。
 *
 * companion-web 的 tab（含 Edge 徽章所在的 Home、语音所在的 Perceive）都在登录门之后；
 * 但 Edge Worker 自检与语音 ASR 都是**纯客户端**，不需要真后端。这里用 page.route 把
 * /auth/login 回成前端期望的 { data: { accessToken, tenantId } } 形状，再走真实 login() 流程。
 */
export async function mockLoginAndEnter(page: Page): Promise<void> {
  await page.route('**/api/v1/auth/login', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: { accessToken: 'e2e-token', tenantId: 'e2e-tenant' } }),
    });
  });

  /* mock /companion/me：Home tab 默认加载它；失败会让 HomeView 渲染错误态、连带 EdgeRuntimeBadge
   * 也不渲染（徽章在 HomeView 内）。返回契约 CompanionMeV1（.strict()，字段须精确）。 */
  await page.route('**/api/v1/companion/me', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data: {
          schemaVersion: 'companion-me.v1',
          narrative: '我还在认识这个世界。',
          topValues: [],
          recentMemories: [],
          valueCount: 0,
          memoryCount: 0,
        },
      }),
    });
  });

  await page.goto('/');
  /* 登录页：填邮箱/密码 → 提交 → emit() 切到 authed 外壳。用可访问名定位（label>span 文本即
   * input 的 accessible name），避免脆弱选择器。 */
  await page.getByLabel('邮箱').fill('e2e@test.com');
  await page.getByLabel('密码').fill('password123');
  await page.getByRole('button', { name: '登录' }).click();
  /* 等 authed 外壳出现（主导航 tablist），确保已离开登录页。 */
  await page.getByRole('tablist', { name: '主导航' }).waitFor();
}
