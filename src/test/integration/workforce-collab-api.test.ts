/**
 * 集成测试：数字员工组织协作接线 API（workforce-collab.ts）——升级/交接/协作消息 + 战略辅助。
 *
 * 证明 4 个此前未接线的 service 经 HTTP 可达且正确：真实 org（三层汇报）+ 真实任务，走 app.inject
 * 端到端跑升级链 raise/resolve、交接 propose/accept、协作 openThread/sendMessage、战略 advise；
 * 校验 admin 鉴权、域错误→HTTP 映射、GET 列表。
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { createMemoryDatabase, runDslSqliteMigrations } from '../../storage/index.js';
import type { IDatabase } from '../../storage/index.js';
import { realClock } from '../../utils/clock.js';
import { OrgWorkforceStore } from '../../storage/org-workforce-store.js';
import { OrgChartService, type WorkerSpec } from '../../workforce/org-chart-service.js';
import { registerWorkforceCollabRoutes } from '../../server/routes/workforce-collab.js';
import { registerErrorHandler } from '../../server/plugins/error-handler.js';

const TENANT = 'tenant-collab';
const ORG = 'org-1';
let mgrId = '';
let icId = '';
let peerId = '';
let taskId = '';

function org(): WorkerSpec[] {
  return [
    { roleCode: 'top', title: '总监', jobFamily: 'exec', seniority: 'exec', displayName: '总监', personaId: 'p-t', managerRoleCode: null },
    { roleCode: 'mgr', title: '主管', jobFamily: 'manager', seniority: 'lead', displayName: '主管', personaId: 'p-m', managerRoleCode: 'top' },
    { roleCode: 'ic', title: 'IC', jobFamily: 'ic', seniority: 'ic', displayName: 'IC', personaId: 'p-i', managerRoleCode: 'mgr' },
    { roleCode: 'peer', title: 'Peer', jobFamily: 'ic', seniority: 'ic', displayName: 'Peer', personaId: 'p-p', managerRoleCode: 'mgr' },
  ];
}

async function buildApp(db: IDatabase, role: 'admin' | 'user' = 'admin'): Promise<FastifyInstance> {
  const fastify = (await import('fastify')).default;
  const app = fastify();
  /* requireRole 依赖 server.jwtEnabled 才真正强制角色（否则非生产透传）——测试显式开启以校验 admin 门。 */
  app.decorate('jwtEnabled', true);
  registerErrorHandler(app);
  app.addHook('onRequest', async (req) => {
    (req as { user?: unknown }).user = { sub: 'user_1', planId: 'enterprise', role };
    (req as { tenantId?: string }).tenantId = TENANT;
  });
  registerWorkforceCollabRoutes(app, db, realClock);
  await app.ready();
  return app;
}

const base = `/api/v1/workforce/orgs/${ORG}`;

describe('数字员工组织协作接线 API（B 链 + M7）', () => {
  let db: IDatabase;
  let app: FastifyInstance;
  let counter = 0;

  beforeEach(async () => {
    db = createMemoryDatabase();
    runDslSqliteMigrations(db);
    const store = new OrgWorkforceStore(db, TENANT);
    counter = 0;
    const chart = new OrgChartService(store, () => 1000, () => `id-${++counter}`);
    const boot = chart.bootstrap(ORG, org());
    mgrId = boot.workerIdByRole.get('mgr')!;
    icId = boot.workerIdByRole.get('ic')!;
    peerId = boot.workerIdByRole.get('peer')!;
    taskId = `task-${++counter}`;
    store.insertTask({
      id: taskId, orgId: ORG, goalId: 'g1', parentTaskId: null, assignedToWorkerId: icId, accountableWorkerId: mgrId,
      title: '阻塞任务', taskType: 'x', status: 'delegated', riskLevel: 'low', allowsToolExecution: false,
      acceptanceCriteria: '', requiredCapabilities: [], resultSummary: null, dueAt: null, createdAt: 1000, updatedAt: 1000,
    });
    app = await buildApp(db);
  });
  afterEach(async () => { await app.close(); db.close(); });

  /* ── B3 升级链 ── */
  it('升级 raise → resolve 全链 + GET 列表', async () => {
    const raise = await app.inject({ method: 'POST', url: `${base}/escalations/raise`, payload: { taskId, fromWorkerId: icId, reason: '缺数据源' } });
    assert.equal(raise.statusCode, 201, raise.body);
    const esc = raise.json().data;
    assert.equal(esc.toWorkerId, mgrId, '升给直接上级');
    assert.equal(esc.status, 'pending');
    /* GET 列出该任务升级。 */
    const list = await app.inject({ method: 'GET', url: `${base}/tasks/${taskId}/escalations` });
    assert.equal(list.statusCode, 200);
    assert.equal(list.json().data.length, 1);
    /* resolve。 */
    const resolve = await app.inject({ method: 'POST', url: `${base}/escalations/${esc.id}/resolve`, payload: { resolvingWorkerId: mgrId, resolution: '已补数据' } });
    assert.equal(resolve.statusCode, 200, resolve.body);
  });

  it('升级 raise：非执行者发起 → 409 状态错', async () => {
    const res = await app.inject({ method: 'POST', url: `${base}/escalations/raise`, payload: { taskId, fromWorkerId: peerId, reason: 'x' } });
    assert.equal(res.statusCode, 409, res.body);
  });

  /* ── B2 交接 ── */
  it('交接 propose → accept：任务转给同事', async () => {
    const propose = await app.inject({ method: 'POST', url: `${base}/handoffs/propose`, payload: { taskId, fromWorkerId: icId, toWorkerId: peerId, reason: '我忙' } });
    assert.equal(propose.statusCode, 201, propose.body);
    const h = propose.json().data;
    assert.equal(h.status, 'proposed');
    const accept = await app.inject({ method: 'POST', url: `${base}/handoffs/${h.id}/accept`, payload: { byWorkerId: peerId } });
    assert.equal(accept.statusCode, 200, accept.body);
    /* GET 列表反映。 */
    const list = await app.inject({ method: 'GET', url: `${base}/tasks/${taskId}/handoffs` });
    assert.equal(list.json().data[0].status, 'accepted');
  });

  it('交接 accept：非 to worker 响应 → 409', async () => {
    const propose = await app.inject({ method: 'POST', url: `${base}/handoffs/propose`, payload: { taskId, fromWorkerId: icId, toWorkerId: peerId } });
    const h = propose.json().data;
    const bad = await app.inject({ method: 'POST', url: `${base}/handoffs/${h.id}/accept`, payload: { byWorkerId: mgrId } });
    assert.equal(bad.statusCode, 409, bad.body);
  });

  /* ── B1 协作消息 ── */
  it('协作 openThread → sendMessage + GET 消息列表', async () => {
    const open = await app.inject({ method: 'POST', url: `${base}/threads`, payload: { threadType: 'coordination', createdByWorkerId: mgrId, taskId } });
    assert.equal(open.statusCode, 201, open.body);
    const thread = open.json().data;
    const send = await app.inject({ method: 'POST', url: `${base}/threads/${thread.id}/messages`, payload: { fromWorkerId: mgrId, toWorkerId: icId, messageType: 'note', content: '进度如何' } });
    assert.equal(send.statusCode, 201, send.body);
    const msgs = await app.inject({ method: 'GET', url: `${base}/threads/${thread.id}/messages` });
    assert.equal(msgs.json().data.length, 1);
    assert.equal(msgs.json().data[0].content, '进度如何');
    /* GET 线程列表。 */
    assert.equal((await app.inject({ method: 'GET', url: `${base}/threads` })).json().data.length, 1);
  });

  it('协作 sendMessage：高治理类型无可追溯 → 400', async () => {
    const open = await app.inject({ method: 'POST', url: `${base}/threads`, payload: { threadType: 'coordination', createdByWorkerId: mgrId } });
    const thread = open.json().data;
    /* request 是高治理类型，线程无 task/goal 绑定且无 correlationId → 拒。 */
    const res = await app.inject({ method: 'POST', url: `${base}/threads/${thread.id}/messages`, payload: { fromWorkerId: mgrId, toWorkerId: icId, messageType: 'request', content: '给我数据' } });
    assert.equal(res.statusCode, 409, res.body);
  });

  it('协作 openThread：绑定伪造 taskId → 409（防伪造可追溯绕高治理门，Codex 复审）', async () => {
    const res = await app.inject({ method: 'POST', url: `${base}/threads`, payload: { threadType: 'coordination', createdByWorkerId: mgrId, taskId: 'ghost-task' } });
    assert.equal(res.statusCode, 409, res.body);
  });

  /* ── M7 战略辅助 ── */
  it('战略 advise：确定性展开多视角备选，恒需人类批准', async () => {
    const payload = {
      objective: '扩大内容产能',
      budgetCap: 100000,
      riskTolerance: 'medium',
      initiatives: [
        { id: 'i1', title: '招写手', goalType: 'content', priority: 1, impact: 4, feasibility: 4, riskLevel: 'low', estimatedCost: 40000 },
        { id: 'i2', title: '买工具', goalType: 'ops', priority: 2, impact: 3, feasibility: 5, riskLevel: 'low', estimatedCost: 20000 },
      ],
    };
    const res = await app.inject({ method: 'POST', url: `${base}/strategy/advise`, payload });
    assert.equal(res.statusCode, 200, res.body);
    const advisory = res.json().data;
    assert.equal(advisory.requiresHumanApproval, true, '恒需人类批准（非自动 CEO）');
    assert.ok(Array.isArray(advisory.alternatives) && advisory.alternatives.length >= 1, '产出多视角备选');
    /* 确定性可复现：同输入同输出。 */
    const res2 = await app.inject({ method: 'POST', url: `${base}/strategy/advise`, payload });
    assert.deepEqual(res2.json().data, advisory, '零-LLM 确定性');
  });

  /* ── 鉴权 ── */
  it('非 admin → 403（治理级操作）', async () => {
    const userApp = await buildApp(db, 'user');
    const res = await userApp.inject({ method: 'POST', url: `${base}/escalations/raise`, payload: { taskId, fromWorkerId: icId, reason: 'x' } });
    assert.equal(res.statusCode, 403, res.body);
    await userApp.close();
  });

  it('非法 body → 400', async () => {
    const res = await app.inject({ method: 'POST', url: `${base}/threads`, payload: { threadType: 'bogus', createdByWorkerId: mgrId } });
    assert.equal(res.statusCode, 400, res.body);
  });
});
