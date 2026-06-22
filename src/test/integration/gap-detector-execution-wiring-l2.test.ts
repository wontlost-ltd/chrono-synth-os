/**
 * GapDetector → WorkerExecutionService 接线集成测试（ADR-0057 L2/D0.8）。
 *
 * 锁住运行时缺口门：数字员工执行任务前确定性检测能力缺口——缺则**不执行**（不调工具/不抢 in_progress），
 * 登记学习请求 + 挂起任务（learning_required，零-LLM）；学会后无缺口则正常执行。这是「遇缺口登记学习请求，
 * 绝不当场调 LLM 硬答」的运行时落地。
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDatabase } from '../../storage/database.js';
import { runDslSqliteMigrations } from '../../storage/index.js';
import type { IDatabase } from '../../storage/database.js';
import { OrgWorkforceStore } from '../../storage/org-workforce-store.js';
import { LearningRequestStore } from '../../storage/learning-request-store.js';
import { OrgChartService, type WorkerSpec } from '../../workforce/org-chart-service.js';
import { ApprovalService } from '../../workforce/approval-service.js';
import { LearningRequestService } from '../../workforce/learning-request-service.js';
import {
  WorkerExecutionService,
  type ToolExecutor, type ToolInvokeRequest, type ToolInvokeDecision,
} from '../../workforce/worker-execution-service.js';
import type { RiskLevel } from '../../workforce/types.js';

describe('GapDetector→执行接线（ADR-0057 L2/D0.8 运行时缺口门）', () => {
  let db: IDatabase;
  let store: OrgWorkforceStore;
  let lrStore: LearningRequestStore;
  let learning: LearningRequestService;
  let approvals: ApprovalService;
  let mgrId: string;
  let icId: string;
  let clock: number;
  let counter: number;
  let invokeLog: ToolInvokeRequest[];

  const fakeExecutor: ToolExecutor = {
    async invoke(request) {
      invokeLog.push(request);
      return { ok: true, invocationId: 'inv-1', result: { done: true } } as ToolInvokeDecision;
    },
  };

  function pod(): WorkerSpec[] {
    return [
      { roleCode: 'mgr', title: '主管', jobFamily: 'manager', seniority: 'lead', displayName: '主管', personaId: 'p-m', managerRoleCode: null },
      { roleCode: 'ic', title: '研究员', jobFamily: 'ic', seniority: 'ic', displayName: 'IC', personaId: 'p-ic', managerRoleCode: 'mgr' },
    ];
  }

  function seedTask(requiredCapabilities: string[], risk: RiskLevel = 'low'): string {
    const id = `task-${++counter}`;
    store.insertTask({
      orgId: 'org-1', goalId: 'g1', parentTaskId: null, assignedToWorkerId: icId, accountableWorkerId: mgrId,
      title: '干活', taskType: 'draft', status: 'delegated', riskLevel: risk, allowsToolExecution: true,
      acceptanceCriteria: '达标', requiredCapabilities, resultSummary: null, dueAt: null, id,
      createdAt: clock, updatedAt: clock,
    });
    return id;
  }

  beforeEach(() => {
    db = createMemoryDatabase();
    runDslSqliteMigrations(db);
    store = new OrgWorkforceStore(db, 'tenant-a');
    lrStore = new LearningRequestStore(db, 'tenant-a');
    clock = 1000;
    counter = 0;
    invokeLog = [];
    const chart = new OrgChartService(store, () => 1000, () => `id-${++counter}`);
    const boot = chart.bootstrap('org-1', pod());
    mgrId = boot.workerIdByRole.get('mgr')!;
    icId = boot.workerIdByRole.get('ic')!;
    approvals = new ApprovalService(store, () => clock, () => `ap-${++counter}`, 'tenant-a');
    learning = new LearningRequestService(lrStore, () => clock, () => `lr-${++counter}`, 'tenant-a');
  });

  function svc(): WorkerExecutionService {
    return new WorkerExecutionService(store, approvals, fakeExecutor, () => clock, 'tenant-a', learning);
  }

  const execInput = (taskId: string) => ({
    orgId: 'org-1', taskId, workerId: icId, principalUserId: 'owner-1',
    toolId: 'research.query', arguments: {},
  });

  it('★缺能力 → learning_required，不执行，登记学习请求，任务挂起★', async () => {
    const taskId = seedTask(['research']);  /* IC 从未学 research */
    const r = await svc().execute(execInput(taskId));

    assert.equal(r.kind, 'learning_required', '缺能力 → 不执行');
    if (r.kind !== 'learning_required') return;
    assert.deepEqual(r.gaps.map((g) => g.capability), ['research']);
    /* 工具未被调用（零-LLM 不硬干）。 */
    assert.equal(invokeLog.length, 0, '缺能力时绝不调工具/执行');
    /* 学习请求已登记（per persona p-ic）。 */
    const reqs = lrStore.listByOrg('org-1', 'pending');
    assert.equal(reqs.length, 1);
    assert.equal(reqs[0]!.capability, 'research');
    assert.equal(reqs[0]!.personaId, 'p-ic');
    assert.match(reqs[0]!.evidence, /research/);
    /* 任务挂起（blocked，原因=能力缺口）。 */
    assert.equal(store.getTask('org-1', taskId)!.status, 'blocked');
  });

  it('★多能力缺口 → 登记多条 + 全列出★', async () => {
    const taskId = seedTask(['review', 'compliance']);
    const r = await svc().execute(execInput(taskId));
    assert.equal(r.kind, 'learning_required');
    if (r.kind !== 'learning_required') return;
    assert.deepEqual(r.gaps.map((g) => g.capability).sort(), ['compliance', 'review']);
    assert.equal(lrStore.listByOrg('org-1', 'pending').length, 2);
  });

  it('★学会后无缺口 → 正常执行★', async () => {
    /* 先让 p-ic 学会 research（模拟学习闭环 passed）。 */
    const reg = learning.registerGap({ orgId: 'org-1', personaId: 'p-ic', capability: 'research', evidence: 'e', priority: 'low' });
    lrStore.transitionStatus(reg.request.id, 'pending', 'passed', clock);

    const taskId = seedTask(['research']);
    const r = await svc().execute(execInput(taskId));
    assert.equal(r.kind, 'executed', '已学会 → 零-LLM 正常执行');
    assert.equal(invokeLog.length, 1, '工具被调用一次');
    assert.equal(store.getTask('org-1', taskId)!.status, 'submitted');
  });

  it('★幂等：同缺口的多个任务只登记一次学习★', async () => {
    const t1 = seedTask(['research']);
    const t2 = seedTask(['research']);
    await svc().execute(execInput(t1));
    await svc().execute(execInput(t2));
    /* 两任务都缺 research，但学习请求账本只一条（防请教风暴）。 */
    assert.equal(lrStore.listByOrg('org-1').length, 1);
    /* 两任务都被挂起。 */
    assert.equal(store.getTask('org-1', t1)!.status, 'blocked');
    assert.equal(store.getTask('org-1', t2)!.status, 'blocked');
  });

  it('★无 requiredCapabilities → 不触发缺口门，正常执行★', async () => {
    const taskId = seedTask([]);
    const r = await svc().execute(execInput(taskId));
    assert.equal(r.kind, 'executed');
    assert.equal(lrStore.listByOrg('org-1').length, 0, '无所需能力 → 不产学习请求');
  });

  it('★未注入 learning service → 旧行为（跳过缺口门）★', async () => {
    const noLearn = new WorkerExecutionService(store, approvals, fakeExecutor, () => clock, 'tenant-a');
    const taskId = seedTask(['research']);
    const r = await noLearn.execute(execInput(taskId));
    assert.equal(r.kind, 'executed', '未注入 learning → 不做缺口检测，按旧行为执行');
    assert.equal(lrStore.listByOrg('org-1').length, 0);
  });
});
