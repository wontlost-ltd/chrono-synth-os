/**
 * 数字员工组织只读 API 集成测试（E1）。
 *
 * 真实 createApp HTTP 栈 + 真实注册（JWT）→ GET 组织图/目标/任务/汇报。验证：只读暴露正确、
 * JWT 鉴权、租户隔离（别的 tenant 看不到）、不触发任何执行。组织数据用 store 直接种（写 API 留后续切片）。
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

describe('数字员工组织只读 API（E1）', () => {
  let os: ChronoSynthOS;
  let app: FastifyInstance;
  const config = loadConfig({
    rateLimit: { max: 100_000, timeWindowMs: 60_000 },
    websocket: { enabled: false, heartbeatIntervalMs: 30_000 },
    jwt: { enabled: true, secret: JWT_SECRET, issuer: 'test' },
    runtime: { recovery: { enabled: false } },
  });

  /* 两个 tenant（auth register 有 5/min/IP 限流，故只在 before 注册 2 次，全测试复用）。 */
  let tenantA: { headers: Record<string, string>; tenantId: string; orgId: string; goalId: string };
  let tenantB: { headers: Record<string, string>; tenantId: string; orgId: string; goalId: string };

  before(async () => {
    os = new ChronoSynthOS({ clock: new TestClock(1000), logger: new SilentLogger() });
    os.start();
    app = await createApp({ os, config });
    tenantA = await seedTenantOrg('e1-a@test.com');
    tenantB = await seedTenantOrg('e1-b@test.com');
  });
  after(async () => { await app.close(); os.close(); });

  /** 注册一个用户 + 在其 tenant 下种一个组织 + 跑一个目标，返回 auth + orgId + goalId。 */
  async function seedTenantOrg(email: string): Promise<{ headers: Record<string, string>; tenantId: string; orgId: string; goalId: string }> {
    const reg = await app.inject({ method: 'POST', url: '/api/v1/auth/register', payload: { email, password: 'password123' } });
    assert.equal(reg.statusCode, 201, reg.body);
    const auth = JSON.parse(reg.body).data as { accessToken: string; tenantId: string };
    const headers = { authorization: `Bearer ${auth.accessToken}`, 'x-tenant-id': auth.tenantId };
    /* 在该 tenant 的 shared DB 上种组织 + 跑目标（store 直接写；写 API 留后续切片）。 */
    const db = os.getDatabase();
    const store = new OrgWorkforceStore(db, auth.tenantId);
    let c = 0;
    const idg = (): string => `${auth.tenantId}-id-${++c}`;
    const chart = new OrgChartService(store, () => 1000, idg);
    const planning = new OrgPlanningService(store, chart, () => 1000, idg);
    const boot = chart.bootstrap('org-1', podSpecs());
    const res = planning.runGoal('org-1', boot.workerIdByRole.get('managing_editor')!, { title: '咖啡指南', description: '', goalType: GOAL_TYPE_CONTENT_PIECE }, boot.workerIdByRole);
    return { headers, tenantId: auth.tenantId, orgId: 'org-1', goalId: res.goalId };
  }

  it('GET goal-types：返回支持的 goal type + rubric', async () => {
    const { headers } = tenantA;
    const res = await app.inject({ method: 'GET', url: '/api/v1/workforce/goal-types', headers });
    assert.equal(res.statusCode, 200, res.body);
    const data = JSON.parse(res.body).data as Array<{ goalType: string; qualityRubric: unknown[]; playbookVersion: number; provenance: string }>;
    assert.ok(data.some((t) => t.goalType === GOAL_TYPE_CONTENT_PIECE), '含内容运营 goal type');
    assert.ok(data.every((t) => Array.isArray(t.qualityRubric) && t.qualityRubric.length > 0), '每种带 rubric');
    /* M2：暴露 playbook 版本 + 来源。 */
    assert.ok(data.every((t) => t.playbookVersion >= 1 && (t.provenance === 'reference' || t.provenance === 'distilled')), '每种带版本+来源');
  });

  it('GET chart：返回组织图（岗位+员工+汇报关系）', async () => {
    const { headers, orgId } = tenantA;
    const res = await app.inject({ method: 'GET', url: `/api/v1/workforce/orgs/${orgId}/chart`, headers });
    assert.equal(res.statusCode, 200, res.body);
    const data = JSON.parse(res.body).data as { positions: unknown[]; workers: unknown[]; reportingEdges: unknown[] };
    assert.equal(data.positions.length, 5);
    assert.equal(data.workers.length, 5);
    assert.equal(data.reportingEdges.length, 5);
  });

  it('GET goals + goal 详情：目标 + 任务(含契约字段) + 汇报链', async () => {
    const { headers, orgId, goalId } = tenantA;
    const list = await app.inject({ method: 'GET', url: `/api/v1/workforce/orgs/${orgId}/goals`, headers });
    assert.equal(list.statusCode, 200);
    assert.ok((JSON.parse(list.body).data as unknown[]).length >= 1, '至少一个目标');

    const detail = await app.inject({ method: 'GET', url: `/api/v1/workforce/orgs/${orgId}/goals/${goalId}`, headers });
    assert.equal(detail.statusCode, 200, detail.body);
    const data = JSON.parse(detail.body).data as { goal: { status: string }; tasks: Array<{ riskLevel: string; requiredCapabilities: string[] }>; reports: unknown[] };
    /* A↔D 集成：content_piece 含 1 个需真实执行环节(发布)留 delegated → 目标 active（未完成）。 */
    assert.equal(data.goal.status, 'active');
    assert.equal(data.tasks.length, 4, '4 个任务');
    assert.ok(data.tasks.every((t) => ['low', 'medium', 'high'].includes(t.riskLevel)), '任务带 A0 契约字段');
    assert.ok(data.tasks.every((t) => Array.isArray(t.requiredCapabilities)), 'capabilities 序列化为数组');
    assert.equal(data.reports.length, 5, '3 final + 1 就绪 + 1 主管聚合');
  });

  it('不存在的目标 → 404', async () => {
    const { headers, orgId } = tenantA;
    const res = await app.inject({ method: 'GET', url: `/api/v1/workforce/orgs/${orgId}/goals/nope`, headers });
    assert.equal(res.statusCode, 404, res.body);
  });

  it('C0 worker 运行信号：GET signal 返回负载/健康（非心情）', async () => {
    const { headers, orgId, tenantId } = tenantA;
    /* 取一个 worker id（从 chart）。 */
    const chart = await app.inject({ method: 'GET', url: `/api/v1/workforce/orgs/${orgId}/chart`, headers });
    const workers = JSON.parse(chart.body).data.workers as Array<{ id: string }>;
    const workerId = workers[0]!.id;
    const res = await app.inject({ method: 'GET', url: `/api/v1/workforce/orgs/${orgId}/workers/${workerId}/signal`, headers });
    assert.equal(res.statusCode, 200, res.body);
    const signal = JSON.parse(res.body).data as { workerId: string; load: string; needsAttention: boolean };
    assert.equal(signal.workerId, workerId);
    assert.ok(['idle', 'normal', 'heavy'].includes(signal.load), '返回负载等级（非心情）');
    assert.equal(typeof signal.needsAttention, 'boolean');
    /* 不存在的 worker → 404。 */
    const res404 = await app.inject({ method: 'GET', url: `/api/v1/workforce/orgs/${orgId}/workers/ghost/signal`, headers });
    assert.equal(res404.statusCode, 404);
    /* 端点级跨租户隔离（Codex 复审）：tenantB 用 A 的 workerId 调 signal → 404（看不到 A 的 worker）。 */
    assert.ok(tenantId.length > 0);
    const crossTenant = await app.inject({ method: 'GET', url: `/api/v1/workforce/orgs/${orgId}/workers/${workerId}/signal`, headers: tenantB.headers });
    assert.equal(crossTenant.statusCode, 404, '别的 tenant 算不到这个 worker 的信号');
  });

  it('C2 worker 人格信号：GET persona-signal 返回决策置信度/协作广度/汇报标记（非心情）', async () => {
    const { headers, orgId } = tenantA;
    const chart = await app.inject({ method: 'GET', url: `/api/v1/workforce/orgs/${orgId}/chart`, headers });
    const workerId = (JSON.parse(chart.body).data.workers as Array<{ id: string }>)[0]!.id;
    const res = await app.inject({ method: 'GET', url: `/api/v1/workforce/orgs/${orgId}/workers/${workerId}/persona-signal`, headers });
    assert.equal(res.statusCode, 200, res.body);
    const s = JSON.parse(res.body).data as { decisionConfidence: string; collaborationReach: number; shouldReport: boolean; confidenceRationale: string };
    assert.ok(['high', 'medium', 'low'].includes(s.decisionConfidence), '决策置信度（非心情）');
    assert.equal(typeof s.collaborationReach, 'number');
    assert.equal(typeof s.shouldReport, 'boolean');
    assert.ok(s.confidenceRationale.length > 0, '可解释依据');
    /* 不存在 worker → 404；跨租户 → 404。 */
    assert.equal((await app.inject({ method: 'GET', url: `/api/v1/workforce/orgs/${orgId}/workers/ghost/persona-signal`, headers })).statusCode, 404);
    assert.equal((await app.inject({ method: 'GET', url: `/api/v1/workforce/orgs/${orgId}/workers/${workerId}/persona-signal`, headers: tenantB.headers })).statusCode, 404);
  });

  it('租户隔离：别的 tenant 查不到这个 org 的数据', async () => {
    const a = tenantA;
    const b = tenantB;
    /* B 用自己的 JWT 查同名 org-1 的 chart → 只能看到自己种的，不会看到 A 的（同 org-1 名但不同 tenant）。 */
    const res = await app.inject({ method: 'GET', url: `/api/v1/workforce/orgs/${a.orgId}/chart`, headers: b.headers });
    assert.equal(res.statusCode, 200);
    const data = JSON.parse(res.body).data as { workers: unknown[] };
    /* B 自己也种了 org-1，所以看到的是 B 的 5 个 worker，不是 A+B 的 10 个（租户隔离）。 */
    assert.equal(data.workers.length, 5, '只看到自己 tenant 的组织（隔离）');
  });

  it('无 JWT → 拒绝', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/workforce/goal-types' });
    assert.ok(res.statusCode === 401 || res.statusCode === 403, `应拒绝（实际 ${res.statusCode}）`);
  });

  it('API key 主体 → 拒绝（Codex 复审：requireJwtUser 拒 apikey 分支）', async () => {
    /* 用一个 onRequest hook stub 出 apikey 主体的本地 app，验证 requireJwtUser 挡住。 */
    const fastify = (await import('fastify')).default;
    const local = fastify();
    local.addHook('onRequest', async (req) => {
      (req as { user?: unknown }).user = { sub: 'apikey:k1', planId: 'free', role: 'user' };
      (req as { tenantId?: string }).tenantId = 'default';
    });
    const { registerWorkforceRoutes } = await import('../../server/routes/workforce.js');
    registerWorkforceRoutes(local, os.getDatabase(), os.getClock());
    await local.ready();
    try {
      const res = await local.inject({ method: 'GET', url: '/api/v1/workforce/goal-types' });
      assert.equal(res.statusCode, 403, 'apikey 主体被拒');
    } finally { await local.close(); }
  });
});
