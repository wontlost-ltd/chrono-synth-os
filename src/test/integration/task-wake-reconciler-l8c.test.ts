/**
 * 任务唤醒对账集成测试（ADR-0057 L8c：reconciler + 学习超时兜底）。
 *
 * 锁住唤醒可靠性：
 *   ① 丢事件恢复：能力已学但 capability-learned 事件未发（丢投）→ 反扫补唤醒（blocked→delegated）。
 *   ② 幂等：同已学状态重复反扫 → 不重复唤醒/不烧 resumeAttemptCount 预算。
 *   ③ 部分学会 → 反扫不唤醒（仍缺，fail-closed），但推进尝试计数。
 *   ④ 学习超时兜底：长期挂起未学会 → 标 [learning_timeout]（仍 blocked，待人工/改委派）。
 *   ⑤ 复用 L8a 唤醒核心（同确定性逻辑）。
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDatabase } from '../../storage/database.js';
import { runDslSqliteMigrations } from '../../storage/index.js';
import type { IDatabase } from '../../storage/database.js';
import { EventBus } from '../../events/event-bus.js';
import { SilentLogger } from '../../utils/logger.js';
import { OrgWorkforceStore } from '../../storage/org-workforce-store.js';
import { LearningRequestStore } from '../../storage/learning-request-store.js';
import { CapabilityIndexStore } from '../../storage/capability-index-store.js';
import { OrgChartService, type WorkerSpec } from '../../workforce/org-chart-service.js';
import { ApprovalService } from '../../workforce/approval-service.js';
import { LearningRequestService } from '../../workforce/learning-request-service.js';
import { TaskWakeHandler } from '../../workforce/task-wake-handler.js';
import { TaskWakeReconciler } from '../../workforce/task-wake-reconciler.js';
import {
  WorkerExecutionService, type ToolExecutor, type ToolInvokeRequest, type ToolInvokeDecision,
} from '../../workforce/worker-execution-service.js';

const DAY_MS = 24 * 60 * 60 * 1000;

describe('TaskWakeReconciler（ADR-0057 L8c 反扫补唤醒 + 学习超时）', () => {
  let db: IDatabase;
  let store: OrgWorkforceStore;
  let lrStore: LearningRequestStore;
  let capIndex: CapabilityIndexStore;
  let learning: LearningRequestService;
  let approvals: ApprovalService;
  let wake: TaskWakeHandler;
  let reconciler: TaskWakeReconciler;
  let icId: string;
  let mgrId: string;
  let clock: number;
  let counter: number;
  let invokeLog: ToolInvokeRequest[];

  const fakeExecutor: ToolExecutor = {
    async invoke(request) { invokeLog.push(request); return { ok: true, invocationId: 'inv-1', result: { done: true } } as ToolInvokeDecision; },
  };
  function pod(): WorkerSpec[] {
    return [
      { roleCode: 'mgr', title: '主管', jobFamily: 'manager', seniority: 'lead', displayName: '主管', personaId: 'p-m', managerRoleCode: null },
      { roleCode: 'ic', title: '研究员', jobFamily: 'ic', seniority: 'ic', displayName: 'IC', personaId: 'p-ic', managerRoleCode: 'mgr' },
    ];
  }
  function seedTask(requiredCapabilities: string[]): string {
    const id = `task-${++counter}`;
    store.insertTask({
      orgId: 'org-1', goalId: 'g1', parentTaskId: null, assignedToWorkerId: icId, accountableWorkerId: mgrId,
      title: '干活', taskType: 'draft', status: 'delegated', riskLevel: 'low', allowsToolExecution: true,
      acceptanceCriteria: '达标', requiredCapabilities, resultSummary: null, dueAt: null, id, createdAt: clock, updatedAt: clock,
    });
    return id;
  }
  /** 学会某能力但**不发事件**（模拟丢投）。 */
  function learnSilently(personaId: string, capability: string): void {
    capIndex.upsert({ id: `ci-${++counter}`, personaId, capability, examScore: 0.97, learningRequestId: `lr-${counter}`, capabilityVersion: 1, learnedAt: clock, updatedAt: clock });
  }
  function svc(): WorkerExecutionService {
    return new WorkerExecutionService(store, approvals, fakeExecutor, () => clock, 'tenant-a', learning);
  }
  const execInput = (taskId: string) => ({ orgId: 'org-1', taskId, workerId: icId, principalUserId: 'owner-1', toolId: 'research.query', arguments: {} });

  beforeEach(() => {
    db = createMemoryDatabase();
    runDslSqliteMigrations(db);
    store = new OrgWorkforceStore(db, 'tenant-a');
    lrStore = new LearningRequestStore(db, 'tenant-a');
    capIndex = new CapabilityIndexStore(db, 'tenant-a');
    clock = 1000; counter = 0; invokeLog = [];
    const chart = new OrgChartService(store, () => 1000, () => `id-${++counter}`);
    const boot = chart.bootstrap('org-1', pod());
    mgrId = boot.workerIdByRole.get('mgr')!;
    icId = boot.workerIdByRole.get('ic')!;
    approvals = new ApprovalService(store, () => clock, () => `ap-${++counter}`, 'tenant-a');
    learning = new LearningRequestService(lrStore, () => clock, () => `lr-${++counter}`, 'tenant-a', capIndex);
    wake = new TaskWakeHandler({ bus: new EventBus(), store, learning, logger: new SilentLogger(), now: () => clock, tenantId: 'tenant-a' });
    reconciler = new TaskWakeReconciler({ store, learning, wakeHandler: wake, logger: new SilentLogger(), now: () => clock });
  });

  it('★丢事件恢复：能力已学但事件未发 → 反扫补唤醒★', async () => {
    const taskId = seedTask(['research']);
    await svc().execute(execInput(taskId));  /* → blocked */
    assert.equal(store.getTask('org-1', taskId)!.status, 'blocked');

    /* 学会 research 但**不发事件**（模拟 EventBus 丢投）。 */
    learnSilently('p-ic', 'research');

    /* 反扫 → 复检无缺口 → 补唤醒。 */
    const stats = reconciler.reconcileOnce('org-1', clock);
    assert.equal(stats.woke, 1);
    assert.equal(store.getTask('org-1', taskId)!.status, 'delegated', '丢事件也能反扫唤醒');
  });

  it('★幂等：同已学状态重复反扫 → 不重复唤醒/不烧预算★', async () => {
    const taskId = seedTask(['research']);
    await svc().execute(execInput(taskId));
    learnSilently('p-ic', 'research');

    const first = reconciler.reconcileOnce('org-1', clock);
    assert.equal(first.woke, 1);
    assert.equal(store.getTask('org-1', taskId)!.resumeAttemptCount, 1);

    /* 复位回 blocked（模拟又被挂起），已学状态不变 → 同合成 id → 幂等跳过。 */
    store.transitionTaskExecutionIfStatus('org-1', taskId, 'delegated', 'blocked', '复位', clock);
    const second = reconciler.reconcileOnce('org-1', clock);
    assert.equal(second.woke, 0, '同已学状态 → 幂等不重复唤醒');
    assert.equal(store.getTask('org-1', taskId)!.resumeAttemptCount, 1, '尝试计数未被烧');
    assert.equal(store.getTask('org-1', taskId)!.status, 'blocked');
  });

  it('★部分学会 → 反扫不唤醒（仍缺，fail-closed）★', async () => {
    const taskId = seedTask(['review', 'compliance']);
    await svc().execute(execInput(taskId));
    learnSilently('p-ic', 'review');  /* 只学会一个 */

    const stats = reconciler.reconcileOnce('org-1', clock);
    assert.equal(stats.woke, 0, '仍缺 compliance → 不唤醒');
    assert.equal(store.getTask('org-1', taskId)!.status, 'blocked');
    assert.equal(store.getTask('org-1', taskId)!.resumeAttemptCount, 1, '推进尝试计数');

    /* 再学会 compliance → 反扫唤醒（合成 id 因已学集合变了而变）。 */
    learnSilently('p-ic', 'compliance');
    const stats2 = reconciler.reconcileOnce('org-1', clock);
    assert.equal(stats2.woke, 1, '学齐 → 反扫唤醒');
    assert.equal(store.getTask('org-1', taskId)!.status, 'delegated');
  });

  it('★学习超时兜底：长期挂起未学会 → 标 [learning_timeout]★', async () => {
    const taskId = seedTask(['research']);
    await svc().execute(execInput(taskId));  /* blocked at t=1000 */

    /* 8 天后仍未学会（不写索引）。 */
    clock = 1000 + 8 * DAY_MS;
    const stats = reconciler.reconcileOnce('org-1', clock);
    assert.equal(stats.woke, 0, '没学会 → 不唤醒');
    assert.equal(stats.timedOut, 1, '超时标记');
    const task = store.getTask('org-1', taskId)!;
    assert.equal(task.status, 'blocked', '仍 blocked（待人工/改委派）');
    assert.match(task.resultSummary!, /\[learning_timeout\]/);
  });

  it('★超时幂等：已标超时再反扫 → 不重复标★', async () => {
    const taskId = seedTask(['research']);
    await svc().execute(execInput(taskId));
    clock = 1000 + 8 * DAY_MS;
    const first = reconciler.reconcileOnce('org-1', clock);
    assert.equal(first.timedOut, 1);
    const second = reconciler.reconcileOnce('org-1', clock);
    assert.equal(second.timedOut, 0, '已标超时 → 不重复标');
  });

  it('★未超时不误标：挂起未到阈值 → 不标超时★', async () => {
    const taskId = seedTask(['research']);
    await svc().execute(execInput(taskId));
    clock = 1000 + 3 * DAY_MS;  /* 仅 3 天 < 7 天阈值 */
    const stats = reconciler.reconcileOnce('org-1', clock);
    assert.equal(stats.timedOut, 0, '未到阈值 → 不标超时');
    assert.doesNotMatch(store.getTask('org-1', taskId)!.resultSummary ?? '', /learning_timeout/);
  });

  it('★无 blocked 任务 → 空对账（不报错）★', () => {
    const stats = reconciler.reconcileOnce('org-1', clock);
    assert.equal(stats.scanned, 0);
    assert.equal(stats.woke, 0);
  });

  it('★非学习原因 blocked（工具失败/无学习请求）→ reconciler 绝不触碰（Codex L8c 复审）★', () => {
    /* 直接造一个 blocked 任务，**无关联 learning_requests**（模拟工具失败/权限拒绝挂起），且能力已学齐。 */
    const taskId = seedTask(['research']);
    store.transitionTaskExecutionIfStatus('org-1', taskId, 'delegated', 'blocked', '工具执行失败（非学习原因）', clock);
    learnSilently('p-ic', 'research');  /* 即便能力已学齐 */

    /* 即便已学齐 + 超时阈值，因无 learning_requests 关联，反扫绝不纳入。 */
    clock = 1000 + 8 * DAY_MS;
    const stats = reconciler.reconcileOnce('org-1', clock);
    assert.equal(stats.scanned, 0, '非学习 blocked 不在反扫候选集');
    assert.equal(stats.woke, 0, '不误唤醒');
    assert.equal(stats.timedOut, 0, '不误标超时');
    const task = store.getTask('org-1', taskId)!;
    assert.equal(task.status, 'blocked', '状态未被改');
    assert.match(task.resultSummary!, /工具执行失败/, '真实失败原因未被覆盖');
  });
});
