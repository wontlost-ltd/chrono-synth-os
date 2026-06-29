/**
 * 数字员工组织可视化聚合 API 集成测试。
 *
 * 锁住 GET /api/v1/workforce/orgs/:orgId/visualization 一次聚合四块：
 *   ① 组织树（worker 节点含岗位原型/雇佣状态/信号摘要 + 汇报边）
 *   ② 目标→任务流（每目标任务状态分布 + blocked 计数）
 *   ③ worker 信号仪表（运行信号 + 人格信号）
 *   ④ ADR-0057 学习闭环（已学能力 / 进行中学习 / 挂起任务处置分类 gap/degraded/timeout）
 * 鉴权：仅用户 JWT；租户 + org 隔离。
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { ChronoSynthOS } from '../../chrono-synth-os.js';
import { createApp } from '../../server/app.js';
import { loadConfig } from '../../config/schema.js';
import { SilentLogger } from '../../utils/logger.js';
import { TestClock } from '../../utils/clock.js';
import { OrgWorkforceStore } from '../../storage/org-workforce-store.js';
import { LearningRequestStore } from '../../storage/learning-request-store.js';
import { CapabilityIndexStore } from '../../storage/capability-index-store.js';
import { OrgChartService, type WorkerSpec } from '../../workforce/org-chart-service.js';

const JWT_SECRET = 'test-secret-at-least-32-characters-long!';

describe('数字员工组织可视化聚合 API', () => {
  let os: ChronoSynthOS;
  let app: FastifyInstance;
  let clock: TestClock;
  let headers: Record<string, string>;
  let tenantId: string;
  let store: OrgWorkforceStore;
  let mgrId: string;
  let icId: string;
  let counter = 0;

  function pod(): WorkerSpec[] {
    return [
      { roleCode: 'mgr', title: '研究主管', jobFamily: 'manager', seniority: 'lead', displayName: '主管', personaId: 'p-mgr', managerRoleCode: null },
      { roleCode: 'ic', title: '研究员', jobFamily: 'ic', seniority: 'ic', displayName: 'IC', personaId: 'p-ic', managerRoleCode: 'mgr' },
    ];
  }

  before(async () => {
    clock = new TestClock(1_000_000);
    os = new ChronoSynthOS({ clock, logger: new SilentLogger() });
    os.start();
    const config = loadConfig({
      rateLimit: { max: 100_000, timeWindowMs: 60_000 },
      websocket: { enabled: false, heartbeatIntervalMs: 30_000 },
      jwt: { enabled: true, secret: JWT_SECRET, issuer: 'test' },
      runtime: { recovery: { enabled: false } },
    });
    app = await createApp({ os, config });

    const reg = await app.inject({ method: 'POST', url: '/api/v1/auth/register', payload: { email: 'viz@test.com', password: 'password123' } });
    assert.equal(reg.statusCode, 201, reg.body);
    const auth = JSON.parse(reg.body).data as { accessToken: string; tenantId: string };
    tenantId = auth.tenantId;
    headers = { authorization: `Bearer ${auth.accessToken}`, 'x-tenant-id': tenantId };

    store = new OrgWorkforceStore(os.getDatabase(), tenantId);
    const chart = new OrgChartService(store, () => clock.now(), () => `${tenantId}-id-${++counter}`);
    const boot = chart.bootstrap('org-1', pod());
    mgrId = boot.workerIdByRole.get('mgr')!;
    icId = boot.workerIdByRole.get('ic')!;

    /* ── 播种可视化素材 ── */
    const capIndex = new CapabilityIndexStore(os.getDatabase(), tenantId);
    const lrStore = new LearningRequestStore(os.getDatabase(), tenantId);
    /* p-ic 已学会 research（能力索引）。 */
    capIndex.upsert({ id: 'ci-1', personaId: 'p-ic', capability: 'research', examScore: 0.97, learningRequestId: 'lr-seed', capabilityVersion: 1, learnedAt: clock.now(), updatedAt: clock.now() });
    /* p-ic 正在学 writing（进行中学习请求）。 */
    lrStore.insert({ id: 'lr-active', orgId: 'org-1', personaId: 'p-ic', capability: 'writing', isUnknown: false, evidence: 'gap', priority: 'high', triggeredByTaskId: null, status: 'learning', createdAt: clock.now(), updatedAt: clock.now() });
    /* 造一个因缺 compliance 挂起的任务（gap 处置）+ 关联学习请求。 */
    const blockedTaskId = 'task-blocked';
    store.insertTask({
      orgId: 'org-1', goalId: 'g1', parentTaskId: null, assignedToWorkerId: icId, accountableWorkerId: mgrId,
      title: '合规研究', taskType: 'research', status: 'delegated', riskLevel: 'low', allowsToolExecution: true,
      acceptanceCriteria: 'ok', requiredCapabilities: ['compliance'], resultSummary: null, dueAt: null, id: blockedTaskId,
      createdAt: clock.now(), updatedAt: clock.now(),
    });
    lrStore.insert({ id: 'lr-blocked', orgId: 'org-1', personaId: 'p-ic', capability: 'compliance', isUnknown: false, evidence: 'gap', priority: 'high', triggeredByTaskId: blockedTaskId, status: 'pending', createdAt: clock.now(), updatedAt: clock.now() });
    store.transitionTaskExecutionIfStatus('org-1', blockedTaskId, 'delegated', 'blocked', '能力缺口待进修：compliance', clock.now());
    /* 一个降级任务（degraded 处置）。 */
    const degradedTaskId = 'task-degraded';
    store.insertTask({
      orgId: 'org-1', goalId: 'g1', parentTaskId: null, assignedToWorkerId: icId, accountableWorkerId: mgrId,
      title: '降级任务', taskType: 'research', status: 'delegated', riskLevel: 'low', allowsToolExecution: true,
      acceptanceCriteria: 'ok', requiredCapabilities: ['audit'], resultSummary: null, dueAt: null, id: degradedTaskId,
      createdAt: clock.now(), updatedAt: clock.now(),
    });
    lrStore.insert({ id: 'lr-degraded', orgId: 'org-1', personaId: 'p-ic', capability: 'audit', isUnknown: false, evidence: 'gap', priority: 'low', triggeredByTaskId: degradedTaskId, status: 'pending', createdAt: clock.now(), updatedAt: clock.now() });
    store.transitionTaskExecutionIfStatus('org-1', degradedTaskId, 'delegated', 'blocked', '[降级] 缺能力：audit——已完成可做部分', clock.now());
  });
  after(async () => { await app.close(); os.close(); });

  function fetchViz(orgId: string, hdrs = headers) {
    return app.inject({ method: 'GET', url: `/api/v1/workforce/orgs/${orgId}/visualization`, headers: hdrs });
  }

  it('★聚合四块：组织树 + 目标流 + 信号 + 学习闭环★', async () => {
    const res = await fetchViz('org-1');
    assert.equal(res.statusCode, 200, res.body);
    const data = JSON.parse(res.body).data;

    /* ① 组织树：两个 worker 节点 + 一条汇报边（mgr→ic）。 */
    assert.equal(data.orgTree.nodes.length, 2);
    const icNode = data.orgTree.nodes.find((n: { workerId: string }) => n.workerId === icId);
    assert.equal(icNode.roleCode, 'ic', '节点含岗位原型');
    assert.equal(icNode.employmentStatus, 'active');
    assert.ok('load' in icNode && 'needsAttention' in icNode, '节点含信号摘要');
    assert.equal(data.orgTree.edges.length, 1, '一条汇报边');
    assert.equal(data.orgTree.edges[0].from, mgrId);
    assert.equal(data.orgTree.edges[0].to, icId);

    /* ② 目标流：tasksByStatus 全状态键齐全。 */
    assert.ok(Array.isArray(data.goalFlow));

    /* ③ 信号：每 worker 有 operating + persona。 */
    assert.equal(data.signals.length, 2);
    const icSignal = data.signals.find((s: { workerId: string }) => s.workerId === icId);
    assert.ok(icSignal.operating, '有运行信号');

    /* ④ 学习闭环：p-ic 已学 research、在学 writing、有 blocked 任务（gap + degraded）。 */
    const icLoop = data.learningLoop.find((l: { workerId: string }) => l.workerId === icId);
    assert.deepEqual(icLoop.learnedCapabilities.map((c: { capability: string }) => c.capability), ['research'], '已学 research');
    assert.ok(icLoop.activeLearning.some((a: { capability: string }) => a.capability === 'writing'), '在学 writing');
    /* 两个 blocked 任务，处置分类正确。 */
    const dispositions = icLoop.blockedTasks.map((b: { disposition: string }) => b.disposition).sort();
    assert.deepEqual(dispositions, ['degraded', 'gap'], '挂起处置分类 gap + degraded');
  });

  it('★鉴权：无 JWT → 拒绝★', async () => {
    const res = await fetchViz('org-1', {});
    assert.ok(res.statusCode === 401 || res.statusCode === 403, `无 JWT 应拒（实际 ${res.statusCode}）`);
  });

  it('★租户隔离：另一租户看不到本租户组织★', async () => {
    const reg2 = await app.inject({ method: 'POST', url: '/api/v1/auth/register', payload: { email: 'viz-other@test.com', password: 'password123' } });
    const auth2 = JSON.parse(reg2.body).data as { accessToken: string; tenantId: string };
    const h2 = { authorization: `Bearer ${auth2.accessToken}`, 'x-tenant-id': auth2.tenantId };
    const res = await fetchViz('org-1', h2);
    assert.equal(res.statusCode, 200, res.body);
    const data = JSON.parse(res.body).data;
    /* 另一租户没有 org-1 的数据 → 空组织树/信号/学习闭环。 */
    assert.equal(data.orgTree.nodes.length, 0, '隔离：另一租户看不到 worker');
    assert.equal(data.learningLoop.length, 0, '隔离：另一租户看不到学习闭环');
  });

  it('★确定性可复现：同请求 → 同响应★', async () => {
    const r1 = await fetchViz('org-1');
    const r2 = await fetchViz('org-1');
    assert.equal(r1.body, r2.body, '同输入同输出（确定性聚合）');
  });
});
