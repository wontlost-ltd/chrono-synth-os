/**
 * axe 覆盖「默认渲染之外」的两类状态。
 *
 * 既有 axe 套件只走默认渲染路径，于是两块长期无覆盖：
 *
 * 1. **交互态类名**（`group-hover:` / `hover:`）——节点在 DOM 里，但颜色只在
 *    悬停时生效，axe 走过去看到的是静息色。变异测试确认过：把 Dashboard 的
 *    `group-hover:text-primary-text` 改回出问题的 `text-primary`，既有套件
 *    不会变红。
 *
 * 2. **`prefers-color-scheme` 自动暗色路径**——`index.html` 硬编码
 *    `data-theme="dark"`，而选 system 时 `theme.ts` 会 `removeAttribute`，
 *    改走 themes.css 的 `@media (prefers-color-scheme: dark)` 块。该块与显式
 *    dark 块曾是两套颜色（PR #355 才统一），却从没有任何测试走过。
 *
 * 这里只测「颜色对比度」这一维：真正悬停后再跑 axe，以及在 system+OS 暗色
 * 下跑 axe。其余规则由既有套件覆盖，不重复。
 */
import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const SESSION_STATE = JSON.stringify({
  apiKey: 'test-api-key',
  tenantId: 'default',
  mode: 'demo',
  user: null,
});

/** 与 axe-routes.spec.ts 同款空态桩：让登录后页面渲染出骨架而非停在加载中。 */
async function mockApisEmpty(page: Page) {
  await page.route('**/api/v1/**', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ data: [] }),
  }));
}

async function seedSession(page: Page) {
  await page.goto('/login');
  await page.evaluate((value) => {
    localStorage.setItem('chrono-session', value);
    /* WelcomeIntro 首访引导是覆盖全屏的 role="dialog"，会拦截 hover 的指针
     * 事件（实测 locator.hover 直接超时）。置该标志跳过。 */
    localStorage.setItem('chrono.user.welcome-seen', 'true');
  }, SESSION_STATE);
}

/**
 * 关掉 ChangelogDrawer——版本号变化后它会自动弹出一次，同样拦截指针事件。
 *
 * 走 UI 关闭而非预置 localStorage：该组件的判据是
 * `lastSeen !== latest.version` 的**精确相等**（非版本大小比较），
 * 预置任何固定值都会在下次发版后失效。
 */
async function dismissChangelog(page: Page) {
  const overlay = page.locator('.fixed.inset-0.z-50.flex.justify-end');
  /* 它在挂载后的 effect 里才 setOpen(true)，所以要给它一点时间出现，
   * 否则「检查时还没弹、hover 时才弹」会漏关。 */
  await overlay.waitFor({ state: 'visible', timeout: 3_000 }).catch(() => { /* 没弹就不用关 */ });
  if (await overlay.count() === 0) return;
  /* 用 Esc 关闭：组件自身支持（见 ChangelogDrawer 头部注释），
   * 比匹配关闭按钮的选择器更稳，不受 aria-label 文案/i18n 变化影响。 */
  await page.keyboard.press('Escape');
  await overlay.waitFor({ state: 'detached', timeout: 5_000 })
    .catch(() => { /* 兜底：下面的 hover 若仍被挡会自然失败并报出拦截者 */ });
}

/** 只取 color-contrast 违规——本套件专攻颜色维度。 */
async function contrastViolations(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa'])
    .disableRules(['region'])
    .analyze();
  return results.violations.filter(v => v.id === 'color-contrast');
}

function summarize(violations: Awaited<ReturnType<typeof contrastViolations>>) {
  return violations
    .map(v => `[${v.impact}] ${v.id} (${v.nodes.length} nodes)\n` +
      v.nodes.map(n => `    ${n.failureSummary?.split('\n').filter(Boolean).join(' ')}`).join('\n'))
    .join('\n');
}

test.describe('交互态（hover）下的颜色对比度', () => {
  test('Dashboard 卡片标题 group-hover 态通过对比度检查', async ({ page }) => {
    await seedSession(page);
    await mockApisEmpty(page);
    await page.goto('/dashboard');
    await page.waitForLoadState('domcontentloaded');
    await dismissChangelog(page);

    /* 卡片是 <Link class="group">，标题用 group-hover:text-primary-text。
     * 悬停在卡片（而非标题）上才会触发 group-hover。 */
    const card = page.locator('a.group').first();
    await expect(card).toBeVisible();
    await card.hover();
    /* 等 transition-colors 走完，否则 axe 读到的是过渡中间色。 */
    await page.waitForTimeout(400);

    const violations = await contrastViolations(page);
    expect(violations, `Dashboard 卡片 hover 态对比度违规：\n${summarize(violations)}`).toEqual([]);
  });

  test('Breadcrumbs 链接 hover 态通过对比度检查', async ({ page }) => {
    await seedSession(page);
    await mockApisEmpty(page);
    /* /knowledge-sources/create 渲染 Breadcrumbs，且首项是带 to 的链接
     * （Breadcrumbs 对有 to 的项用 hover:text-primary-text）。 */
    await page.goto('/knowledge-sources/create');
    await page.waitForLoadState('domcontentloaded');
    await dismissChangelog(page);

    /* 断言而非 skip：面包屑链接必须存在。用 skip 会让「路由改了、
     * 测试再也没跑过」变成静默通过——那正是本套件要消灭的假绿。 */
    const crumb = page.locator('nav[aria-label] ol a').first();
    await expect(crumb).toBeVisible();

    await crumb.hover();
    await page.waitForTimeout(400);

    const violations = await contrastViolations(page);
    expect(violations, `Breadcrumbs hover 态对比度违规：\n${summarize(violations)}`).toEqual([]);
  });
});

test.describe('prefers-color-scheme 自动暗色路径', () => {
  /* 选 system 时 theme.ts 会 removeAttribute('data-theme')，页面改吃
   * themes.css 的 @media 块——与 index.html 硬编码的 data-theme="dark"
   * 是两条不同的 CSS 路径。 */
  test.use({ colorScheme: 'dark' });

  test('system 主题 + OS 暗色：登录页通过对比度检查', async ({ page }) => {
    await page.goto('/login');
    await page.evaluate(() => localStorage.setItem('chrono.theme', 'system'));
    await page.reload();
    await page.waitForLoadState('domcontentloaded');

    /* 断言确实走到了 @media 路径：data-theme 必须已被移除。
     * 否则这个测试会在显式 dark 下空跑，变成假绿。 */
    await expect(page.locator('html')).not.toHaveAttribute('data-theme', /.+/);

    const violations = await contrastViolations(page);
    expect(violations, `system 暗色登录页对比度违规：\n${summarize(violations)}`).toEqual([]);
  });

  test('system 主题 + OS 暗色：注册页通过对比度检查', async ({ page }) => {
    await page.goto('/register');
    await page.evaluate(() => localStorage.setItem('chrono.theme', 'system'));
    await page.reload();
    await page.waitForLoadState('domcontentloaded');

    await expect(page.locator('html')).not.toHaveAttribute('data-theme', /.+/);

    const violations = await contrastViolations(page);
    expect(violations, `system 暗色注册页对比度违规：\n${summarize(violations)}`).toEqual([]);
  });
});
