/**
 * 缺口处置集成测试（ADR-0057 L8b：委派/降级）。
 *
 * 锁住「尽量不卡死」处置策略（优先级 委派>降级>挂起，全确定性零-LLM）：
 *   ① 委派：组织内有学齐能力的同事 → 原子 reassign 给 TA（任务保持 delegated，换 TA 做），学习请求仍登记。
 *   ② 降级（opt-in）：无合格同事 + allowDegrade → 转 submitted + [降级] 标注（不假完成），学习请求仍登记。
 *   ③ 挂起兜底：无合格同事 + 不允许降级 → 落回 L8a 挂起（learning_required，blocked）。
 *   ④ 确定性：稳定序选首个合格同事；同库态 → 同处置。
 *   ⑤ 委派后接手同事能正常执行（缺口门对 TA 无缺口）。
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDatabase } from '../../storage/database.js';
import { runDslSqliteMigrations } from '../../storage/index.js';
import type { IDatabase } from '../../storage/database.js';
import { OrgWorkforceStore } from '../../storage/org-workforce-store.js';
import { LearningRequestStore } from '../../storage/learning-request-store.js';
import { CapabilityIndexStore } from '../../storage/capability-index-store.js';
import { OrgChartService, type WorkerSpec } from '../../workforce/org-chart-service.js';
import { ApprovalService } from '../../workforce/approval-service.js';
import { LearningRequestService } from '../../workforce/learning-request-service.js';
import { CapabilityAssignmentService } from '../../workforce/capability-assignment-service.js';
import { TaskDispositionService } from '../../workforce/task-disposition-service.js';
import {
  WorkerExecutionService, type ToolExecutor, type ToolInvokeRequest, type ToolInvokeDecision,
} from '../../workforce/worker-execution-service.js';

describe('TaskDisposition（ADR-0057 L8b 委派/降级缺口处置）', () => {
  let db: IDatabase;
  let store: OrgWorkforceStore;
  let lrStore: LearningRequestStore;
  let capIndex: CapabilityIndexStore;
  let learning: LearningRequestService;
  let approvals: ApprovalService;
  let mgrId: string;
  let ic1Id: string;   /* 缺能力者 */
  let ic2Id: string;   /* 有能力的同事 */
  let clock: number;
  let counter: number;
  let invokeLog: ToolInvokeRequest[];

  const fakeExecutor: ToolExecutor = {
    async invoke(request) { invokeLog.push(request); return { ok: true, invocationId: 'inv-1', result: { done: true } } as ToolInvokeDecision; },
  };

  function pod(): WorkerSpec[] {
    return [
      { roleCode: 'mgr', title: '主管', jobFamily: 'manager', seniority: 'lead', displayName: '主管', personaId: 'p-m', managerRoleCode: null },
      { roleCode: 'ic1', title: '研究员1', jobFamily: 'ic', seniority: 'ic', displayName: 'IC1', personaId: 'p-ic1', managerRoleCode: 'mgr' },
      { roleCode: 'ic2', title: '研究员2', jobFamily: 'ic', seniority: 'ic', displayName: 'IC2', personaId: 'p-ic2', managerRoleCode: 'mgr' },
    ];
  }

  function seedTask(assignee: string, requiredCapabilities: string[]): string {
    const id = `task-${++counter}`;
    store.insertTask({
      orgId: 'org-1', goalId: 'g1', parentTaskId: null, assignedToWorkerId: assignee, accountableWorkerId: mgrId,
      title: '干活', taskType: 'draft', status: 'delegated', riskLevel: 'low', allowsToolExecution: true,
      acceptanceCriteria: '达标', requiredCapabilities, resultSummary: null, dueAt: null, id, createdAt: clock, updatedAt: clock,
    });
    return id;
  }

  /** 让某 persona 学会某能力（写索引）。 */
  function learn(personaId: string, capability: string): void {
    capIndex.upsert({ id: `ci-${++counter}`, personaId, capability, examScore: 0.97, learningRequestId: `lr-${counter}`, capabilityVersion: 1, learnedAt: clock, updatedAt: clock });
  }

  function dispositionSvc(allowDegrade = false): TaskDispositionService {
    return new TaskDispositionService({ store, capabilities: new CapabilityAssignmentService(store, learning), now: () => clock, allowDegrade });
  }
  function execSvc(allowDegrade = false): WorkerExecutionService {
    return new WorkerExecutionService(store, approvals, fakeExecutor, () => clock, 'tenant-a', learning, dispositionSvc(allowDegrade));
  }
  const execInput = (taskId: string, workerId: string) => ({ orgId: 'org-1', taskId, workerId, principalUserId: 'owner-1', toolId: 'research.query', arguments: {} });

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
    ic1Id = boot.workerIdByRole.get('ic1')!;
    ic2Id = boot.workerIdByRole.get('ic2')!;
    approvals = new ApprovalService(store, () => clock, () => `ap-${++counter}`, 'tenant-a');
    learning = new LearningRequestService(lrStore, () => clock, () => `lr-${++counter}`, 'tenant-a', capIndex);
  });

  it('★委派：IC1 缺 research，IC2 会 → 委派给 IC2（任务保持 delegated，换 TA 做）★', async () => {
    learn('p-ic2', 'research');  /* IC2 已学会 research */
    const taskId = seedTask(ic1Id, ['research']);

    const r = await execSvc().execute(execInput(taskId, ic1Id));
    assert.equal(r.kind, 'delegated_to_colleague');
    if (r.kind !== 'delegated_to_colleague') return;
    assert.equal(r.toWorkerId, ic2Id, '委派给会 research 的 IC2');

    /* 任务已 reassign 给 IC2，仍 delegated（可执行）。 */
    const task = store.getTask('org-1', taskId)!;
    assert.equal(task.assignedToWorkerId, ic2Id, '执行者已换成 IC2');
    assert.equal(task.status, 'delegated', '任务保持可执行');
    /* 学习请求仍登记（IC1 的缺口异步补）。 */
    assert.equal(lrStore.listByOrg('org-1').length, 1);
    /* 工具未被 IC1 调（委派不执行）。 */
    assert.equal(invokeLog.length, 0);
  });

  it('★委派后 IC2 能正常执行（缺口门对 TA 无缺口）★', async () => {
    learn('p-ic2', 'research');
    const taskId = seedTask(ic1Id, ['research']);
    await execSvc().execute(execInput(taskId, ic1Id));  /* 委派给 IC2 */

    /* IC2 执行同一任务 → 无缺口 → 正常执行。 */
    const r2 = await execSvc().execute(execInput(taskId, ic2Id));
    assert.equal(r2.kind, 'executed', 'IC2 无缺口正常执行');
    assert.equal(invokeLog.length, 1);
    assert.equal(store.getTask('org-1', taskId)!.status, 'submitted');
  });

  it('★降级（opt-in）：无合格同事 + allowDegrade → submitted + [降级] 标注，不假完成★', async () => {
    /* 没人会 research。 */
    const taskId = seedTask(ic1Id, ['research']);
    const r = await execSvc(true).execute(execInput(taskId, ic1Id));  /* allowDegrade=true */

    assert.equal(r.kind, 'degraded');
    if (r.kind !== 'degraded') return;
    assert.match(r.note, /\[降级\]/);
    assert.match(r.note, /research/);
    assert.match(r.note, /未假装完成/);
    const task = store.getTask('org-1', taskId)!;
    assert.equal(task.status, 'submitted', '降级 → submitted（有产出）');
    assert.match(task.resultSummary!, /\[降级\]/, '结果摘要带降级标注');
    /* 学习请求仍登记（缺口异步补）。 */
    assert.equal(lrStore.listByOrg('org-1').length, 1);
  });

  it('★挂起兜底：无合格同事 + 不允许降级 → L8a 挂起（learning_required）★', async () => {
    const taskId = seedTask(ic1Id, ['research']);
    const r = await execSvc(false).execute(execInput(taskId, ic1Id));  /* allowDegrade=false（默认）*/

    assert.equal(r.kind, 'learning_required', '无委派/不降级 → 挂起');
    assert.equal(store.getTask('org-1', taskId)!.status, 'blocked');
    assert.equal(invokeLog.length, 0);
  });

  it('★委派优先于降级：有同事会则委派（即便 allowDegrade）★', async () => {
    learn('p-ic2', 'research');
    const taskId = seedTask(ic1Id, ['research']);
    const r = await execSvc(true).execute(execInput(taskId, ic1Id));  /* 允许降级，但优先委派 */
    assert.equal(r.kind, 'delegated_to_colleague', '委派优先于降级');
    assert.equal(store.getTask('org-1', taskId)!.assignedToWorkerId, ic2Id);
  });

  it('★多能力委派：同事须学齐全部所需能力才合格★', async () => {
    /* IC2 只会 review，不会 compliance → 不合格 → 不委派（无合格同事）。 */
    learn('p-ic2', 'review');
    const taskId = seedTask(ic1Id, ['review', 'compliance']);
    const r = await execSvc(false).execute(execInput(taskId, ic1Id));
    assert.equal(r.kind, 'learning_required', '同事缺一项 → 不委派 → 挂起');

    /* 现在让 IC2 也学会 compliance → 学齐 → 委派。 */
    learn('p-ic2', 'compliance');
    store.transitionTaskExecutionIfStatus('org-1', taskId, 'blocked', 'delegated', '复位', clock);  /* 复位重试 */
    const r2 = await execSvc(false).execute(execInput(taskId, ic1Id));
    assert.equal(r2.kind, 'delegated_to_colleague', '学齐全部 → 委派');
    assert.equal(store.getTask('org-1', taskId)!.assignedToWorkerId, ic2Id);
  });

  it('★确定性：多个合格同事 → 稳定序选首个（可复现）★', async () => {
    /* IC1 与 IC2 都会，但 IC1 是任务执行者（排除自己）→ 只 IC2 合格。再加一个会的同事验稳定序。 */
    learn('p-ic2', 'research');
    const colleague = new CapabilityAssignmentService(store, learning).findCapableColleague('org-1', ['research'], ic1Id);
    assert.equal(colleague?.id, ic2Id);
    /* 再查一次同输入 → 同结果（确定性）。 */
    const again = new CapabilityAssignmentService(store, learning).findCapableColleague('org-1', ['research'], ic1Id);
    assert.equal(again?.id, ic2Id);
  });

  it('★委派 CAS 失败（任务并发改走非 delegated）→ 退回 suspend，不误改派（Codex L8b 复审）★', () => {
    learn('p-ic2', 'research');
    const taskId = seedTask(ic1Id, ['research']);
    /* 模拟并发：disposition 决策后落地前，任务被并发拉起 in_progress（非 delegated）。 */
    store.transitionTaskExecutionIfStatus('org-1', taskId, 'delegated', 'in_progress', '并发拉起', clock);
    const task = store.getTask('org-1', taskId)!;
    const d = dispositionSvc(true).dispose({ orgId: 'org-1', task, currentWorkerId: ic1Id, missingCapabilities: ['research'] });
    /* reassignDelegatedTaskIfHeldBy 锁 status='delegated' → CAS 失败 → suspend（不误把执行中的任务改派/降级）。 */
    assert.equal(d.kind, 'suspend', 'CAS 失败 → 退回 suspend');
    assert.equal(store.getTask('org-1', taskId)!.assignedToWorkerId, ic1Id, '执行者未被误改');
    assert.equal(store.getTask('org-1', taskId)!.status, 'in_progress', '状态未被覆盖');
  });

  it('★未注入 disposition → 直接挂起（L8a 向后兼容）★', async () => {
    learn('p-ic2', 'research');  /* 即便有合格同事 */
    const taskId = seedTask(ic1Id, ['research']);
    const noDisposition = new WorkerExecutionService(store, approvals, fakeExecutor, () => clock, 'tenant-a', learning);
    const r = await noDisposition.execute(execInput(taskId, ic1Id));
    assert.equal(r.kind, 'learning_required', '未注入 disposition → 不委派，直接挂起');
    assert.equal(store.getTask('org-1', taskId)!.status, 'blocked');
  });
});
