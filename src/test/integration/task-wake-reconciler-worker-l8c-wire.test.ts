/**
 * 唤醒对账周期 worker 集成测试（ADR-0057 L8c-wire）。
 *
 * 锁住「丢事件兜底自动化」最后一环：周期 worker 反扫**本租户全部 org** 的学习 blocked 任务补唤醒。
 *   ① flushOnce 反扫全租户（跨 org）→ 学会但丢事件的任务被补唤醒。
 *   ② 跨 org：worker 不需 orgId，按 tenant 整体反扫（多 org 各自 task.orgId 正确）。
 *   ③ start/stop 生命周期 + isHealthy；start 幂等。
 *   ④ 非学习 blocked 不被触碰（继承 reconciler 的 listLearningBlockedTasksAllOrgs JOIN 收窄）。
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
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
import { LearningRequestService } from '../../workforce/learning-request-service.js';
import { TaskWakeHandler } from '../../workforce/task-wake-handler.js';
import { TaskWakeReconciler } from '../../workforce/task-wake-reconciler.js';
import { TaskWakeReconcilerWorker } from '../../workforce/task-wake-reconciler-worker.js';

describe('TaskWakeReconcilerWorker（ADR-0057 L8c-wire 周期对账）', () => {
  let db: IDatabase;
  let store: OrgWorkforceStore;
  let capIndex: CapabilityIndexStore;
  let learning: LearningRequestService;
  let worker: TaskWakeReconcilerWorker;
  let clock: number;
  let counter: number;
  const icByOrg = new Map<string, string>();

  function pod(): WorkerSpec[] {
    return [
      { roleCode: 'mgr', title: '主管', jobFamily: 'manager', seniority: 'lead', displayName: '主管', personaId: 'p-m', managerRoleCode: null },
      { roleCode: 'ic', title: '研究员', jobFamily: 'ic', seniority: 'ic', displayName: 'IC', personaId: 'p-ic', managerRoleCode: 'mgr' },
    ];
  }

  /** 在某 org 造一个因 capability 缺口挂起（blocked + 关联学习请求）的任务，并学会该能力但**不发事件**。 */
  function seedBlockedLearnedTask(orgId: string, personaId: string, capability: string): string {
    const worker = icByOrg.get(orgId)!;
    const taskId = `${orgId}-task-${++counter}`;
    store.insertTask({
      orgId, goalId: 'g1', parentTaskId: null, assignedToWorkerId: worker, accountableWorkerId: worker,
      title: '活', taskType: 'x', status: 'delegated', riskLevel: 'low', allowsToolExecution: true,
      acceptanceCriteria: 'ok', requiredCapabilities: [capability], resultSummary: null, dueAt: null, id: taskId,
      createdAt: clock, updatedAt: clock,
    });
    learning.registerGap({ orgId, personaId, capability, evidence: 'e', priority: 'high', triggeredByTaskId: taskId });
    store.transitionTaskExecutionIfStatus(orgId, taskId, 'delegated', 'blocked', `能力缺口待进修：${capability}`, clock);
    /* 学会但不发事件（模拟丢投）。 */
    capIndex.upsert({ id: `ci-${++counter}`, personaId, capability, examScore: 0.97, learningRequestId: 'seed', capabilityVersion: 1, learnedAt: clock, updatedAt: clock });
    return taskId;
  }

  beforeEach(() => {
    db = createMemoryDatabase();
    runDslSqliteMigrations(db);
    store = new OrgWorkforceStore(db, 't1');
    capIndex = new CapabilityIndexStore(db, 't1');
    clock = 1000; counter = 0; icByOrg.clear();
    learning = new LearningRequestService(new LearningRequestStore(db, 't1'), () => clock, () => `lr-${++counter}`, 't1', capIndex);
    /* 两个 org（验跨 org 反扫）。 */
    for (const orgId of ['org-A', 'org-B']) {
      const chart = new OrgChartService(store, () => 1000, () => `${orgId}-id-${++counter}`);
      const boot = chart.bootstrap(orgId, pod());
      icByOrg.set(orgId, boot.workerIdByRole.get('ic')!);
    }
    const wakeHandler = new TaskWakeHandler({ bus: new EventBus(), store, learning, logger: new SilentLogger(), now: () => clock, tenantId: 't1' });
    const reconciler = new TaskWakeReconciler({ store, learning, wakeHandler, logger: new SilentLogger(), now: () => clock });
    worker = new TaskWakeReconcilerWorker(reconciler, () => clock, new SilentLogger());
  });
  afterEach(() => worker.stop());

  it('★flushOnce 反扫全租户跨 org → 学会但丢事件的任务被补唤醒★', () => {
    const tA = seedBlockedLearnedTask('org-A', 'p-ic', 'research');
    const tB = seedBlockedLearnedTask('org-B', 'p-ic', 'analysis');
    assert.equal(store.getTask('org-A', tA)!.status, 'blocked');
    assert.equal(store.getTask('org-B', tB)!.status, 'blocked');

    const stats = worker.flushOnce(clock);
    assert.equal(stats.scanned, 2, '跨 org 反扫到两个学习 blocked 任务');
    assert.equal(stats.woke, 2, '两个都补唤醒');
    assert.equal(store.getTask('org-A', tA)!.status, 'delegated', 'org-A 任务唤醒');
    assert.equal(store.getTask('org-B', tB)!.status, 'delegated', 'org-B 任务唤醒');
  });

  it('★幂等：同已学状态重复 flushOnce → 不重复唤醒/不烧预算★', () => {
    const tA = seedBlockedLearnedTask('org-A', 'p-ic', 'research');
    worker.flushOnce(clock);
    assert.equal(store.getTask('org-A', tA)!.resumeAttemptCount, 1);
    /* 复位回 blocked，已学状态不变 → 幂等跳过。 */
    store.transitionTaskExecutionIfStatus('org-A', tA, 'delegated', 'blocked', '复位', clock);
    const second = worker.flushOnce(clock);
    assert.equal(second.woke, 0, '同已学状态 → 幂等不重复唤醒');
    assert.equal(store.getTask('org-A', tA)!.resumeAttemptCount, 1, '尝试计数未被烧');
  });

  it('★非学习 blocked（无学习请求）→ worker 不触碰★', () => {
    /* 造一个无关联学习请求的 blocked 任务（工具失败等）。 */
    const worker2 = icByOrg.get('org-A')!;
    const taskId = 'org-A-nonlearn';
    store.insertTask({
      orgId: 'org-A', goalId: 'g1', parentTaskId: null, assignedToWorkerId: worker2, accountableWorkerId: worker2,
      title: '活', taskType: 'x', status: 'delegated', riskLevel: 'low', allowsToolExecution: true,
      acceptanceCriteria: 'ok', requiredCapabilities: ['research'], resultSummary: null, dueAt: null, id: taskId,
      createdAt: clock, updatedAt: clock,
    });
    store.transitionTaskExecutionIfStatus('org-A', taskId, 'delegated', 'blocked', '工具失败（非学习）', clock);
    capIndex.upsert({ id: 'ci-x', personaId: 'p-ic', capability: 'research', examScore: 0.97, learningRequestId: 'seed', capabilityVersion: 1, learnedAt: clock, updatedAt: clock });

    const stats = worker.flushOnce(clock);
    assert.equal(stats.scanned, 0, '非学习 blocked 不在反扫候选');
    assert.equal(store.getTask('org-A', taskId)!.status, 'blocked', '状态未被改');
    assert.match(store.getTask('org-A', taskId)!.resultSummary!, /工具失败/, '真实失败原因未被覆盖');
  });

  it('★start/stop 生命周期 + isHealthy + start 幂等★', () => {
    assert.equal(worker.isHealthy(), false, '未启动');
    worker.start();
    assert.equal(worker.isHealthy(), true, '已启动');
    worker.start();  /* 幂等：重复 start 不报错不叠加。 */
    assert.equal(worker.isHealthy(), true);
    worker.stop();
    assert.equal(worker.isHealthy(), false, '已停止');
    /* stop 后再 stop 不报错。 */
    worker.stop();
  });

  it('★空对账（无学习 blocked 任务）→ scanned=0 不报错★', () => {
    const stats = worker.flushOnce(clock);
    assert.equal(stats.scanned, 0);
    assert.equal(stats.woke, 0);
  });

  it('★超时兜底经 worker 触发：长期挂起未学会 → flushOnce 标 [learning_timeout]（Codex L8c-wire 复审）★', () => {
    /* 挂起任务但**不学会**（不写索引）；推进时钟超 7 天阈值 → worker 反扫标超时。 */
    const orgId = 'org-A';
    const w = icByOrg.get(orgId)!;
    const taskId = `${orgId}-timeout`;
    store.insertTask({
      orgId, goalId: 'g1', parentTaskId: null, assignedToWorkerId: w, accountableWorkerId: w,
      title: '活', taskType: 'x', status: 'delegated', riskLevel: 'low', allowsToolExecution: true,
      acceptanceCriteria: 'ok', requiredCapabilities: ['hard_skill'], resultSummary: null, dueAt: null, id: taskId,
      createdAt: clock, updatedAt: clock,
    });
    learning.registerGap({ orgId, personaId: 'p-ic', capability: 'hard_skill', evidence: 'e', priority: 'high', triggeredByTaskId: taskId });
    store.transitionTaskExecutionIfStatus(orgId, taskId, 'delegated', 'blocked', '能力缺口待进修：hard_skill', clock);

    clock = 1000 + 8 * 24 * 60 * 60 * 1000;  /* 8 天后仍没学会 */
    const stats = worker.flushOnce(clock);
    assert.equal(stats.woke, 0, '没学会 → 不唤醒');
    assert.equal(stats.timedOut, 1, '经 worker 标超时');
    assert.match(store.getTask(orgId, taskId)!.resultSummary!, /\[learning_timeout\]/);
  });

  it('★worker 外层异常隔离：reconciler 抛错 → flushOnce 抛出但 worker 周期回调吞掉不崩（Codex L8c-wire 复审）★', () => {
    /* 用一个 reconcileTenant 会抛的假 reconciler 建 worker——验证 setInterval 回调的 try/catch 兜住。
     * flushOnce 本身透传异常（运维显式调可见错误）；周期回调吞掉记 error 不崩 worker。 */
    const throwingReconciler = {
      reconcileTenant(): never { throw new Error('对账炸了'); },
    } as unknown as TaskWakeReconciler;
    const w2 = new TaskWakeReconcilerWorker(throwingReconciler, () => clock, new SilentLogger());
    /* flushOnce 透传异常（显式调可见）。 */
    assert.throws(() => w2.flushOnce(clock), /对账炸了/);
    /* start 周期回调内部 try/catch 吞掉——start/stop 不因此崩（不抛进定时器线程）。 */
    w2.start();
    assert.equal(w2.isHealthy(), true, 'worker 仍健康（周期异常被隔离）');
    w2.stop();
  });
});
