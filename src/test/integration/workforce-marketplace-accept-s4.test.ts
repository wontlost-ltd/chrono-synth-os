/**
 * 组织从任务市场接工单 S4（端到端 HTTP）——admin 接外部市场工单→组织分解委派→完工结算入组织金库。
 *
 * 真实 createApp HTTP 栈 + JWT。验证完整桥接闭环：
 *   POST .../marketplace-tasks/accept   → 建目标（带 sourceMarketplaceTaskId 溯源）+ 确定性分解委派
 *   POST .../marketplace-tasks/:id/settle → 两方分账结算入组织金库（org_wallets），幂等
 * 守红线：接单/结算都是 admin 显式动作（非组织自动）；结算入组织金库非 persona 个人钱包。
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { ChronoSynthOS } from '../../chrono-synth-os.js';
import { createApp } from '../../server/index.js';
import { loadConfig } from '../../config/schema.js';
import { SilentLogger } from '../../utils/logger.js';
import { TestClock } from '../../utils/clock.js';
import { OrgWorkforceStore } from '../../storage/org-workforce-store.js';
import { OrgChartService, type WorkerSpec } from '../../workforce/org-chart-service.js';
import { GOAL_TYPE_CONTENT_PIECE } from '../../workforce/decomposition-playbook.js';

const JWT_SECRET = 'test-secret-at-least-32-characters-long!';

/** content_piece playbook 需要的岗位：researcher_ic/writer_ic/reviewer_ic/publisher_ic 全是 lead 直接下属。 */
function podSpecs(): WorkerSpec[] {
  return [
    { roleCode: 'managing_editor', title: '主编', jobFamily: 'manager', seniority: 'lead', displayName: '主编', personaId: 'p-me', managerRoleCode: null },
    { roleCode: 'researcher_ic', title: '研究', jobFamily: 'ic', seniority: 'ic', displayName: '研究', personaId: 'p-r', managerRoleCode: 'managing_editor' },
    { roleCode: 'writer_ic', title: '写作', jobFamily: 'ic', seniority: 'ic', displayName: '写作', personaId: 'p-w', managerRoleCode: 'managing_editor' },
    { roleCode: 'reviewer_ic', title: '审核', jobFamily: 'ic', seniority: 'ic', displayName: '审核', personaId: 'p-rv', managerRoleCode: 'managing_editor' },
    { roleCode: 'publisher_ic', title: '发布', jobFamily: 'ic', seniority: 'ic', displayName: '发布', personaId: 'p-p', managerRoleCode: 'managing_editor' },
  ];
}

describe('组织从任务市场接工单 S4（端到端 HTTP）', () => {
  let os: ChronoSynthOS;
  let app: FastifyInstance;
  const config = loadConfig({
    rateLimit: { max: 100_000, timeWindowMs: 60_000 },
    websocket: { enabled: false, heartbeatIntervalMs: 30_000 },
    jwt: { enabled: true, secret: JWT_SECRET, issuer: 'test' },
    runtime: { recovery: { enabled: false } },
  });

  let ctx: { headers: Record<string, string>; tenantId: string; orgId: string; mgrId: string };

  before(async () => {
    os = new ChronoSynthOS({ clock: new TestClock(1000), logger: new SilentLogger() });
    os.start();
    app = await createApp({ os, config });
    const reg = await app.inject({ method: 'POST', url: '/api/v1/auth/register', payload: { email: 's4@test.com', password: 'password123' } });
    assert.equal(reg.statusCode, 201, reg.body);
    const auth = JSON.parse(reg.body).data as { accessToken: string; tenantId: string };
    const headers = { authorization: `Bearer ${auth.accessToken}`, 'x-tenant-id': auth.tenantId };
    const store = new OrgWorkforceStore(os.getDatabase(), auth.tenantId);
    let c = 0;
    const chart = new OrgChartService(store, () => 1000, () => `${auth.tenantId}-id-${++c}`);
    const boot = chart.bootstrap('org-1', podSpecs());
    ctx = { headers, tenantId: auth.tenantId, orgId: 'org-1', mgrId: boot.workerIdByRole.get('managing_editor')! };
  });
  after(async () => { await app.close(); os.close(); });

  it('★接工单：建目标（带溯源）+ 确定性分解委派，返回 201★', async () => {
    const { headers, orgId, mgrId } = ctx;
    const res = await app.inject({
      method: 'POST', url: `/api/v1/workforce/orgs/${orgId}/marketplace-tasks/accept`, headers,
      payload: { sourceMarketplaceTaskId: 'mkt-ext-1', managerWorkerId: mgrId, title: '写一篇市场来的稿子', description: '客户工单', goalType: GOAL_TYPE_CONTENT_PIECE },
    });
    assert.equal(res.statusCode, 201, res.body);
    const data = JSON.parse(res.body).data as { goalId: string; taskCount: number; sourceMarketplaceTaskId: string; accountableStages: number };
    assert.equal(data.sourceMarketplaceTaskId, 'mkt-ext-1', '回显源工单 id');
    assert.equal(data.taskCount, 4, 'content_piece 分解 4 步');
    assert.ok(data.accountableStages >= 4, '具名问责环节');

    /* 落库目标带溯源。 */
    const store = new OrgWorkforceStore(os.getDatabase(), ctx.tenantId);
    const goal = store.getGoal(orgId, data.goalId)!;
    assert.equal(goal.sourceMarketplaceTaskId, 'mkt-ext-1', '目标溯源到源工单');
  });

  it('★完工结算：两方分账入组织金库（org_wallets），返回余额★', async () => {
    const { headers, orgId } = ctx;
    const res = await app.inject({
      method: 'POST', url: `/api/v1/workforce/orgs/${orgId}/marketplace-tasks/mkt-ext-1/settle`, headers,
      payload: { totalAmountMinor: 10000, currency: 'CRED', platformPct: 20 },
    });
    assert.equal(res.statusCode, 200, res.body);
    const data = JSON.parse(res.body).data as { settlement: { orgAmountMinor: number; platformAmountMinor: number }; walletBalance: number };
    assert.equal(data.settlement.platformAmountMinor, 2000, '平台抽成 2000');
    assert.equal(data.settlement.orgAmountMinor, 8000, '组织净留存 8000');
    assert.equal(data.walletBalance, 8000, '金库余额 = 组织净留存');

    /* 金库真落在 org_wallets（组织级），不在 persona 个人钱包。 */
    const store = new OrgWorkforceStore(os.getDatabase(), ctx.tenantId);
    assert.equal(store.getOrgWallet(orgId)!.balance, 8000, '组织金库余额');
  });

  it('★结算幂等：同工单 settle 两次 → 余额不翻倍★', async () => {
    const { headers, orgId } = ctx;
    /* mkt-ext-1 上一个测试已结算过；再 settle 一次。 */
    const res = await app.inject({
      method: 'POST', url: `/api/v1/workforce/orgs/${orgId}/marketplace-tasks/mkt-ext-1/settle`, headers,
      payload: { totalAmountMinor: 10000, currency: 'CRED', platformPct: 20 },
    });
    assert.equal(res.statusCode, 200, res.body);
    const data = JSON.parse(res.body).data as { walletBalance: number };
    assert.equal(data.walletBalance, 8000, '幂等：余额仍 8000，未翻倍');
  });

  it('★接未知 goalType → 400（playbook 不存在）★', async () => {
    const { headers, orgId, mgrId } = ctx;
    const res = await app.inject({
      method: 'POST', url: `/api/v1/workforce/orgs/${orgId}/marketplace-tasks/accept`, headers,
      payload: { sourceMarketplaceTaskId: 'mkt-x', managerWorkerId: mgrId, title: 'x', goalType: 'no_such_playbook' },
    });
    assert.equal(res.statusCode, 400, res.body);
  });

  it('★接单 manager 不存在 → 404★', async () => {
    const { headers, orgId } = ctx;
    const res = await app.inject({
      method: 'POST', url: `/api/v1/workforce/orgs/${orgId}/marketplace-tasks/accept`, headers,
      payload: { sourceMarketplaceTaskId: 'mkt-y', managerWorkerId: 'ghost-worker', title: 'x', goalType: GOAL_TYPE_CONTENT_PIECE },
    });
    assert.equal(res.statusCode, 404, res.body);
  });

  it('★无 admin JWT → 拒（鉴权）★', async () => {
    const { orgId } = ctx;
    const res = await app.inject({
      method: 'POST', url: `/api/v1/workforce/orgs/${orgId}/marketplace-tasks/accept`,
      payload: { sourceMarketplaceTaskId: 'mkt-z', managerWorkerId: 'w', title: 'x', goalType: GOAL_TYPE_CONTENT_PIECE },
    });
    assert.ok(res.statusCode === 401 || res.statusCode === 403, `无鉴权应拒，实得 ${res.statusCode}`);
  });

  it('★租户隔离：别的租户看不到本租户金库余额★', async () => {
    /* 另一租户 settle 同 sourceTaskId 到自己的 org → 独立金库，不串。 */
    const reg = await app.inject({ method: 'POST', url: '/api/v1/auth/register', payload: { email: 's4-other@test.com', password: 'password123' } });
    const auth = JSON.parse(reg.body).data as { accessToken: string; tenantId: string };
    const headers2 = { authorization: `Bearer ${auth.accessToken}`, 'x-tenant-id': auth.tenantId };
    const res = await app.inject({
      method: 'POST', url: `/api/v1/workforce/orgs/org-1/marketplace-tasks/mkt-ext-1/settle`, headers: headers2,
      payload: { totalAmountMinor: 50000, currency: 'CRED', platformPct: 20 },
    });
    assert.equal(res.statusCode, 200, res.body);
    const data = JSON.parse(res.body).data as { walletBalance: number };
    /* 另一租户独立金库：40000（50000*0.8），与本租户 8000 不串。 */
    assert.equal(data.walletBalance, 40000, '另一租户独立金库');
    /* 本租户金库仍 8000。 */
    const store = new OrgWorkforceStore(os.getDatabase(), ctx.tenantId);
    assert.equal(store.getOrgWallet('org-1')!.balance, 8000, '本租户金库未受影响');
  });
});
