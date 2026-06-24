/**
 * companion-web 全量 tab/输入框交互 E2E —— 真浏览器逐 tab 穷举交互。
 *
 * 与 apps/web 的同名 spec 同源动机：既有 e2e 只测 Edge/语音，没逐 tab 逐输入框验证焦点稳定。
 * 本 spec 进 authed 外壳后遍历每个 tab，断言：
 *   - 每个 input/textarea 能聚焦 + 输入触发 re-render 后焦点不被抢
 *   - 每个 <a href> 非空/非占位
 *   - 聊天输入框可真实输入并发送（核心交互）
 */
import { test, expect, type Page } from '@playwright/test';
import { mockLoginAndEnter } from './helpers';

/**
 * mock 各 tab 的 companion 端点为合法空数据——否则用 e2e fake token 打真后端会 401，
 * 而前端 401 处理会登出整个会话（切到某 tab 即被踢回登录页）。这里测 UI 交互，不测 auth 过期。
 */
async function mockCompanionTabs(page: Page) {
  const j = (body: unknown) => ({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: body }) });
  // 成长
  await page.route('**/api/v1/companion/me/growth', (r) => r.fulfill(j({
    schemaVersion: 'companion-growth.v1', layers: [], driftHint: null, source: 'none',
  })));
  // 记忆（分页）
  await page.route('**/api/v1/companion/me/memories**', (r) => r.fulfill(j({
    schemaVersion: 'companion-memories.v1', memories: [], page: 1, pageSize: 20, total: 0,
  })));
  // nudges 列表
  await page.route('**/api/v1/companion/me/nudges?**', (r) => r.fulfill(j({
    schemaVersion: 'companion-nudges.v1', nudges: [],
  })));
  await page.route('**/api/v1/companion/me/nudges**', (r) => r.fulfill(j({ schemaVersion: 'companion-nudges.v1', nudges: [] })));
  // SSE nudge 流：返回空事件流，避免挂起/401
  await page.route('**/api/v1/events/stream**', (r) => r.fulfill({ status: 200, contentType: 'text/event-stream', body: '' }));
}

/** 逐 input 焦点稳定性审计（页面上下文）。 */
async function auditFocusStability(page: Page, ctx: string): Promise<string[]> {
  return page.evaluate(async (context) => {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const issues: string[] = [];
    const fields = [...document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
      'input:not([type=hidden]):not([disabled]), textarea:not([disabled])',
    )];
    for (const f of fields) {
      const label = (f.getAttribute('aria-label') || f.getAttribute('name') || f.getAttribute('placeholder') || f.type || 'field').slice(0, 30);
      if (['checkbox', 'radio', 'file'].includes((f as HTMLInputElement).type)) continue;
      f.focus();
      if (document.activeElement !== f) { issues.push(`[${context}] 无法聚焦: ${label}`); continue; }
      const proto = f.tagName.toLowerCase() === 'textarea' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')!.set!;
      const orig = f.value;
      setter.call(f, orig + 'x');
      f.dispatchEvent(new Event('input', { bubbles: true }));
      await sleep(80);
      if (document.activeElement !== f) issues.push(`[${context}] 输入后焦点被抢: ${label}`);
      setter.call(f, orig);
      f.dispatchEvent(new Event('input', { bubbles: true }));
    }
    return issues;
  }, ctx);
}

async function auditLinks(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const bad: string[] = [];
    for (const a of document.querySelectorAll('a[href]')) {
      const h = a.getAttribute('href') || '';
      if (h === '#' || h === '' || h.startsWith('javascript:')) bad.push(`空链接: "${(a.textContent || '').trim().slice(0, 25)}"`);
    }
    return bad;
  });
}

test('全 tab 交互审计：输入焦点稳定 + 链接有效', async ({ page }) => {
  await mockCompanionTabs(page);
  await mockLoginAndEnter(page);
  /* 按元素遍历 tab（不靠精确名字符串，避免空白/i18n 脆弱性）。 */
  const tabs = page.getByRole('tab');
  const count = await tabs.count();
  expect(count, '应有多个 tab').toBeGreaterThanOrEqual(6);

  const allIssues: string[] = [];
  for (let i = 0; i < count; i++) {
    const tab = tabs.nth(i);
    const name = (await tab.textContent() || `tab#${i}`).trim();
    await tab.click();
    await page.waitForTimeout(250);
    /* 切 tab 后 tablist 应仍在（无 tab 切换导致外壳崩溃） */
    await expect(page.getByRole('tablist', { name: '主导航' }), `切到 ${name} 后外壳应保留`).toBeVisible();
    allIssues.push(...await auditFocusStability(page, `tab:${name}`));
    allIssues.push(...await auditLinks(page));
  }
  expect(allIssues, allIssues.join('\n')).toEqual([]);
});

test('聊天输入框可真实输入并发送（核心交互 + 焦点稳定）', async ({ page }) => {
  await mockCompanionTabs(page);
  await mockLoginAndEnter(page);
  /* mock 聊天接口：返回 honest_offline 形状（零-LLM）。 */
  await page.route('**/api/v1/companion/me/chat', async (route) => {
    /* 完整契约 companion-chat-result.v1（含 schemaVersion + confidence:number），否则前端 Zod 拒收。 */
    await route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ data: {
        schemaVersion: 'companion-chat-result.v1',
        reply: '我还不了解这个，先记下了。',
        kind: 'honest_offline',
        groundedMemoryCount: 0,
        confidence: 0,
      } }),
    });
  });
  await page.getByRole('tab', { name: '跟 TA 聊' }).click();
  await page.waitForTimeout(200);

  const input = page.getByRole('textbox', { name: /对数字人说的话|说点什么/i }).first();
  await expect(input).toBeVisible();
  /* 逐字符真实输入（pressSequentially），验证焦点不被抢、值累积 */
  await input.click();
  await input.pressSequentially('你好', { delay: 30 });
  await expect(input).toBeFocused();
  await expect(input).toHaveValue('你好');

  /* 发送按钮启用并可点击 */
  const send = page.getByRole('button', { name: /发送/ });
  await expect(send).toBeEnabled();
  await send.click();
  /* 应出现 persona 应答气泡（honest_offline 文案）；用完整 reply 文本精确匹配避免多元素歧义。 */
  await expect(page.getByText('我还不了解这个，先记下了。')).toBeVisible({ timeout: 5000 });
  /* 发送后输入框清空（值已提交） */
  await expect(input).toHaveValue('');
});
