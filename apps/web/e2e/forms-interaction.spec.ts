/**
 * 全量表单/输入框/链接/弹窗交互 E2E —— 真浏览器逐路由穷举交互。
 *
 * 起因：用户手动发现 Publish Marketplace Task 弹窗里输入框「光标跳到关闭按钮、无法输入」
 * （共享 Modal.tsx 焦点抢夺 bug，db49356 已修）。既有 e2e 只验渲染/导航，没真正进每个 form
 * 逐字符输入、逐弹窗检查焦点——本 spec 补上这层穷举交互审计，并作为永久回归守卫：
 *   - 每个 input/textarea：能聚焦 + 输入触发 re-render 后焦点不被抢（焦点 bug 类）
 *   - 每个 <a href>：非空/非占位（#、javascript:）
 *   - 每个看起来开弹窗的按钮：弹窗初始焦点落在表单字段而非关闭按钮，且弹窗内输入焦点稳定
 *
 * 约定沿用 axe-routes.spec：localStorage 注入 admin 会话 + page.route mock 空数据。
 */
import { test, expect, type Page } from '@playwright/test';

const SESSION_STATE = JSON.stringify({
  apiKey: 'forms-test-api-key',
  tenantId: 'default',
  mode: 'authenticated',
  user: { id: 'forms-test-user', email: 'forms@example.test', role: 'admin' },
});

async function seedSession(page: Page) {
  /*
   * 用 addInitScript 在**每次导航的页面 JS 运行前**写 localStorage——session store 的 load()
   * 在模块导入时读 localStorage，若用 goto+evaluate 后写，SPA 客户端路由不会重新 init 模块，
   * isAuthenticated 仍为 false → 内容渲染成登录页（即便 URL 是目标路由）。addInitScript 保证
   * load() 一定读到已注入的会话。
   */
  await page.addInitScript((value) => {
    localStorage.setItem('chrono-session', value);
    localStorage.setItem('chrono.user.welcome-seen', 'true');
    /* changelog last-seen 必须**精确等于**最新版本才不自动弹抽屉（逻辑是 seen !== latest）；
     * 设更高版本号无效。与 workforce-console.spec 约定一致。 */
    localStorage.setItem('chrono.changelog.last-seen.v1', '2026.05.0');
  }, SESSION_STATE);
}

/** 最小 mock：让各路由渲染（空数据），不走真实后端。 */
async function mockApisEmpty(page: Page) {
  const empty = (body: unknown) => ({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: body }) });
  await page.route('**/api/v1/**', (route) => {
    const url = route.request().url();
    // 列表类返回空数组，单对象类返回 null/对象——统一空 data，足够渲染空状态
    if (/personas|avatars|simulations|values|marketplace|conflicts|tool-permissions|tool-invocations|agency-authorizations|confirmations|plans|knowledge-sources|usage|tasks|categories/.test(url)) {
      return route.fulfill(empty([]));
    }
    return route.fulfill(empty(null));
  });
}

/** 逐 input 焦点稳定性审计（在页面上下文执行）。返回发现的问题列表。 */
async function auditFocusStability(page: Page, ctx: string): Promise<string[]> {
  return page.evaluate(async (context) => {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const issues: string[] = [];
    /* 在弹窗审计场景优先取真正的 modal（aria-modal），避免误抓常驻的响应式 nav-drawer dialog。 */
    const root: Document | Element = document.querySelector('[role=dialog][aria-modal="true"]') ?? document;
    const fields = [...root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
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
      setter.call(f, (f as HTMLInputElement).type === 'number' ? '5' : orig + 'x');
      f.dispatchEvent(new Event('input', { bubbles: true }));
      await sleep(80); // 等 React re-render
      if (document.activeElement !== f) issues.push(`[${context}] 输入后焦点被抢: ${label}`);
      setter.call(f, orig);
      f.dispatchEvent(new Event('input', { bubbles: true }));
    }
    return issues;
  }, ctx);
}

/** 链接有效性审计。 */
async function auditLinks(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const bad: string[] = [];
    for (const a of document.querySelectorAll('a[href]')) {
      const h = a.getAttribute('href') || '';
      if (h === '#' || h === '' || h.startsWith('javascript:')) bad.push(`空/占位链接: "${(a.textContent || '').trim().slice(0, 25)}" → ${h}`);
    }
    return bad;
  });
}

const ROUTES = [
  '/dashboard', '/simulations', '/simulations/new', '/avatars', '/persona-core',
  '/values', '/knowledge-sources', '/marketplace', '/conflicts', '/growth',
  '/billing', '/settings', '/system', '/admin/tool-permissions',
  '/admin/agency-authorizations', '/admin/config',
];

for (const path of ROUTES) {
  test(`交互审计: ${path}（输入焦点稳定 + 链接有效）`, async ({ page }) => {
    await seedSession(page);
    await mockApisEmpty(page);
    await page.goto(path);
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(250);

    /* 防假绿：必须真的渲染了 authed 外壳（侧栏 Logout），而非在目标 URL 下显示登录表单。 */
    await expect(page, `应停留在 ${path} 而非被踢回 login`).not.toHaveURL(/\/login/);
    await expect(page.getByRole('button', { name: /Logout|登出/i }), `${path} 应渲染 authed 外壳`).toBeVisible();

    const focusIssues = await auditFocusStability(page, `page:${path}`);
    const linkIssues = await auditLinks(page);
    expect(focusIssues, focusIssues.join('\n')).toEqual([]);
    expect(linkIssues, linkIssues.join('\n')).toEqual([]);
  });
}

/**
 * 弹窗交互专项（焦点 bug 高发区）：打开 Create/Publish 类按钮的弹窗，断言初始焦点
 * 落在表单字段而非关闭按钮，且弹窗内输入焦点稳定。覆盖用户报告的 Publish Task 场景。
 */
const MODAL_ROUTES: Array<{ path: string; trigger: RegExp }> = [
  { path: '/marketplace', trigger: /Publish Task|发布任务/i },
  { path: '/persona-core', trigger: /Create Persona|创建/i },
];

for (const { path, trigger } of MODAL_ROUTES) {
  test(`弹窗交互审计: ${path} 的 "${trigger.source}" 弹窗（初始焦点+输入稳定）`, async ({ page }) => {
    await seedSession(page);
    await mockApisEmpty(page);
    await page.goto(path);
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(250);

    /* 防假绿：确认在 authed 路由 + 触发按钮真实存在（不存在=失败，不静默跳过）。 */
    await expect(page).not.toHaveURL(/\/login/);
    /* 防御：若 changelog 抽屉/任何浮层仍开着（backdrop 拦点击），先 Esc 关掉。 */
    await page.keyboard.press('Escape');
    await page.waitForTimeout(150);
    const btn = page.getByRole('button', { name: trigger }).first();
    await expect(btn, `触发按钮 ${trigger} 应存在于 ${path}`).toBeVisible();
    await btn.click();
    /* 目标 modal 是 aria-modal=true 的对话框（区别于始终在 DOM 的响应式 nav-drawer dialog）。 */
    const dialog = page.locator('[role=dialog][aria-modal="true"]');
    await expect(dialog).toBeVisible();

    /* 初始焦点必须落在表单字段（input/textarea），不得停在关闭按钮（焦点 bug 回归） */
    const activeTag = await page.evaluate(() => document.activeElement?.tagName ?? '');
    const activeIsField = activeTag === 'INPUT' || activeTag === 'TEXTAREA' || activeTag === 'SELECT';
    expect(activeIsField, `弹窗初始焦点应在表单字段，实际在 ${activeTag}`).toBeTruthy();

    /* 弹窗内每个输入框焦点稳定 */
    const issues = await auditFocusStability(page, `modal:${path}`);
    expect(issues, issues.join('\n')).toEqual([]);
  });
}
