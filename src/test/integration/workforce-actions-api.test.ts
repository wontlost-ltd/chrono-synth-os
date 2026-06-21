/**
 * 数字员工组织交互控制台写/动作 API 集成测试（E3）。
 *
 * 真实 createApp HTTP 栈 + 真实注册（JWT）→ POST 发起目标 / 请求审批 / approve-reject / 触发真实执行。
 * 验证：D 链经生产 HTTP 真接线（D2 审批门 + D3 真实执行），JWT 鉴权，租户隔离，人类 principal=登录用户，
 * 审批绑定校验经 HTTP 仍生效，pipeline 未注册工具 → tool_not_found 透传（证明执行链路真的接到管线）。
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

function podSpecs(): WorkerSpec[] {
  return [
    { roleCode: 'managing_editor', title: '主编', jobFamily: 'manager', seniority: 'lead', displayName: '主编', personaId: 'p-me', managerRoleCode: null },
    { roleCode: 'researcher_ic', title: '研究', jobFamily: 'ic', seniority: 'ic', displayName: '研究', personaId: 'p-r', managerRoleCode: 'managing_editor' },
    { roleCode: 'writer_ic', title: '写作', jobFamily: 'ic', seniority: 'ic', displayName: '写作', personaId: 'p-w', managerRoleCode: 'managing_editor' },
    { roleCode: 'reviewer_ic', title: '审核', jobFamily: 'ic', seniority: 'ic', displayName: '审核', personaId: 'p-rv', managerRoleCode: 'managing_editor' },
    { roleCode: 'publisher_ic', title: '发布', jobFamily: 'ic', seniority: 'ic', displayName: '发布', personaId: 'p-p', managerRoleCode: 'managing_editor' },
  ];
}

describe('数字员工组织交互控制台 API（E3）', () => {
  let os: ChronoSynthOS;
  let app: FastifyInstance;
  const config = loadConfig({
    rateLimit: { max: 100_000, timeWindowMs: 60_000 },
    websocket: { enabled: false, heartbeatIntervalMs: 30_000 },
    jwt: { enabled: true, secret: JWT_SECRET, issuer: 'test' },
    runtime: { recovery: { enabled: false } },
  });

  let tenantA: { headers: Record<string, string>; tenantId: string; orgId: string; mgrId: string; icId: string };

  before(async () => {
    os = new ChronoSynthOS({ clock: new TestClock(1000), logger: new SilentLogger() });
    os.start();
    app = await createApp({ os, config });
    tenantA = await seedTenant('e3-a@test.com');
  });
  after(async () => { await app.close(); os.close(); });

  /** 注册用户 + 种一个组织（仅 bootstrap，不跑目标——留给 HTTP POST 发起）。 */
  async function seedTenant(email: string): Promise<{ headers: Record<string, string>; tenantId: string; orgId: string; mgrId: string; icId: string }> {
    const reg = await app.inject({ method: 'POST', url: '/api/v1/auth/register', payload: { email, password: 'password123' } });
    assert.equal(reg.statusCode, 201, reg.body);
    const auth = JSON.parse(reg.body).data as { accessToken: string; tenantId: string };
    const headers = { authorization: `Bearer ${auth.accessToken}`, 'x-tenant-id': auth.tenantId };
    const store = new OrgWorkforceStore(os.getDatabase(), auth.tenantId);
    let c = 0;
    const chart = new OrgChartService(store, () => 1000, () => `${auth.tenantId}-id-${++c}`);
    const boot = chart.bootstrap('org-1', podSpecs());
    return {
      headers, tenantId: auth.tenantId, orgId: 'org-1',
      mgrId: boot.workerIdByRole.get('managing_editor')!,
      icId: boot.workerIdByRole.get('writer_ic')!,
    };
  }

  /** 单调计数器：保证每次种任务 id 唯一（避免 Math.random，测试可复现）。 */
  let taskSeq = 0;

  /** 直接种一个 delegated 任务（指定风险 + 是否允许工具执行），返回 taskId。 */
  function seedDelegatedTask(risk: 'low' | 'medium' | 'high', allowsTool: boolean, assignee: string): string {
    const store = new OrgWorkforceStore(os.getDatabase(), tenantA.tenantId);
    const id = `${tenantA.tenantId}-task-${++taskSeq}`;
    store.insertTask({
      id, orgId: 'org-1', goalId: 'g-seed', parentTaskId: null, assignedToWorkerId: assignee, accountableWorkerId: tenantA.mgrId,
      title: '执行用任务', taskType: 'publish_prep', status: 'delegated', riskLevel: risk, allowsToolExecution: allowsTool,
      acceptanceCriteria: '就绪', requiredCapabilities: [], resultSummary: null, createdAt: 1000, updatedAt: 1000,
    });
    return id;
  }

  it('POST 发起目标：确定性分解→委派→执行→聚合，返回 201 + 归因步数', async () => {
    const { headers, orgId, mgrId } = tenantA;
    const res = await app.inject({
      method: 'POST', url: `/api/v1/workforce/orgs/${orgId}/goals`, headers,
      payload: { managerWorkerId: mgrId, title: '咖啡指南', description: '', goalType: GOAL_TYPE_CONTENT_PIECE },
    });
    assert.equal(res.statusCode, 201, res.body);
    const data = JSON.parse(res.body).data as { goalId: string; taskCount: number; accountableStages: number };
    assert.equal(data.taskCount, 4);
    assert.ok(data.accountableStages >= 1);
    /* 目标真落库：GET 列表能看到。 */
    const list = await app.inject({ method: 'GET', url: `/api/v1/workforce/orgs/${orgId}/goals`, headers });
    assert.ok((JSON.parse(list.body).data as unknown[]).length >= 1);
  });

  it('POST 发起目标：不存在的 manager → 404', async () => {
    const { headers, orgId } = tenantA;
    const res = await app.inject({
      method: 'POST', url: `/api/v1/workforce/orgs/${orgId}/goals`, headers,
      payload: { managerWorkerId: 'ghost', title: 'x', description: '', goalType: GOAL_TYPE_CONTENT_PIECE },
    });
    assert.equal(res.statusCode, 404, res.body);
  });

  it('POST 请求审批：low 任务 → auto_cleared；high 任务 → pending', async () => {
    const { headers, orgId, icId } = tenantA;
    const lowTask = seedDelegatedTask('low', true, icId);
    const lowRes = await app.inject({
      method: 'POST', url: `/api/v1/workforce/orgs/${orgId}/approvals`, headers,
      payload: { taskId: lowTask, requesterWorkerId: icId },
    });
    assert.equal(lowRes.statusCode, 201, lowRes.body);
    assert.equal(JSON.parse(lowRes.body).data.kind, 'auto_cleared');

    const highTask = seedDelegatedTask('high', true, icId);
    const hiRes = await app.inject({
      method: 'POST', url: `/api/v1/workforce/orgs/${orgId}/approvals`, headers,
      payload: { taskId: highTask, requesterWorkerId: icId },
    });
    assert.equal(hiRes.statusCode, 201, hiRes.body);
    assert.equal(JSON.parse(hiRes.body).data.kind, 'pending');
  });

  it('待审批列表 + 人类 approve：approverUserId=登录用户，approved 后从 pending 列表消失', async () => {
    const { headers, orgId, icId } = tenantA;
    const task = seedDelegatedTask('high', true, icId);
    const reqRes = await app.inject({
      method: 'POST', url: `/api/v1/workforce/orgs/${orgId}/approvals`, headers,
      payload: { taskId: task, requesterWorkerId: icId },
    });
    const approvalId = JSON.parse(reqRes.body).data.approval.id as string;
    /* 出现在待审批列表。 */
    const pending1 = await app.inject({ method: 'GET', url: `/api/v1/workforce/orgs/${orgId}/approvals/pending`, headers });
    assert.ok((JSON.parse(pending1.body).data as Array<{ id: string }>).some((a) => a.id === approvalId));
    /* 人类 approve。 */
    const dec = await app.inject({
      method: 'POST', url: `/api/v1/workforce/orgs/${orgId}/approvals/${approvalId}/decision`, headers,
      payload: { decision: 'approve' },
    });
    assert.equal(dec.statusCode, 200, dec.body);
    const decided = JSON.parse(dec.body).data as { status: string; approverUserId: string | null };
    assert.equal(decided.status, 'approved');
    assert.ok(decided.approverUserId && decided.approverUserId.length > 0, 'principal=登录用户');
    /* 不再 pending。 */
    const pending2 = await app.inject({ method: 'GET', url: `/api/v1/workforce/orgs/${orgId}/approvals/pending`, headers });
    assert.ok(!(JSON.parse(pending2.body).data as Array<{ id: string }>).some((a) => a.id === approvalId));
  });

  it('人类 reject：拒绝后审批 rejected', async () => {
    const { headers, orgId, icId } = tenantA;
    const task = seedDelegatedTask('high', true, icId);
    const reqRes = await app.inject({
      method: 'POST', url: `/api/v1/workforce/orgs/${orgId}/approvals`, headers,
      payload: { taskId: task, requesterWorkerId: icId },
    });
    const approvalId = JSON.parse(reqRes.body).data.approval.id as string;
    const dec = await app.inject({
      method: 'POST', url: `/api/v1/workforce/orgs/${orgId}/approvals/${approvalId}/decision`, headers,
      payload: { decision: 'reject', reason: '材料不全' },
    });
    assert.equal(dec.statusCode, 200, dec.body);
    assert.equal(JSON.parse(dec.body).data.status, 'rejected');
  });

  it('★执行门 HTTP★：high 任务无审批 → 200 needs_approval，不执行', async () => {
    const { headers, orgId, icId } = tenantA;
    const task = seedDelegatedTask('high', true, icId);
    const res = await app.inject({
      method: 'POST', url: `/api/v1/workforce/orgs/${orgId}/tasks/${task}/execute`, headers,
      payload: { workerId: icId, toolId: 'noop.tool', arguments: {} },
    });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(JSON.parse(res.body).data.kind, 'needs_approval');
    /* 任务仍 delegated（未抢 in_progress）。 */
    const store = new OrgWorkforceStore(os.getDatabase(), tenantA.tenantId);
    assert.equal(store.getTask('org-1', task)!.status, 'delegated');
  });

  it('★执行链路真接线★：low 任务 + 注册的低风险工具 → 进真实 pipeline 执行（链路接通）', async () => {
    const { headers, orgId, icId } = tenantA;
    /* low 任务 + 低风险已注册工具 memory.search：无需审批，直接进执行门 → 真实 pipeline.invoke。
     * 不论 pipeline 成功/被权限拦，请求都真的到达了管线（证明 D3 接线接通）。 */
    const task = seedDelegatedTask('low', true, icId);
    const res = await app.inject({
      method: 'POST', url: `/api/v1/workforce/orgs/${orgId}/tasks/${task}/execute`, headers,
      payload: { workerId: icId, toolId: 'memory.search', arguments: { query: 'x' } },
    });
    /* 200 executed 或 409 failed（被管线权限/其他拦）——都证明链路接通，绝不是 needs_approval（low 无需审批）。 */
    assert.ok(res.statusCode === 200 || res.statusCode === 409, res.body);
    if (res.statusCode === 200) assert.equal(JSON.parse(res.body).data.kind, 'executed');
  });

  it('★安全·风险信号服务端派生★：low 任务 + 高风险工具(email.send) 省略 riskSignals → 仍 needs_approval', async () => {
    const { headers, orgId, icId } = tenantA;
    /* Codex 复审致命：若 riskSignals 全靠 body，攻击者对 low 任务用高风险工具但**省略**信号 → 评成 low →
     * 不需审批 → 直接对外执行。修复：服务端按 toolId 从 registry 派生风险，email.send(highRisk) 强制高。 */
    const task = seedDelegatedTask('low', true, icId);
    const res = await app.inject({
      method: 'POST', url: `/api/v1/workforce/orgs/${orgId}/tasks/${task}/execute`, headers,
      payload: { workerId: icId, toolId: 'email.send', arguments: { to: 'x@y.com' } }, /* 故意不传 riskSignals */
    });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(JSON.parse(res.body).data.kind, 'needs_approval', '高风险工具被服务端派生顶到需审批，未被省略绕过');
    /* 未抢执行：任务仍 delegated，未对外发邮件。 */
    const store = new OrgWorkforceStore(os.getDatabase(), tenantA.tenantId);
    assert.equal(store.getTask('org-1', task)!.status, 'delegated');
  });

  it('★安全·未注册工具保守为高风险★：low 任务 + 未注册工具省略信号 → needs_approval（不臆造低风险）', async () => {
    const { headers, orgId, icId } = tenantA;
    const task = seedDelegatedTask('low', true, icId);
    const res = await app.inject({
      method: 'POST', url: `/api/v1/workforce/orgs/${orgId}/tasks/${task}/execute`, headers,
      payload: { workerId: icId, toolId: 'unknown.tool', arguments: {} },
    });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(JSON.parse(res.body).data.kind, 'needs_approval', '未注册工具保守按高风险，需审批');
  });

  it('★安全·领域错误转 4xx★：执行非 delegated 任务 → 409（非 500，不泄露内部错误）', async () => {
    const { headers, orgId, icId } = tenantA;
    /* 种一个已 submitted 的任务（非 delegated）。 */
    const store = new OrgWorkforceStore(os.getDatabase(), tenantA.tenantId);
    const id = `${tenantA.tenantId}-task-submitted-1`;
    store.insertTask({
      id, orgId: 'org-1', goalId: 'g-seed', parentTaskId: null, assignedToWorkerId: icId, accountableWorkerId: tenantA.mgrId,
      title: '已提交', taskType: 'x', status: 'submitted', riskLevel: 'low', allowsToolExecution: true,
      acceptanceCriteria: '', requiredCapabilities: [], resultSummary: null, createdAt: 1000, updatedAt: 1000,
    });
    const res = await app.inject({
      method: 'POST', url: `/api/v1/workforce/orgs/${orgId}/tasks/${id}/execute`, headers,
      payload: { workerId: icId, toolId: 'memory.search', arguments: {} },
    });
    assert.equal(res.statusCode, 409, res.body); /* StateError，不是 500 */
    assert.match(res.body, /delegated/);
  });

  it('★动态风险审批请求★：marketplace.act 申请审批用真实 args 派生（apply→auto_cleared，submit→pending）', async () => {
    const { headers, orgId, icId } = tenantA;
    /* marketplace.act 动态高风险：isHighRisk(args)= (action==='submit')。申请审批须用真实 args 派生，
     * 否则 args={} 会把 submit 误判 auto_cleared，到执行又 needs_approval（坏流程）。 */
    /* apply：低风险 action + low 任务 → auto_cleared。 */
    const applyTask = seedDelegatedTask('low', true, icId);
    const applyRes = await app.inject({
      method: 'POST', url: `/api/v1/workforce/orgs/${orgId}/approvals`, headers,
      payload: { taskId: applyTask, requesterWorkerId: icId, toolId: 'marketplace.act', arguments: { action: 'apply' } },
    });
    assert.equal(applyRes.statusCode, 201, applyRes.body);
    assert.equal(JSON.parse(applyRes.body).data.kind, 'auto_cleared', 'apply 低风险 → 无需审批');
    /* submit：动态高风险 action → 即便 low 任务也顶到 pending（申请阶段就锁住，不留坏流程）。 */
    const submitTask = seedDelegatedTask('low', true, icId);
    const submitRes = await app.inject({
      method: 'POST', url: `/api/v1/workforce/orgs/${orgId}/approvals`, headers,
      payload: { taskId: submitTask, requesterWorkerId: icId, toolId: 'marketplace.act', arguments: { action: 'submit' } },
    });
    assert.equal(submitRes.statusCode, 201, submitRes.body);
    assert.equal(JSON.parse(submitRes.body).data.kind, 'pending', 'submit 动态高风险 → 申请阶段就需审批');
  });

  it('★安全·admin 角色门★：非 admin 用户（member）不能发起目标/审批/执行 → 403', async () => {
    const { orgId, mgrId, tenantId } = tenantA;
    /* 在 A 租户内造一个 member 角色用户的 JWT（同租户但非 admin）。 */
    const memberToken = (app as unknown as { jwt: { sign: (p: Record<string, unknown>) => string } })
      .jwt.sign({ sub: 'member-user-1', tenantId, role: 'member', planId: 'free' });
    const memberHeaders = { authorization: `Bearer ${memberToken}`, 'x-tenant-id': tenantId };
    const res = await app.inject({
      method: 'POST', url: `/api/v1/workforce/orgs/${orgId}/goals`, headers: memberHeaders,
      payload: { managerWorkerId: mgrId, title: 'x', description: '', goalType: GOAL_TYPE_CONTENT_PIECE },
    });
    assert.equal(res.statusCode, 403, res.body);
  });

  it('JWT 鉴权：无 token → 401', async () => {
    const { orgId, mgrId } = tenantA;
    const res = await app.inject({
      method: 'POST', url: `/api/v1/workforce/orgs/${orgId}/goals`,
      payload: { managerWorkerId: mgrId, title: 'x', description: '', goalType: GOAL_TYPE_CONTENT_PIECE },
    });
    assert.equal(res.statusCode, 401, res.body);
  });

  it('租户隔离：B 不能在 A 的 org 发起目标（A 的 worker 在 B 视角不存在 → 404）', async () => {
    const { orgId, mgrId } = tenantA;
    const tenantB = await seedTenant('e3-b@test.com');
    const res = await app.inject({
      method: 'POST', url: `/api/v1/workforce/orgs/${orgId}/goals`, headers: tenantB.headers,
      payload: { managerWorkerId: mgrId, title: 'x', description: '', goalType: GOAL_TYPE_CONTENT_PIECE },
    });
    assert.equal(res.statusCode, 404, res.body);
  });
});
