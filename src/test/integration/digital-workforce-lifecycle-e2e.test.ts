/**
 * 数字员工组织**全生命周期 E2E**（贯穿 M1→D 链→A/B/C→M2/M3/M5/M7）。
 *
 * 真实 createApp HTTP 栈 + 真实 DB（os.getDatabase）+ 真实时钟（TestClock 可推进）。一条端到端剧本把
 * 所有切片串起来验证它们**协同工作**，而不只各自单测通过：
 *   1. 注册租户(admin) + bootstrap 组织（M1）；
 *   2. 经 HTTP 发起目标 → A↔D 集成：纯推理环节 stub 完成、发布环节(high)留 delegated（A 链/D3）；
 *   3. 经 HTTP 请求审批 → 服务端工具风险派生 → 人类 approve（D2 审批门）；
 *   4. 经 HTTP 触发真实执行（D3，接 ToolInvocationPipeline，绑定审批校验）；
 *   5. 升级链：IC 阻塞 → 沿汇报链 raise/reescalate/resolve（B 链）；
 *   6. 有限自主运营：队列在预算/风险天花板内自主拉起目标、高风险留人类（M5）；
 *   7. 经验蒸馏：多个返工目标 → 确定性产出改进候选（M3，零-LLM）；
 *   8. 战略辅助：人类战略输入 → 确定性多视角备选，恒需人类批准（M7，非自动 CEO）；
 *   9. SLA 时间感知 + 人格信号经 HTTP 读出（C 链）；
 *  10. playbook 版本审计：目标落库 playbook_version（M2）。
 *
 * 路由已接的走 HTTP（goals/approvals/execute/signal/goal-types）；尚无路由的 service（升级/自主/蒸馏/
 * 战略）在**同一真实 DB**上服务层驱动——仍是端到端集成（真 app + 真 DB + 真时钟）。
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
import { OrgPlanningService } from '../../workforce/org-planning-service.js';
import { EscalationService } from '../../workforce/escalation-service.js';
import { OrgAutorunService, type QueuedGoal } from '../../workforce/org-autorun-service.js';
import { PlaybookDistiller } from '../../workforce/playbook-distiller.js';
import { StrategyAdvisoryService, type StrategyInput } from '../../workforce/strategy-advisory-service.js';
import { GOAL_TYPE_CONTENT_PIECE, GOAL_TYPE_DATA_ANALYSIS } from '../../workforce/decomposition-playbook.js';

const JWT_SECRET = 'test-secret-at-least-32-characters-long!';

/* 同时含内容运营(发布 high) + 数据分析岗位的 pod，覆盖多 goalType / 多风险档。 */
function podSpecs(): WorkerSpec[] {
  return [
    { roleCode: 'managing_editor', title: '主编', jobFamily: 'manager', seniority: 'lead', displayName: '主编', personaId: 'p-me', managerRoleCode: null },
    { roleCode: 'researcher_ic', title: '研究', jobFamily: 'ic', seniority: 'ic', displayName: '研究', personaId: 'p-r', managerRoleCode: 'managing_editor' },
    { roleCode: 'writer_ic', title: '写作', jobFamily: 'ic', seniority: 'ic', displayName: '写作', personaId: 'p-w', managerRoleCode: 'managing_editor' },
    { roleCode: 'reviewer_ic', title: '审核', jobFamily: 'ic', seniority: 'ic', displayName: '审核', personaId: 'p-rv', managerRoleCode: 'managing_editor' },
    { roleCode: 'publisher_ic', title: '发布', jobFamily: 'ic', seniority: 'ic', displayName: '发布', personaId: 'p-p', managerRoleCode: 'managing_editor' },
    { roleCode: 'analyst_lead_ic', title: '分析负责', jobFamily: 'ic', seniority: 'ic', displayName: '分析负责', personaId: 'p-al', managerRoleCode: 'managing_editor' },
    { roleCode: 'data_eng_ic', title: '数据', jobFamily: 'ic', seniority: 'ic', displayName: '数据', personaId: 'p-de', managerRoleCode: 'managing_editor' },
    { roleCode: 'analyst_ic', title: '分析', jobFamily: 'ic', seniority: 'ic', displayName: '分析', personaId: 'p-a', managerRoleCode: 'managing_editor' },
    { roleCode: 'reporter_ic', title: '报告', jobFamily: 'ic', seniority: 'ic', displayName: '报告', personaId: 'p-rp', managerRoleCode: 'managing_editor' },
  ];
}

describe('数字员工组织全生命周期 E2E（M1→D→A/B/C→M2/M3/M5/M7）', () => {
  let os: ChronoSynthOS;
  let app: FastifyInstance;
  let clock: TestClock;
  const config = loadConfig({
    rateLimit: { max: 100_000, timeWindowMs: 60_000 },
    websocket: { enabled: false, heartbeatIntervalMs: 30_000 },
    jwt: { enabled: true, secret: JWT_SECRET, issuer: 'test' },
    runtime: { recovery: { enabled: false } },
  });

  let ctx: {
    headers: Record<string, string>;
    tenantId: string;
    orgId: string;
    workerIdByRole: ReadonlyMap<string, string>;
    mgrId: string;
    writerId: string;
  };

  before(async () => {
    clock = new TestClock(1_000_000);
    os = new ChronoSynthOS({ clock, logger: new SilentLogger() });
    os.start();
    app = await createApp({ os, config });

    /* 注册 admin 租户（第一个注册用户=admin，可走治理写路由）。 */
    const reg = await app.inject({ method: 'POST', url: '/api/v1/auth/register', payload: { email: 'e2e-lifecycle@test.com', password: 'password123' } });
    assert.equal(reg.statusCode, 201, reg.body);
    const auth = JSON.parse(reg.body).data as { accessToken: string; tenantId: string };
    const headers = { authorization: `Bearer ${auth.accessToken}`, 'x-tenant-id': auth.tenantId };

    /* bootstrap 组织（M1）。 */
    const store = new OrgWorkforceStore(os.getDatabase(), auth.tenantId);
    let c = 0;
    const chart = new OrgChartService(store, () => clock.now(), () => `${auth.tenantId}-id-${++c}`);
    const boot = chart.bootstrap('org-1', podSpecs());
    ctx = {
      headers, tenantId: auth.tenantId, orgId: 'org-1',
      workerIdByRole: boot.workerIdByRole,
      mgrId: boot.workerIdByRole.get('managing_editor')!,
      writerId: boot.workerIdByRole.get('writer_ic')!,
    };
  });
  after(async () => { await app.close(); os.close(); });

  const storeNow = (): OrgWorkforceStore => new OrgWorkforceStore(os.getDatabase(), ctx.tenantId);

  it('① M1+M2+A↔D：HTTP 发起内容目标 → 纯推理 stub 完成、发布环节留 delegated、落库 playbook 版本', async () => {
    const res = await app.inject({
      method: 'POST', url: `/api/v1/workforce/orgs/${ctx.orgId}/goals`, headers: ctx.headers,
      payload: { managerWorkerId: ctx.mgrId, title: '咖啡指南E2E', description: '', goalType: GOAL_TYPE_CONTENT_PIECE },
    });
    assert.equal(res.statusCode, 201, res.body);
    const data = JSON.parse(res.body).data as { goalId: string; taskCount: number; pendingRealExecution: number; goalStatus: string; playbookVersion: number };
    assert.equal(data.taskCount, 4);
    /* A↔D：发布环节(high+allowsTool)留 delegated 待真实执行 → goal active。 */
    assert.equal(data.pendingRealExecution, 1);
    assert.equal(data.goalStatus, 'active');
    /* M2：落库 playbook 版本。 */
    assert.equal(data.playbookVersion, 1);
    assert.equal(storeNow().getGoal('org-1', data.goalId)!.playbookVersion, 1);

    /* 详情：3 纯推理 submitted + 1 发布 delegated。 */
    const detail = await app.inject({ method: 'GET', url: `/api/v1/workforce/orgs/${ctx.orgId}/goals/${data.goalId}`, headers: ctx.headers });
    const tasks = JSON.parse(detail.body).data.tasks as Array<{ id: string; status: string; allowsToolExecution: boolean; assignedToWorkerId: string }>;
    const pub = tasks.find((t) => t.allowsToolExecution)!;
    assert.equal(pub.status, 'delegated');
    assert.equal(tasks.filter((t) => t.status === 'submitted').length, 3);
    /* 存到 ctx 供后续步骤复用（发布环节任务 + 其执行者）。 */
    (ctx as { pubTaskId?: string; pubWorkerId?: string }).pubTaskId = pub.id;
    (ctx as { pubTaskId?: string; pubWorkerId?: string }).pubWorkerId = pub.assignedToWorkerId;
  });

  it('② D2+D3：HTTP 请求审批(high→pending) → 人类 approve → 触发真实执行(接管线，写回 submitted/blocked)', async () => {
    const pubTaskId = (ctx as { pubTaskId?: string }).pubTaskId!;
    const pubWorkerId = (ctx as { pubWorkerId?: string }).pubWorkerId!;
    /* 请求审批（任务本身 high → pending，需人类）。 */
    const apRes = await app.inject({
      method: 'POST', url: `/api/v1/workforce/orgs/${ctx.orgId}/approvals`, headers: ctx.headers,
      payload: { taskId: pubTaskId, requesterWorkerId: pubWorkerId },
    });
    assert.equal(apRes.statusCode, 201, apRes.body);
    const ap = JSON.parse(apRes.body).data;
    assert.equal(ap.kind, 'pending');
    /* 待审批列表能看到。 */
    const pending = await app.inject({ method: 'GET', url: `/api/v1/workforce/orgs/${ctx.orgId}/approvals/pending`, headers: ctx.headers });
    assert.ok((JSON.parse(pending.body).data as Array<{ id: string }>).some((a) => a.id === ap.approval.id));
    /* 人类 approve（principal=登录用户）。 */
    const dec = await app.inject({
      method: 'POST', url: `/api/v1/workforce/orgs/${ctx.orgId}/approvals/${ap.approval.id}/decision`, headers: ctx.headers,
      payload: { decision: 'approve' },
    });
    assert.equal(dec.statusCode, 200, dec.body);
    assert.equal(JSON.parse(dec.body).data.status, 'approved');
    assert.ok(JSON.parse(dec.body).data.approverUserId.length > 0, 'principal=登录用户');

    /* 触发真实执行（D3，接 ToolInvocationPipeline；用注册的低风险工具 memory.search 走通管线）。 */
    const exec = await app.inject({
      method: 'POST', url: `/api/v1/workforce/orgs/${ctx.orgId}/tasks/${pubTaskId}/execute`, headers: ctx.headers,
      payload: { workerId: pubWorkerId, toolId: 'memory.search', arguments: { query: 'x' }, approvalId: ap.approval.id },
    });
    /* 经审批门进真实管线：200 executed(submitted) 或 409 管线失败(blocked)——绝非 needs_approval。 */
    assert.ok(exec.statusCode === 200 || exec.statusCode === 409, exec.body);
    const after = storeNow().getTask('org-1', pubTaskId)!;
    if (exec.statusCode === 200) {
      assert.equal(JSON.parse(exec.body).data.kind, 'executed');
      assert.equal(after.status, 'submitted');
    } else {
      assert.equal(after.status, 'blocked');
    }
  });

  it('②b D3 分支：high 任务无审批 → needs_approval(不执行,留 delegated)；reject 的审批不放行', async () => {
    const store = storeNow();
    /* 种一个新的 high + 允许工具的 delegated 任务（独立于①的发布任务）。 */
    const taskId = `${ctx.tenantId}-d3b-task`;
    store.insertTask({
      id: taskId, orgId: 'org-1', goalId: 'g-d3b', parentTaskId: null, assignedToWorkerId: ctx.writerId,
      accountableWorkerId: ctx.mgrId, title: '高风险待审', taskType: 'publish_prep', status: 'delegated', riskLevel: 'high',
      allowsToolExecution: true, acceptanceCriteria: '', requiredCapabilities: [], resultSummary: null,
      dueAt: null, createdAt: clock.now(), updatedAt: clock.now(),
    });
    /* 无 approvalId 执行 → 200 needs_approval，不抢 in_progress，仍 delegated。 */
    const noAp = await app.inject({
      method: 'POST', url: `/api/v1/workforce/orgs/${ctx.orgId}/tasks/${taskId}/execute`, headers: ctx.headers,
      payload: { workerId: ctx.writerId, toolId: 'memory.search', arguments: {} },
    });
    assert.equal(noAp.statusCode, 200, noAp.body);
    assert.equal(JSON.parse(noAp.body).data.kind, 'needs_approval');
    assert.equal(storeNow().getTask('org-1', taskId)!.status, 'delegated', '未执行,仍 delegated');

    /* 请求审批 → 人类 reject → 用 rejected 审批执行不得放行(needs_approval)。 */
    const apRes = await app.inject({
      method: 'POST', url: `/api/v1/workforce/orgs/${ctx.orgId}/approvals`, headers: ctx.headers,
      payload: { taskId, requesterWorkerId: ctx.writerId },
    });
    const ap = JSON.parse(apRes.body).data;
    assert.equal(ap.kind, 'pending');
    const dec = await app.inject({
      method: 'POST', url: `/api/v1/workforce/orgs/${ctx.orgId}/approvals/${ap.approval.id}/decision`, headers: ctx.headers,
      payload: { decision: 'reject', reason: '不批' },
    });
    assert.equal(JSON.parse(dec.body).data.status, 'rejected');
    const execRejected = await app.inject({
      method: 'POST', url: `/api/v1/workforce/orgs/${ctx.orgId}/tasks/${taskId}/execute`, headers: ctx.headers,
      payload: { workerId: ctx.writerId, toolId: 'memory.search', arguments: {}, approvalId: ap.approval.id },
    });
    assert.equal(execRejected.statusCode, 200, execRejected.body);
    assert.equal(JSON.parse(execRejected.body).data.kind, 'needs_approval', 'rejected 审批不放行');
    assert.equal(storeNow().getTask('org-1', taskId)!.status, 'delegated');
  });

  it('③ B 链升级链：IC 阻塞 → raise 给主管 → reescalate（顶层）→ resolve，链可观测', () => {
    const store = storeNow();
    /* 造一个委派给 writer 的阻塞任务。 */
    const taskId = `${ctx.tenantId}-esc-task`;
    store.insertTask({
      id: taskId, orgId: 'org-1', goalId: 'g-esc', parentTaskId: null, assignedToWorkerId: ctx.writerId,
      accountableWorkerId: ctx.mgrId, title: '阻塞', taskType: 'writing', status: 'blocked', riskLevel: 'low',
      allowsToolExecution: false, acceptanceCriteria: '', requiredCapabilities: [], resultSummary: null,
      dueAt: null, createdAt: clock.now(), updatedAt: clock.now(),
    });
    let c = 0;
    const esc = new EscalationService(store, () => clock.now(), () => `${ctx.tenantId}-es-${++c}`, ctx.tenantId);
    /* writer 向直接上级(主编)升级。 */
    const e0 = esc.raise({ orgId: 'org-1', taskId, fromWorkerId: ctx.writerId, reason: '缺资源' });
    assert.equal(e0.toWorkerId, ctx.mgrId, '升给直接上级主编');
    assert.equal(e0.depth, 0);
    /* 主编是根（无上级）→ 不能再升，只能 resolve。 */
    assert.equal(store.getManagerOf('org-1', ctx.mgrId), null, '主编是根');
    assert.throws(() => esc.reescalate('org-1', e0.id, ctx.mgrId, 'x'), /顶层|没有直接上级|不能再升/);
    esc.resolve('org-1', e0.id, ctx.mgrId, '已调配资源');
    assert.equal(store.getEscalation('org-1', e0.id)!.status, 'resolved');
    /* 链可观测。 */
    assert.equal(store.listEscalationsByTask('org-1', taskId).length, 1);
  });

  it('③b B 链多跳升级：三层 subIC→subLead→主编，reescalate 正向上升 depth+1 后 resolve', () => {
    const store = storeNow();
    const ts = clock.now();
    /* 构造三层链：在主编下加一个 subLead，再加一个 subIC 报给 subLead。 */
    store.insertPosition({ id: 'pos-sublead', orgId: 'org-1', title: '副组长', jobFamily: 'manager', seniority: 'senior', roleCode: 'sub_lead', createdAt: ts });
    store.insertPosition({ id: 'pos-subic', orgId: 'org-1', title: '组员', jobFamily: 'ic', seniority: 'ic', roleCode: 'sub_ic', createdAt: ts });
    store.insertWorker({ id: 'w-sublead', orgId: 'org-1', personaId: 'p-sl', positionId: 'pos-sublead', displayName: '副组长', employmentStatus: 'active', createdAt: ts, updatedAt: ts });
    store.insertWorker({ id: 'w-subic', orgId: 'org-1', personaId: 'p-si', positionId: 'pos-subic', displayName: '组员', employmentStatus: 'active', createdAt: ts, updatedAt: ts });
    /* subLead 报给主编；subIC 报给 subLead（solid 链：subIC→subLead→主编）。 */
    store.insertEdge({ id: 'e-sublead', orgId: 'org-1', managerWorkerId: ctx.mgrId, reportWorkerId: 'w-sublead', edgeType: 'solid', createdAt: ts });
    store.insertEdge({ id: 'e-subic', orgId: 'org-1', managerWorkerId: 'w-sublead', reportWorkerId: 'w-subic', edgeType: 'solid', createdAt: ts });
    /* subIC 的阻塞任务。 */
    const taskId = `${ctx.tenantId}-esc3-task`;
    store.insertTask({
      id: taskId, orgId: 'org-1', goalId: 'g-esc3', parentTaskId: null, assignedToWorkerId: 'w-subic',
      accountableWorkerId: 'w-sublead', title: '阻塞3', taskType: 'x', status: 'blocked', riskLevel: 'low',
      allowsToolExecution: false, acceptanceCriteria: '', requiredCapabilities: [], resultSummary: null,
      dueAt: null, createdAt: ts, updatedAt: ts,
    });
    let c = 0;
    const esc = new EscalationService(store, () => clock.now(), () => `${ctx.tenantId}-es3-${++c}`, ctx.tenantId);
    /* subIC raise → subLead(depth 0)。 */
    const e0 = esc.raise({ orgId: 'org-1', taskId, fromWorkerId: 'w-subic', reason: '搞不定' });
    assert.equal(e0.toWorkerId, 'w-sublead', '升给直接上级 subLead');
    assert.equal(e0.depth, 0);
    /* subLead 处理不了 → reescalate → 主编(depth 1, parent=e0)。 */
    const e1 = esc.reescalate('org-1', e0.id, 'w-sublead', '需主编决策');
    assert.equal(e1.toWorkerId, ctx.mgrId, '再升到主编');
    assert.equal(e1.depth, 1);
    assert.equal(e1.parentEscalationId, e0.id);
    assert.equal(store.getEscalation('org-1', e0.id)!.status, 'reescalated', '原标 reescalated');
    /* 主编 resolve 链尾。 */
    esc.resolve('org-1', e1.id, ctx.mgrId, '已拍板');
    assert.equal(store.getEscalation('org-1', e1.id)!.status, 'resolved');
    /* 链可观测：2 跳，depth 0→1。 */
    const chain = store.listEscalationsByTask('org-1', taskId);
    assert.deepEqual(chain.map((x) => x.depth), [0, 1]);
  });

  it('④ M5 有限自主运营：队列在预算/风险天花板内自主拉起，发布(high)目标留人类', () => {
    const store = storeNow();
    let c = 0;
    const chart = new OrgChartService(store, () => clock.now(), () => `${ctx.tenantId}-au-${++c}`);
    const planning = new OrgPlanningService(store, chart, () => clock.now(), () => `${ctx.tenantId}-aug-${++c}`);
    const autorun = new OrgAutorunService(planning, ctx.workerIdByRole);
    const queue: QueuedGoal[] = [
      { managerWorkerId: ctx.mgrId, title: '分析1', description: '', goalType: GOAL_TYPE_DATA_ANALYSIS },
      { managerWorkerId: ctx.mgrId, title: '内容X', description: '', goalType: GOAL_TYPE_CONTENT_PIECE }, /* 含 high 发布 */
      { managerWorkerId: ctx.mgrId, title: '分析2', description: '', goalType: GOAL_TYPE_DATA_ANALYSIS },
    ];
    const r = autorun.runCycle('org-1', queue, { maxGoalsPerCycle: 5, maxAutoRiskLevel: 'medium' });
    assert.equal(r.ranCount, 2, '2 个 data(≤medium) 自主跑');
    assert.equal(r.deferredHighRisk, 1, 'content(含 high 发布)留人类');
    /* 存自主跑出的具体 goalId 供⑨按 id 精确审计（不被⑤蒸馏种子目标掩盖）。 */
    (ctx as { autorunGoalIds?: string[] }).autorunGoalIds = r.outcomes
      .filter((o): o is Extract<typeof o, { kind: 'ran' }> => o.kind === 'ran')
      .map((o) => o.result.goalId);
  });

  it('⑤ M3 经验蒸馏：多个返工目标 → 确定性产出改进候选（零-LLM）', () => {
    const store = storeNow();
    /* 种 6 个 data_analysis v1 目标，extract 环节一半 rejected（返工率高）。 */
    let c = 0;
    for (let i = 0; i < 6; i++) {
      const gid = `${ctx.tenantId}-dist-g-${++c}`;
      store.insertGoal({ id: gid, orgId: 'org-1', ownerWorkerId: ctx.mgrId, title: gid, description: '', goalType: GOAL_TYPE_DATA_ANALYSIS, status: 'completed', playbookVersion: 1, createdAt: clock.now(), updatedAt: clock.now() });
      store.insertTask({ id: `${ctx.tenantId}-dist-t-${++c}`, orgId: 'org-1', goalId: gid, parentTaskId: null, assignedToWorkerId: ctx.writerId, accountableWorkerId: ctx.mgrId, title: 'extract', taskType: 'extract', status: i % 2 === 0 ? 'rejected' : 'approved', riskLevel: 'medium', allowsToolExecution: false, acceptanceCriteria: '', requiredCapabilities: [], resultSummary: null, dueAt: null, createdAt: clock.now(), updatedAt: clock.now() });
    }
    const distiller = new PlaybookDistiller(store);
    const r = distiller.distill('org-1', GOAL_TYPE_DATA_ANALYSIS);
    assert.equal(r.kind, 'candidate', '返工高 → 产出改进候选');
    if (r.kind !== 'candidate') return;
    assert.equal(r.candidate.basedOnVersion, 1);
    assert.equal(r.candidate.proposedVersion, 2);
    const w = r.candidate.weaknesses.find((x) => x.taskType === 'extract')!;
    assert.equal(w.direction, 'tighten_acceptance_criteria');
    /* 确定性：再蒸一次同结果。 */
    assert.deepEqual(distiller.distill('org-1', GOAL_TYPE_DATA_ANALYSIS), r);
  });

  it('⑥ M7 战略辅助：人类战略输入 → 确定性多视角备选，恒需人类批准（非自动 CEO）', () => {
    const svc = new StrategyAdvisoryService();
    const input: StrategyInput = {
      objective: '本季度增长', budgetCap: 100, riskTolerance: 'medium',
      initiatives: [
        { id: 'a', title: '高影响', goalType: GOAL_TYPE_CONTENT_PIECE, priority: 5, impact: 5, feasibility: 2, riskLevel: 'high', estimatedCost: 40 },
        { id: 'b', title: '速赢', goalType: GOAL_TYPE_DATA_ANALYSIS, priority: 3, impact: 3, feasibility: 5, riskLevel: 'low', estimatedCost: 30 },
      ],
    };
    const r = svc.advise(input);
    assert.equal(r.requiresHumanApproval, true, '恒需人类批准');
    assert.equal(r.alternatives.length, 3, '三视角备选');
    /* 影响优先把高影响 a 排前；风险规避把低风险 b 排前。 */
    assert.equal(r.alternatives.find((x) => x.lens === 'impact_first')!.rankedInitiatives[0]!.initiative.id, 'a');
    assert.equal(r.alternatives.find((x) => x.lens === 'risk_averse')!.rankedInitiatives[0]!.initiative.id, 'b');
    /* 确定性。 */
    assert.deepEqual(svc.advise(input), r);
  });

  it('⑦ C 链 SLA + 人格信号：种逾期任务 + 推进时钟 → HTTP 读出真实逾期(overdueTaskCount>0)', async () => {
    const store = storeNow();
    /* 用一个**专用 worker**(researcher)避免与前序步骤数据互染；种一个在手且 due 已过的任务。 */
    const researcherId = ctx.workerIdByRole.get('researcher_ic')!;
    const dueAt = clock.now() + 1000; /* 1 秒后到期 */
    store.insertTask({
      id: `${ctx.tenantId}-sla-task`, orgId: 'org-1', goalId: 'g-sla', parentTaskId: null, assignedToWorkerId: researcherId,
      accountableWorkerId: ctx.mgrId, title: '逾期任务', taskType: 'research', status: 'delegated', riskLevel: 'low',
      allowsToolExecution: false, acceptanceCriteria: '', requiredCapabilities: [], resultSummary: null,
      dueAt, createdAt: clock.now(), updatedAt: clock.now(),
    });
    /* 推进时钟越过截止 → 该在手任务逾期(updatedAt < now 且 due < now)。 */
    clock.advance(5000);

    /* HTTP 读运行信号：真实逾期被算出。 */
    const sig = await app.inject({ method: 'GET', url: `/api/v1/workforce/orgs/${ctx.orgId}/workers/${researcherId}/signal`, headers: ctx.headers });
    assert.equal(sig.statusCode, 200, sig.body);
    const signal = JSON.parse(sig.body).data as { load: string; overdueTaskCount: number; needsAttention: boolean };
    assert.ok(signal.overdueTaskCount >= 1, '真实算出逾期任务');
    assert.equal(signal.needsAttention, true, '有逾期 → 需关注');
    assert.equal(signal.load, 'heavy', '逾期 → heavy');

    /* 人格信号束：逾期 → low 置信度 + 该主动汇报，依据含逾期(不错报「0 个高风险」)。 */
    const ps = await app.inject({ method: 'GET', url: `/api/v1/workforce/orgs/${ctx.orgId}/workers/${researcherId}/persona-signal`, headers: ctx.headers });
    assert.equal(ps.statusCode, 200, ps.body);
    const persona = JSON.parse(ps.body).data as { decisionConfidence: string; shouldReport: boolean; confidenceRationale: string };
    assert.equal(persona.decisionConfidence, 'low');
    assert.equal(persona.shouldReport, true);
    assert.match(persona.confidenceRationale, /逾期/);
  });

  it('⑧ M2 goal-types：HTTP 暴露 playbook 版本 + 来源（versioned rule pack 可审计）', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/workforce/goal-types', headers: ctx.headers });
    assert.equal(res.statusCode, 200, res.body);
    const data = JSON.parse(res.body).data as Array<{ goalType: string; playbookVersion: number; provenance: string }>;
    assert.ok(data.every((t) => t.playbookVersion >= 1 && (t.provenance === 'reference' || t.provenance === 'distilled')));
  });

  it('⑨ 全链审计：goals 列表反映自主运营 + HTTP 发起的目标都落库（端到端因果链完整）', async () => {
    const list = await app.inject({ method: 'GET', url: `/api/v1/workforce/orgs/${ctx.orgId}/goals`, headers: ctx.headers });
    assert.equal(list.statusCode, 200, list.body);
    const goals = JSON.parse(list.body).data as Array<{ id: string; goalType: string; playbookVersion: number }>;
    /* ① HTTP 发起的 content 目标在列表。 */
    assert.ok(goals.some((g) => g.goalType === GOAL_TYPE_CONTENT_PIECE), '含 HTTP 发起的内容目标');
    /* ④ 自主运营跑出的**具体 goalId**都被 HTTP goals 回读（按 id 精确,不被⑤蒸馏种子目标掩盖）。 */
    const autorunIds = (ctx as { autorunGoalIds?: string[] }).autorunGoalIds ?? [];
    assert.equal(autorunIds.length, 2, '④ 自主跑出 2 个目标');
    const goalIds = new Set(goals.map((g) => g.id));
    for (const id of autorunIds) assert.ok(goalIds.has(id), `自主目标 ${id} 经 HTTP 回读`);
    /* 每个目标都带 M2 版本审计字段。 */
    assert.ok(goals.every((g) => g.playbookVersion >= 1));
  });

  it('⑩ 红线：非 admin 用户不能驱动治理动作（同租户 RBAC 经 HTTP 仍生效）', async () => {
    const memberToken = (app as unknown as { jwt: { sign: (p: Record<string, unknown>) => string } })
      .jwt.sign({ sub: 'member-x', tenantId: ctx.tenantId, role: 'member', planId: 'free' });
    const memberHeaders = { authorization: `Bearer ${memberToken}`, 'x-tenant-id': ctx.tenantId };
    const res = await app.inject({
      method: 'POST', url: `/api/v1/workforce/orgs/${ctx.orgId}/goals`, headers: memberHeaders,
      payload: { managerWorkerId: ctx.mgrId, title: 'x', description: '', goalType: GOAL_TYPE_CONTENT_PIECE },
    });
    assert.equal(res.statusCode, 403, res.body);
  });
});
