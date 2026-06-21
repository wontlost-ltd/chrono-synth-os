import { test, expect, type Page } from '@playwright/test';

/**
 * 数字员工组织治理控制台真浏览器 E2E（E2/E3 前端，含 M2 版本展示 + C 链 SLA 信号）。
 *
 * 与 apps/web 既有 E2E 约定一致：mock 后端路由（page.route），只验证**前端行为**——
 * 查看 tab（组织图 + 运营人格信号 + SLA）+ 操作 tab（发起目标表单 + 待审批 approve/reject 二次确认）。
 * AdminOnly 路由：用 chrono-session(localStorage) 注入 admin 会话进入 /workforce。
 */

const ORG_ID = 'org-1';

/** 注入 admin 会话（AdminOnly 读 session.user.role；accessToken 不持久化，故用 apiKey 驱动 isAuthenticated）。 */
async function seedAdminSession(page: Page) {
  await page.goto('/login');
  await page.evaluate(() => {
    /* chrono-session 持久化字段：apiKey/tenantId/mode/user（accessToken 仅内存不持久化）。
     * isAuthenticated = !!(accessToken || apiKey) → 用 apiKey 让会话生效；role=admin 过 AdminOnly。 */
    localStorage.setItem('chrono-session', JSON.stringify({
      apiKey: 'test-admin-key',
      tenantId: 'default',
      mode: 'demo',
      user: { role: 'admin', userId: 'u-admin', email: 'admin@test.com' },
    }));
    /* 抑制会拦截点击的引导浮层：WelcomeIntro 浮层 + ChangelogDrawer 自动打开抽屉。 */
    localStorage.setItem('chrono.user.welcome-seen', 'true');
    localStorage.setItem('chrono.changelog.last-seen.v1', '2026.05.0');
  });
}

/** mock 工作台只读 + 动作路由（与后端 E2E 同形 { data: ... }）。 */
async function mockWorkforce(page: Page, opts: { pendingApprovals?: unknown[] } = {}) {
  const json = (data: unknown, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify({ data }) });

  /* goal-types：含 M2 版本 + 来源。 */
  await page.route('**/api/v1/workforce/goal-types', (r) => r.fulfill(json([
    { goalType: 'content_piece', qualityRubric: [{ dimension: '准确性', description: 'x' }], playbookVersion: 1, provenance: 'reference' },
  ])));
  /* 组织图：一个数字员工。 */
  await page.route(`**/api/v1/workforce/orgs/${ORG_ID}/chart`, (r) => r.fulfill(json({
    orgId: ORG_ID,
    positions: [{ id: 'pos', orgId: ORG_ID, title: '数字主编', jobFamily: 'manager', seniority: 'lead', roleCode: 'managing_editor' }],
    reportingEdges: [],
    workers: [{ id: 'w1', orgId: ORG_ID, personaId: 'p', positionId: 'pos', displayName: '主编一号', employmentStatus: 'active' }],
  })));
  /* 目标 GET 列表 / POST 发起分流：GET 返回列表；POST 返回 RunGoalResult（与后端形状一致）。 */
  await page.route(`**/api/v1/workforce/orgs/${ORG_ID}/goals`, (r) => {
    if (r.request().method() === 'POST') {
      return r.fulfill(json({ goalId: 'g-new', taskCount: 4, reportCount: 5, executiveSummary: 'ok', accountableStages: 4, attributableSteps: 6, pendingRealExecution: 1, goalStatus: 'active', playbookVersion: 1 }, 201));
    }
    return r.fulfill(json([
      { id: 'g1', orgId: ORG_ID, ownerWorkerId: 'w1', title: '咖啡指南', description: '', goalType: 'content_piece', status: 'active', playbookVersion: 1, createdAt: 1, updatedAt: 1 },
    ]));
  });
  /* 人格信号束（C 链：含 SLA 逾期/临期）。 */
  await page.route(`**/api/v1/workforce/orgs/${ORG_ID}/workers/w1/persona-signal`, (r) => r.fulfill(json({
    workerId: 'w1', decisionConfidence: 'high', confidenceRationale: '稳定交付', collaborationReach: 2, shouldReport: false,
    operating: { workerId: 'w1', activeTaskCount: 1, deliveredTaskCount: 3, blockedTaskCount: 0, highRiskTaskCount: 0, overdueTaskCount: 1, dueSoonTaskCount: 0, load: 'heavy', needsAttention: true },
  })));
  /* 待审批列表。 */
  await page.route(`**/api/v1/workforce/orgs/${ORG_ID}/approvals/pending`, (r) => r.fulfill(json(opts.pendingApprovals ?? [])));
}

/** 进控制台并输入 org（提交后触发查询）。 */
async function openConsole(page: Page) {
  await page.goto('/workforce');
  /* AdminOnly 通过 → 看到标题；否则被重定向到 /dashboard。 */
  await expect(page.getByRole('heading', { name: '数字员工组织' })).toBeVisible();
  await page.getByPlaceholder('输入组织 ID').fill(ORG_ID);
  /* 顶部「查看」按钮提交 org。 */
  await page.getByRole('button', { name: '查看', exact: true }).click();
}

test.describe('数字员工组织控制台 E2E', () => {
  test('未认证 → 重定向到 /login', async ({ page }) => {
    await page.goto('/workforce');
    await expect(page).toHaveURL(/\/login/);
  });

  test('admin 进控制台：查看 tab 渲染数字员工 + 运营人格信号 + SLA 逾期', async ({ page }) => {
    await seedAdminSession(page);
    await mockWorkforce(page);
    await openConsole(page);
    /* 数字员工渲染（DataTable 桌面+移动可能各一份 → first()）。 */
    await expect(page.getByText('主编一号').first()).toBeVisible();
    /* 决策置信度(high) 经 i18n label「决策置信度：」渲染（精确到信号格，避开主题选项的 high-contrast）。 */
    await expect(page.getByText('决策置信度：', { exact: false }).first()).toBeVisible();
    /* C 链 SLA：逾期标记可见（overdueTaskCount=1 → 渲染「逾期 1」）。 */
    await expect(page.getByText(/逾期/).first()).toBeVisible();
  });

  test('操作 tab：发起目标表单 + 待审批区渲染', async ({ page }) => {
    await seedAdminSession(page);
    await mockWorkforce(page, {
      pendingApprovals: [
        { id: 'ap-1', tenantId: 'default', orgId: ORG_ID, subjectType: 'task_execution', subjectId: 't1', requesterWorkerId: 'w1', effectiveRisk: 'high', requiresHuman: true, approvalMode: 'human_only', status: 'pending', approverWorkerId: null, approverUserId: null, reason: '高风险执行', correlationId: null, createdAt: 1, expiresAt: null, decidedAt: null },
      ],
    });
    await openConsole(page);
    /* 切到操作 tab。 */
    await page.getByRole('button', { name: '操作（admin）' }).click();
    /* 发起目标表单（manager id 输入 + 发起按钮）。 */
    await expect(page.getByPlaceholder(/Manager/i).first()).toBeVisible();
    await expect(page.getByRole('button', { name: '发起目标' })).toBeVisible();
    /* 待审批表格：高风险审批可见 + approve 按钮。 */
    await expect(page.getByText('高风险执行').first()).toBeVisible();
    await expect(page.getByRole('button', { name: '批准' }).first()).toBeVisible();
  });

  test('★发起目标 submit★：填表 → 点发起 → POST body 正确 + 成功态(含待执行计数)', async ({ page }) => {
    await seedAdminSession(page);
    await mockWorkforce(page);
    /* 捕获 POST goals 请求体。 */
    const reqPromise = page.waitForRequest((req) =>
      req.method() === 'POST' && req.url().includes(`/workforce/orgs/${ORG_ID}/goals`));
    await openConsole(page);
    await page.getByRole('button', { name: '操作（admin）' }).click();
    /* 填表：manager id + 标题 + 类型下拉。 */
    await page.getByPlaceholder('Manager 数字员工 ID').fill('w-mgr');
    await page.getByPlaceholder('目标标题').fill('咖啡指南E2E');
    /* 页面有多个 combobox(语言/主题/目标类型)；目标类型 select 是唯一含 content_piece option 的那个。 */
    const goalTypeSelect = page.locator('select', { has: page.locator('option[value="content_piece"]') });
    await goalTypeSelect.selectOption('content_piece');
    await page.getByRole('button', { name: '发起目标' }).click();
    /* POST body 正确。 */
    const req = await reqPromise;
    const body = req.postDataJSON() as { managerWorkerId: string; title: string; goalType: string };
    expect(body.managerWorkerId).toBe('w-mgr');
    expect(body.title).toBe('咖啡指南E2E');
    expect(body.goalType).toBe('content_piece');
    /* 成功态：渲染「目标已发起（4 个任务，其中 1 个待真实执行/审批）」。 */
    await expect(page.getByText(/目标已发起/)).toBeVisible();
    await expect(page.getByText(/待真实执行/)).toBeVisible();
  });

  test('★高风险 approve 二次确认★：点批准弹 confirm，取消则不发请求', async ({ page }) => {
    await seedAdminSession(page);
    let decisionCalled = false;
    await mockWorkforce(page, {
      pendingApprovals: [
        { id: 'ap-1', tenantId: 'default', orgId: ORG_ID, subjectType: 'task_execution', subjectId: 't1', requesterWorkerId: 'w1', effectiveRisk: 'high', requiresHuman: true, approvalMode: 'human_only', status: 'pending', approverWorkerId: null, approverUserId: null, reason: '高风险执行', correlationId: null, createdAt: 1, expiresAt: null, decidedAt: null },
      ],
    });
    /* 监听 decision 请求是否发出。 */
    await page.route(`**/api/v1/workforce/orgs/${ORG_ID}/approvals/ap-1/decision`, (r) => {
      decisionCalled = true;
      return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: { id: 'ap-1', status: 'approved' } }) });
    });
    /* 取消 confirm 弹窗。 */
    page.on('dialog', (d) => d.dismiss());
    await openConsole(page);
    await page.getByRole('button', { name: '操作（admin）' }).click();
    await page.getByRole('button', { name: '批准' }).first().click();
    /* 等一拍，确认请求未发出（取消即不批）。 */
    await page.waitForTimeout(300);
    expect(decisionCalled).toBe(false);
  });

  test('★高风险 approve 确认★：accept confirm 后发出 decision 请求', async ({ page }) => {
    await seedAdminSession(page);
    let decisionCalled = false;
    await mockWorkforce(page, {
      pendingApprovals: [
        { id: 'ap-1', tenantId: 'default', orgId: ORG_ID, subjectType: 'task_execution', subjectId: 't1', requesterWorkerId: 'w1', effectiveRisk: 'high', requiresHuman: true, approvalMode: 'human_only', status: 'pending', approverWorkerId: null, approverUserId: null, reason: '高风险执行', correlationId: null, createdAt: 1, expiresAt: null, decidedAt: null },
      ],
    });
    let decisionBody: { decision?: string } = {};
    await page.route(`**/api/v1/workforce/orgs/${ORG_ID}/approvals/ap-1/decision`, (r) => {
      decisionCalled = true;
      decisionBody = (r.request().postDataJSON() ?? {}) as { decision?: string };
      return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: { id: 'ap-1', status: 'approved' } }) });
    });
    page.on('dialog', (d) => d.accept());
    await openConsole(page);
    await page.getByRole('button', { name: '操作（admin）' }).click();
    const reqPromise = page.waitForRequest((req) => req.url().includes('/approvals/ap-1/decision'));
    await page.getByRole('button', { name: '批准' }).first().click();
    await reqPromise;
    expect(decisionCalled).toBe(true);
    expect(decisionBody.decision).toBe('approve');
  });
});
