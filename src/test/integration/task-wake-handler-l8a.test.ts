/**
 * 任务唤醒闭环集成测试（ADR-0057 L8a，D0.8 核心闭环）。
 *
 * 锁住「学完马上投入工作」+ fail-closed 复检：任务因缺能力挂起（blocked）→ capability-learned 事件 →
 * 唤醒处理器找挂起任务 → 确定性 GapDetector 复检 → 无缺口唤醒重跑（blocked→delegated，零-LLM）/
 * 仍缺保持 blocked（fail-closed，绝不静默执行）。含幂等去重 + 防死循环尝试上限 + per-persona 隔离。
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
import {
  WorkerExecutionService, type ToolExecutor, type ToolInvokeRequest, type ToolInvokeDecision,
} from '../../workforce/worker-execution-service.js';

describe('TaskWakeHandler（ADR-0057 L8a 学完唤醒重跑闭环）', () => {
  let db: IDatabase;
  let store: OrgWorkforceStore;
  let lrStore: LearningRequestStore;
  let capIndex: CapabilityIndexStore;
  let learning: LearningRequestService;
  let approvals: ApprovalService;
  let bus: EventBus;
  let wake: TaskWakeHandler;
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

  function seedTask(requiredCapabilities: string[]): string {
    const id = `task-${++counter}`;
    store.insertTask({
      orgId: 'org-1', goalId: 'g1', parentTaskId: null, assignedToWorkerId: icId, accountableWorkerId: mgrId,
      title: '干活', taskType: 'draft', status: 'delegated', riskLevel: 'low', allowsToolExecution: true,
      acceptanceCriteria: '达标', requiredCapabilities, resultSummary: null, dueAt: null, id,
      createdAt: clock, updatedAt: clock,
    });
    return id;
  }

  function svc(): WorkerExecutionService {
    return new WorkerExecutionService(store, approvals, fakeExecutor, () => clock, 'tenant-a', learning);
  }
  const execInput = (taskId: string) => ({ orgId: 'org-1', taskId, workerId: icId, principalUserId: 'owner-1', toolId: 'research.query', arguments: {} });

  /** 模拟学会某能力：写 capability_index（投影器在真系统做；测试直接写）+ 发 capability-learned。返回学习请求 id。 */
  function learnAndEmit(personaId: string, capability: string): string {
    const lrId = `lr-passed-${++counter}`;
    capIndex.upsert({ id: `ci-${counter}`, personaId, capability, examScore: 0.97, learningRequestId: lrId, capabilityVersion: 1, learnedAt: clock, updatedAt: clock });
    return lrId;
  }

  beforeEach(() => {
    db = createMemoryDatabase();
    runDslSqliteMigrations(db);
    store = new OrgWorkforceStore(db, 'tenant-a');
    lrStore = new LearningRequestStore(db, 'tenant-a');
    capIndex = new CapabilityIndexStore(db, 'tenant-a');
    clock = 1000;
    counter = 0;
    invokeLog = [];
    bus = new EventBus();
    const chart = new OrgChartService(store, () => 1000, () => `id-${++counter}`);
    const boot = chart.bootstrap('org-1', pod());
    mgrId = boot.workerIdByRole.get('mgr')!;
    icId = boot.workerIdByRole.get('ic')!;
    approvals = new ApprovalService(store, () => clock, () => `ap-${++counter}`, 'tenant-a');
    /* learning service 注入 capIndex：已学能力 = 索引 ∪ L2 passed。 */
    learning = new LearningRequestService(lrStore, () => clock, () => `lr-${++counter}`, 'tenant-a', capIndex);
    wake = new TaskWakeHandler({ bus, store, learning, logger: new SilentLogger(), now: () => clock, tenantId: 'tenant-a' });
    wake.start();
  });

  it('★完整闭环：缺能力挂起 → 学会 → 唤醒重跑（blocked→delegated）→ 复跑可执行★', async () => {
    /* 1. 执行缺 research → learning_required + 任务 blocked。 */
    const taskId = seedTask(['research']);
    const r1 = await svc().execute(execInput(taskId));
    assert.equal(r1.kind, 'learning_required');
    assert.equal(store.getTask('org-1', taskId)!.status, 'blocked');
    const lrId = r1.kind === 'learning_required' ? r1.gaps[0]!.request.id : '';

    /* 2. 学会 research（投影索引）→ 发 capability-learned → 唤醒处理器复检 → 唤醒。 */
    capIndex.upsert({ id: 'ci-r', personaId: 'p-ic', capability: 'research', examScore: 0.97, learningRequestId: lrId, capabilityVersion: 1, learnedAt: clock, updatedAt: clock });
    bus.emit('capability-learned', { personaId: 'p-ic', capability: 'research', learningRequestId: lrId, examScore: 0.97, learnedAt: clock, tenantId: 'tenant-a' });

    /* 3. 任务被唤醒回 delegated（重新可执行），尝试计数 +1，记唤醒事件。 */
    const woken = store.getTask('org-1', taskId)!;
    assert.equal(woken.status, 'delegated', '复检无缺口 → 唤醒回 delegated');
    assert.equal(woken.resumeAttemptCount, 1);
    assert.equal(woken.lastWakeEventId, lrId);

    /* 4. ★学完马上投入工作★：再执行 → 零-LLM 正常干完（缺口门已无缺口）。 */
    const r2 = await svc().execute(execInput(taskId));
    assert.equal(r2.kind, 'executed', '唤醒后重跑零-LLM 执行');
    assert.equal(invokeLog.length, 1, '工具被调用（学完真投入）');
    assert.equal(store.getTask('org-1', taskId)!.status, 'submitted');
  });

  it('★fail-closed：多能力缺口只学会一个 → 保持 blocked，不假完成★', async () => {
    /* 任务缺 review + compliance；只学会 review。 */
    const taskId = seedTask(['review', 'compliance']);
    const r1 = await svc().execute(execInput(taskId));
    assert.equal(r1.kind, 'learning_required');

    const lrId = learnAndEmit('p-ic', 'review');  /* 只学会 review */
    const outcomes = wake.onLearned({ personaId: 'p-ic', capability: 'review', learningRequestId: lrId, examScore: 0.96, learnedAt: clock, tenantId: 'tenant-a' });

    /* 复检仍缺 compliance → 保持 blocked（fail-closed）。 */
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0]!.kind, 'still_blocked');
    if (outcomes[0]!.kind === 'still_blocked') assert.deepEqual(outcomes[0]!.remainingGaps, ['compliance']);
    const task = store.getTask('org-1', taskId)!;
    assert.equal(task.status, 'blocked', '仍缺一个 → 绝不唤醒');
    assert.equal(task.resumeAttemptCount, 1, '尝试计数仍推进（防死循环）');
  });

  it('★多能力学齐后唤醒：两个都学会 → 第二个事件唤醒★', async () => {
    const taskId = seedTask(['review', 'compliance']);
    await svc().execute(execInput(taskId));

    /* 学会 review → 仍缺 compliance → blocked。 */
    const lr1 = learnAndEmit('p-ic', 'review');
    wake.onLearned({ personaId: 'p-ic', capability: 'review', learningRequestId: lr1, examScore: 0.96, learnedAt: clock, tenantId: 'tenant-a' });
    assert.equal(store.getTask('org-1', taskId)!.status, 'blocked');

    /* 再学会 compliance → 全齐 → 唤醒。 */
    const lr2 = learnAndEmit('p-ic', 'compliance');
    const outcomes = wake.onLearned({ personaId: 'p-ic', capability: 'compliance', learningRequestId: lr2, examScore: 0.98, learnedAt: clock, tenantId: 'tenant-a' });
    assert.equal(outcomes[0]!.kind, 'woke');
    assert.equal(store.getTask('org-1', taskId)!.status, 'delegated', '全部能力学齐 → 唤醒');
    assert.equal(store.getTask('org-1', taskId)!.resumeAttemptCount, 2, '两次尝试');
  });

  it('★幂等：同一唤醒事件重复投递 → 只处理一次★', async () => {
    const taskId = seedTask(['research']);
    await svc().execute(execInput(taskId));
    const lrId = learnAndEmit('p-ic', 'research');

    const first = wake.onLearned({ personaId: 'p-ic', capability: 'research', learningRequestId: lrId, examScore: 0.97, learnedAt: clock, tenantId: 'tenant-a' });
    assert.equal(first[0]!.kind, 'woke');
    assert.equal(store.getTask('org-1', taskId)!.resumeAttemptCount, 1);

    /* 任务已 delegated，但即便它还 blocked，同事件 id 也应幂等跳过——这里把它人为改回 blocked 验证幂等。 */
    store.transitionTaskExecutionIfStatus('org-1', taskId, 'delegated', 'blocked', '复位测试幂等', clock);
    const second = wake.onLearned({ personaId: 'p-ic', capability: 'research', learningRequestId: lrId, examScore: 0.97, learnedAt: clock, tenantId: 'tenant-a' });
    assert.equal(second[0]!.kind, 'skipped_idempotent', '同事件 id → 幂等跳过');
    assert.equal(store.getTask('org-1', taskId)!.status, 'blocked', '幂等：未重复唤醒');
    assert.equal(store.getTask('org-1', taskId)!.resumeAttemptCount, 1, '计数未重复推进');
  });

  it('★防死循环：超尝试上限 → 停在 blocked（attempts_exhausted）★', async () => {
    const handler = new TaskWakeHandler({ bus, store, learning, logger: new SilentLogger(), now: () => clock, tenantId: 'tenant-a', maxResumeAttempts: 2 });
    const taskId = seedTask(['review', 'compliance']);
    await svc().execute(execInput(taskId));

    /* 学会 review 但永远缺 compliance：每次唤醒都 still_blocked + 推进计数。 */
    const lr = learnAndEmit('p-ic', 'review');
    /* 用不同事件 id 触发多次（绕幂等）。 */
    for (let i = 0; i < 2; i++) {
      handler.onLearned({ personaId: 'p-ic', capability: 'review', learningRequestId: `${lr}-${i}`, examScore: 0.96, learnedAt: clock, tenantId: 'tenant-a' });
    }
    assert.equal(store.getTask('org-1', taskId)!.resumeAttemptCount, 2, '已达上限');

    /* 第三次：超上限 → attempts_exhausted，仍 blocked。 */
    const out = handler.onLearned({ personaId: 'p-ic', capability: 'review', learningRequestId: `${lr}-final`, examScore: 0.96, learnedAt: clock, tenantId: 'tenant-a' });
    assert.equal(out[0]!.kind, 'attempts_exhausted');
    assert.equal(store.getTask('org-1', taskId)!.status, 'blocked', '超上限停 blocked 待兜底');
  });

  it('★tenantId 不匹配 → drop（不跨租户唤醒）★', async () => {
    const taskId = seedTask(['research']);
    await svc().execute(execInput(taskId));
    const lrId = learnAndEmit('p-ic', 'research');
    const out = wake.onLearned({ personaId: 'p-ic', capability: 'research', learningRequestId: lrId, examScore: 0.97, learnedAt: clock, tenantId: 'other-tenant' });
    assert.deepEqual(out, [], '非本租户事件 → drop');
    assert.equal(store.getTask('org-1', taskId)!.status, 'blocked', '未唤醒');
  });

  it('★无挂起任务 → 空结果（不报错）★', () => {
    const out = wake.onLearned({ personaId: 'p-ic', capability: 'research', learningRequestId: 'lr-none', examScore: 0.97, learnedAt: clock, tenantId: 'tenant-a' });
    assert.deepEqual(out, []);
  });

  it('★lost_race：任务在唤醒前已被并发改走（非 blocked）→ lost_race，不误唤醒（Codex L8a 复审）★', async () => {
    const taskId = seedTask(['research']);
    await svc().execute(execInput(taskId));
    const lrId = learnAndEmit('p-ic', 'research');

    /* 模拟并发：唤醒事件处理前，任务已被别的流程从 blocked 改走（如人工干预 → delegated）。 */
    store.transitionTaskExecutionIfStatus('org-1', taskId, 'blocked', 'delegated', '并发人工干预', clock);

    /* onLearned 经 learning_requests JOIN 仍可能列出（其 status 已非 blocked，JOIN 过滤 blocked → 不列出）；
     * 即便列出，wakeOne 内 getTask 重读发现非 blocked → lost_race。此处验证不误唤醒/不破坏已改状态。 */
    const out = wake.onLearned({ personaId: 'p-ic', capability: 'research', learningRequestId: lrId, examScore: 0.97, learnedAt: clock, tenantId: 'tenant-a' });
    /* JOIN 已按 status='blocked' 过滤，故通常空；若并发窗口列出则 lost_race。两种都不误唤醒。 */
    assert.ok(out.length === 0 || out[0]!.kind === 'lost_race', '非 blocked 任务不被误唤醒');
    /* 任务保持被并发改走后的状态（delegated），唤醒计数未被推进。 */
    const task = store.getTask('org-1', taskId)!;
    assert.equal(task.status, 'delegated', '并发改走的状态未被唤醒覆盖');
    assert.equal(task.resumeAttemptCount, 0, '未对非 blocked 任务推进唤醒计数');
  });
});
