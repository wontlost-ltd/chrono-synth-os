import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDatabase } from '../../storage/database.js';
import { runDslSqliteMigrations } from '../../storage/index.js';
import type { IDatabase } from '../../storage/database.js';
import { OrgWorkforceStore } from '../../storage/org-workforce-store.js';
import { OrgChartService, type WorkerSpec } from '../../workforce/org-chart-service.js';
import { ApprovalService } from '../../workforce/approval-service.js';
import {
  WorkerExecutionService, WorkerExecutionError,
  type ToolExecutor, type ToolInvokeRequest, type ToolInvokeDecision,
} from '../../workforce/worker-execution-service.js';
import type { OrgTask, RiskLevel } from '../../workforce/types.js';

/* ADR-0055 D3：数字员工真实执行接线——风险门→审批门→actor→CAS 并发门→pipeline→写回。零-LLM 确定性。 */
describe('WorkerExecutionService（D3 真实执行接线）', () => {
  let db: IDatabase;
  let store: OrgWorkforceStore;
  let approvals: ApprovalService;
  let mgrId: string;
  let icId: string;
  let clock: number;
  let counter: number;
  /* 可编程的假管线：记录收到的请求，按预设返回决策。 */
  let invokeLog: ToolInvokeRequest[];
  let nextDecision: ToolInvokeDecision;
  let throwOnInvoke: Error | null;

  const fakeExecutor: ToolExecutor = {
    async invoke(request) {
      invokeLog.push(request);
      if (throwOnInvoke) throw throwOnInvoke;
      return nextDecision;
    },
  };

  function pod(): WorkerSpec[] {
    return [
      { roleCode: 'mgr', title: '主管', jobFamily: 'manager', seniority: 'lead', displayName: '主管', personaId: 'p-m', managerRoleCode: null },
      { roleCode: 'ic', title: 'IC', jobFamily: 'ic', seniority: 'ic', displayName: 'IC', personaId: 'p-i', managerRoleCode: 'mgr' },
    ];
  }

  /** 造一个 delegated 任务（默认 allowsToolExecution=true），返回 taskId。 */
  function seedTask(risk: RiskLevel, allowsTool = true, assignee: string = icId, status: OrgTask['status'] = 'delegated'): string {
    const id = `task-${++counter}`;
    store.insertTask({
      orgId: 'org-1', goalId: 'g1', parentTaskId: null, assignedToWorkerId: assignee, accountableWorkerId: mgrId,
      title: '写一段', taskType: 'draft', status, riskLevel: risk, allowsToolExecution: allowsTool,
      acceptanceCriteria: '达标', requiredCapabilities: [], resultSummary: null, dueAt: null, id,
      createdAt: clock, updatedAt: clock,
    });
    return id;
  }

  beforeEach(() => {
    db = createMemoryDatabase();
    runDslSqliteMigrations(db);
    store = new OrgWorkforceStore(db, 'tenant-a');
    clock = 1000;
    counter = 0;
    invokeLog = [];
    nextDecision = { ok: true, invocationId: 'inv-1', result: { wrote: true } };
    throwOnInvoke = null;
    const chart = new OrgChartService(store, () => 1000, () => `id-${++counter}`);
    const boot = chart.bootstrap('org-1', pod());
    mgrId = boot.workerIdByRole.get('mgr')!;
    icId = boot.workerIdByRole.get('ic')!;
    approvals = new ApprovalService(store, () => clock, () => `ap-${++counter}`, 'tenant-a');
  });

  function svc(): WorkerExecutionService {
    return new WorkerExecutionService(store, approvals, fakeExecutor, () => clock, 'tenant-a');
  }

  it('low 风险任务无需审批 → 直接执行成功，任务写回 submitted', async () => {
    const taskId = seedTask('low');
    const r = await svc().execute({ orgId: 'org-1', taskId, workerId: icId, principalUserId: 'owner-1', toolId: 'editor.write', arguments: { text: 'hi' } });
    assert.equal(r.kind, 'executed');
    if (r.kind !== 'executed') return;
    assert.equal(r.invocationId, 'inv-1');
    assert.equal(store.getTask('org-1', taskId)!.status, 'submitted');
    /* 管线收到 org_worker actor + 人类 principal。 */
    assert.equal(invokeLog.length, 1);
    assert.equal(invokeLog[0].invokerType, 'org_worker');
    assert.equal(invokeLog[0].invokerId, `worker:${icId}`);
    assert.equal(invokeLog[0].invokerUserId, 'owner-1');
  });

  it('★审批门★：medium 任务无 approvalId → needs_approval，不执行（不抢 in_progress）', async () => {
    const taskId = seedTask('medium');
    const r = await svc().execute({ orgId: 'org-1', taskId, workerId: icId, principalUserId: 'owner-1', toolId: 't', arguments: {} });
    assert.equal(r.kind, 'needs_approval');
    assert.equal(invokeLog.length, 0, '未执行');
    assert.equal(store.getTask('org-1', taskId)!.status, 'delegated', '任务状态未被破坏');
  });

  it('★审批门★：medium 任务 approvalId 未放行 → needs_approval', async () => {
    const taskId = seedTask('medium');
    const ap = approvals.request({ orgId: 'org-1', subjectType: 'task_execution', subjectId: taskId, requesterWorkerId: icId, risk: { taskRisk: 'medium' }, allowWorkerApproval: true });
    if (ap.kind !== 'pending') throw new Error('expected pending');
    /* 不批准就执行。 */
    const r = await svc().execute({ orgId: 'org-1', taskId, workerId: icId, principalUserId: 'owner-1', toolId: 't', arguments: {}, approvalId: ap.approval.id });
    assert.equal(r.kind, 'needs_approval');
    assert.equal(invokeLog.length, 0);
  });

  it('★审批门★：medium 任务 approvalId 已放行 → 执行成功', async () => {
    const taskId = seedTask('medium');
    const ap = approvals.request({ orgId: 'org-1', subjectType: 'task_execution', subjectId: taskId, requesterWorkerId: icId, risk: { taskRisk: 'medium' }, allowWorkerApproval: true });
    if (ap.kind !== 'pending') throw new Error('expected pending');
    approvals.approveByWorker('org-1', ap.approval.id, mgrId);
    const r = await svc().execute({ orgId: 'org-1', taskId, workerId: icId, principalUserId: 'owner-1', toolId: 't', arguments: {}, approvalId: ap.approval.id });
    assert.equal(r.kind, 'executed');
    assert.equal(store.getTask('org-1', taskId)!.status, 'submitted');
  });

  it('★越权回归锁★：用**另一个 task**的 approved approvalId 执行 → needs_approval，不调用管线', async () => {
    /* Codex 复审致命：只看 status=approved 会让同 org 任意旧批准放行。审批必须绑定本次执行的 task。 */
    const taskA = seedTask('medium');
    const taskB = seedTask('medium');
    /* 为 taskA 批一个 approval。 */
    const apA = approvals.request({ orgId: 'org-1', subjectType: 'task_execution', subjectId: taskA, requesterWorkerId: icId, risk: { taskRisk: 'medium' }, allowWorkerApproval: true });
    if (apA.kind !== 'pending') throw new Error('expected pending');
    approvals.approveByWorker('org-1', apA.approval.id, mgrId);
    /* 拿 taskA 的批准去执行 taskB → 必须被拒。 */
    const r = await svc().execute({ orgId: 'org-1', taskId: taskB, workerId: icId, principalUserId: 'owner-1', toolId: 't', arguments: {}, approvalId: apA.approval.id });
    assert.equal(r.kind, 'needs_approval');
    assert.equal(invokeLog.length, 0, '未执行');
    assert.equal(store.getTask('org-1', taskB)!.status, 'delegated');
  });

  it('★越权回归锁★：low task + funds → high，用同 task 的旧 **medium** 批准 → needs_approval（批准风险<执行风险）', async () => {
    /* 先为该 task 批一个 medium（如曾按 task.riskLevel=low+某 medium 信号批过），现在执行带 funds=true 顶到 high。
     * 批准风险 medium < 执行有效风险 high → 必须被拒，不能用低风险批准放行高风险执行（铁律1）。 */
    const taskId = seedTask('medium'); /* 任务本身 medium */
    const ap = approvals.request({ orgId: 'org-1', subjectType: 'task_execution', subjectId: taskId, requesterWorkerId: icId, risk: { taskRisk: 'medium' }, allowWorkerApproval: true });
    if (ap.kind !== 'pending') throw new Error('expected pending');
    approvals.approveByWorker('org-1', ap.approval.id, mgrId);
    /* 执行时带 funds=true → 有效风险强制 high，超过批准的 medium。 */
    const r = await svc().execute({ orgId: 'org-1', taskId, workerId: icId, principalUserId: 'owner-1', toolId: 'pay', arguments: {}, riskSignals: { funds: true }, approvalId: ap.approval.id });
    assert.equal(r.kind, 'needs_approval');
    if (r.kind !== 'needs_approval') return;
    assert.equal(r.effectiveRisk, 'high');
    assert.equal(invokeLog.length, 0);
  });

  it('★越权回归锁★：用**别的发起者**的 approved approvalId 执行 → needs_approval', async () => {
    const taskId = seedTask('medium', true, icId);
    /* 把同一 task 的审批以 mgr 作为发起者批准（构造发起者不匹配）。 */
    const ap = approvals.request({ orgId: 'org-1', subjectType: 'task_execution', subjectId: taskId, requesterWorkerId: mgrId, risk: { taskRisk: 'medium' }, allowWorkerApproval: false });
    if (ap.kind !== 'pending') throw new Error('expected pending');
    approvals.approveByHuman('org-1', ap.approval.id, 'human-a');
    /* ic 执行却用 mgr 发起的批准 → requesterWorkerId 不匹配 → 拒。 */
    const r = await svc().execute({ orgId: 'org-1', taskId, workerId: icId, principalUserId: 'owner-1', toolId: 't', arguments: {}, approvalId: ap.approval.id });
    assert.equal(r.kind, 'needs_approval');
    assert.equal(invokeLog.length, 0);
  });

  it('★越权回归锁★：subjectType 不匹配（tool_invocation 批准用于 task_execution）→ needs_approval', async () => {
    const taskId = seedTask('high', true, icId);
    /* 为同 id 批一个 tool_invocation 类型的审批。 */
    const ap = approvals.request({ orgId: 'org-1', subjectType: 'tool_invocation', subjectId: taskId, requesterWorkerId: icId, risk: { taskRisk: 'high' }, allowWorkerApproval: true });
    if (ap.kind !== 'pending') throw new Error('expected pending');
    approvals.approveByHuman('org-1', ap.approval.id, 'human-a');
    const r = await svc().execute({ orgId: 'org-1', taskId, workerId: icId, principalUserId: 'owner-1', toolId: 't', arguments: {}, approvalId: ap.approval.id });
    assert.equal(r.kind, 'needs_approval');
    assert.equal(invokeLog.length, 0);
  });

  it('★铁律1★：low 任务 + 资金信号 → 强制 high，无 approvalId → needs_approval(high)', async () => {
    const taskId = seedTask('low');
    const r = await svc().execute({ orgId: 'org-1', taskId, workerId: icId, principalUserId: 'owner-1', toolId: 'pay', arguments: {}, riskSignals: { funds: true } });
    assert.equal(r.kind, 'needs_approval');
    if (r.kind !== 'needs_approval') return;
    assert.equal(r.effectiveRisk, 'high', '硬信号顶到 high');
    assert.equal(invokeLog.length, 0);
  });

  it('★人类 principal 强制★：principalUserId 为空 → 抛错（org_worker 不得无 principal 执行）', async () => {
    const taskId = seedTask('low');
    await assert.rejects(
      () => svc().execute({ orgId: 'org-1', taskId, workerId: icId, principalUserId: '  ', toolId: 't', arguments: {} }),
      /principal/,
    );
    assert.equal(invokeLog.length, 0);
    assert.equal(store.getTask('org-1', taskId)!.status, 'delegated', '未抢 in_progress');
  });

  it('★并发门★：同一任务并发执行，只有一个真正执行，另一个抛错（CAS delegated→in_progress）', async () => {
    const taskId = seedTask('low');
    /* 第一次成功执行 → 任务变 submitted。 */
    const first = await svc().execute({ orgId: 'org-1', taskId, workerId: icId, principalUserId: 'owner-1', toolId: 't', arguments: {} });
    assert.equal(first.kind, 'executed');
    /* 第二次：任务已不是 delegated → CAS 抢不到 → 抛错，且不再调用管线。 */
    invokeLog = [];
    await assert.rejects(
      () => svc().execute({ orgId: 'org-1', taskId, workerId: icId, principalUserId: 'owner-1', toolId: 't', arguments: {} }),
      WorkerExecutionError,
    );
    assert.equal(invokeLog.length, 0, '抢不到的执行者不调用管线');
  });

  it('★铁律4★：管线 pending_confirmation → 不自动补 token，回 needs_pipeline_confirmation，任务退回 delegated 可重入', async () => {
    const taskId = seedTask('low');
    nextDecision = { ok: false, invocationId: 'inv-2', status: 'pending_confirmation', reason: '高风险工具需二次确认', confirmationTokenId: 'ctok-1' };
    const r = await svc().execute({ orgId: 'org-1', taskId, workerId: icId, principalUserId: 'owner-1', toolId: 'delete', arguments: {} });
    assert.equal(r.kind, 'needs_pipeline_confirmation');
    if (r.kind !== 'needs_pipeline_confirmation') return;
    assert.equal(r.confirmationTokenId, 'ctok-1');
    /* pending_confirmation 非终态：任务退回 delegated（可重入），不是 blocked（会卡死无法确认后重试）。 */
    assert.equal(store.getTask('org-1', taskId)!.status, 'delegated');
    /* 管线只被调一次，token 未被自动补（铁律4：审批门放行≠管线确认）。 */
    assert.equal(invokeLog.length, 1);
    assert.equal(invokeLog[0].confirmationToken, undefined);
  });

  it('★铁律4★：人类显式带 confirmationToken 重试 → token 透传管线，执行成功', async () => {
    const taskId = seedTask('low');
    /* 第一次：管线要求确认，任务退回 delegated。 */
    nextDecision = { ok: false, invocationId: 'inv-2', status: 'pending_confirmation', reason: '需确认', confirmationTokenId: 'ctok-9' };
    const first = await svc().execute({ orgId: 'org-1', taskId, workerId: icId, principalUserId: 'owner-1', toolId: 'delete', arguments: {} });
    assert.equal(first.kind, 'needs_pipeline_confirmation');
    /* 第二次：人类显式提供 token → 透传管线，管线放行 → 成功。 */
    invokeLog = [];
    nextDecision = { ok: true, invocationId: 'inv-9', result: { deleted: true } };
    const second = await svc().execute({ orgId: 'org-1', taskId, workerId: icId, principalUserId: 'owner-1', toolId: 'delete', arguments: {}, confirmationToken: 'ctok-9' });
    assert.equal(second.kind, 'executed');
    assert.equal(invokeLog.length, 1);
    assert.equal(invokeLog[0].confirmationToken, 'ctok-9', 'token 透传管线');
    assert.equal(store.getTask('org-1', taskId)!.status, 'submitted');
  });

  it('管线失败/超时 → 任务 blocked 带原因，回 failed', async () => {
    const taskId = seedTask('low');
    nextDecision = { ok: false, invocationId: 'inv-3', status: 'timeout', reason: '工具超时' };
    const r = await svc().execute({ orgId: 'org-1', taskId, workerId: icId, principalUserId: 'owner-1', toolId: 't', arguments: {} });
    assert.equal(r.kind, 'failed');
    if (r.kind !== 'failed') return;
    assert.equal(r.status, 'timeout');
    const task = store.getTask('org-1', taskId)!;
    assert.equal(task.status, 'blocked');
    assert.match(task.resultSummary!, /timeout/);
  });

  it('管线抛异常 → 任务 blocked，回 failed，不吞异常语义', async () => {
    const taskId = seedTask('low');
    throwOnInvoke = new Error('管线炸了');
    const r = await svc().execute({ orgId: 'org-1', taskId, workerId: icId, principalUserId: 'owner-1', toolId: 't', arguments: {} });
    assert.equal(r.kind, 'failed');
    const task = store.getTask('org-1', taskId)!;
    assert.equal(task.status, 'blocked');
    assert.match(task.resultSummary!, /执行异常/);
  });

  it('前置校验：非 delegated 任务不能执行', async () => {
    const taskId = seedTask('low', true, icId, 'submitted');
    await assert.rejects(
      () => svc().execute({ orgId: 'org-1', taskId, workerId: icId, principalUserId: 'owner-1', toolId: 't', arguments: {} }),
      /delegated/,
    );
  });

  it('前置校验：A0 未允许工具执行的任务不能执行', async () => {
    const taskId = seedTask('low', false);
    await assert.rejects(
      () => svc().execute({ orgId: 'org-1', taskId, workerId: icId, principalUserId: 'owner-1', toolId: 't', arguments: {} }),
      /allowsToolExecution/,
    );
    assert.equal(invokeLog.length, 0);
  });

  it('前置校验：执行者必须是任务当前指派的数字员工', async () => {
    const taskId = seedTask('low');
    await assert.rejects(
      () => svc().execute({ orgId: 'org-1', taskId, workerId: mgrId, principalUserId: 'owner-1', toolId: 't', arguments: {} }),
      /当前指派/,
    );
  });

  it('确定性：相同输入相同副作用（成功路径写回一致）', async () => {
    const t1 = seedTask('low');
    const t2 = seedTask('low');
    const r1 = await svc().execute({ orgId: 'org-1', taskId: t1, workerId: icId, principalUserId: 'owner-1', toolId: 'editor.write', arguments: { text: 'x' } });
    const r2 = await svc().execute({ orgId: 'org-1', taskId: t2, workerId: icId, principalUserId: 'owner-1', toolId: 'editor.write', arguments: { text: 'x' } });
    assert.equal(r1.kind, r2.kind);
    assert.equal(store.getTask('org-1', t1)!.status, store.getTask('org-1', t2)!.status);
  });
});
