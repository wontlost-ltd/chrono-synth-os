import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDatabase } from '../../storage/database.js';
import { runDslSqliteMigrations } from '../../storage/index.js';
import type { IDatabase } from '../../storage/database.js';
import { OrgWorkforceStore } from '../../storage/org-workforce-store.js';
import { OrgChartService, type WorkerSpec } from '../../workforce/org-chart-service.js';
import { ApprovalService } from '../../workforce/approval-service.js';

/* ADR-0055 D2：执行审批门——风险分级 + 状态机 + 4 铁律。确定性零-LLM。 */
describe('ApprovalService（D2 执行审批门）', () => {
  let db: IDatabase;
  let store: OrgWorkforceStore;
  let svc: ApprovalService;
  let mgrId: string;
  let icId: string;
  let peerId: string;
  let clock: number;
  let counter: number;

  function pod(): WorkerSpec[] {
    return [
      { roleCode: 'mgr', title: '主管', jobFamily: 'manager', seniority: 'lead', displayName: '主管', personaId: 'p-m', managerRoleCode: null },
      { roleCode: 'ic', title: 'IC', jobFamily: 'ic', seniority: 'ic', displayName: 'IC', personaId: 'p-i', managerRoleCode: 'mgr' },
      { roleCode: 'peer', title: 'Peer', jobFamily: 'ic', seniority: 'ic', displayName: 'Peer', personaId: 'p-p', managerRoleCode: 'mgr' },
    ];
  }

  beforeEach(() => {
    db = createMemoryDatabase();
    runDslSqliteMigrations(db);
    store = new OrgWorkforceStore(db, 'tenant-a');
    clock = 1000;
    counter = 0;
    const chart = new OrgChartService(store, () => 1000, () => `id-${++counter}`);
    const boot = chart.bootstrap('org-1', pod());
    mgrId = boot.workerIdByRole.get('mgr')!;
    icId = boot.workerIdByRole.get('ic')!;
    peerId = boot.workerIdByRole.get('peer')!;
    svc = new ApprovalService(store, () => clock, () => `ap-${++counter}`, 'tenant-a');
  });

  it('low 风险 → auto_cleared（无需审批）', () => {
    const r = svc.request({ orgId: 'org-1', subjectType: 'task_execution', subjectId: 't1', requesterWorkerId: icId, risk: { taskRisk: 'low' }, allowWorkerApproval: false });
    assert.equal(r.kind, 'auto_cleared');
  });

  it('high 风险 → pending + requiresHuman；人类批准后 cleared', () => {
    const r = svc.request({ orgId: 'org-1', subjectType: 'task_execution', subjectId: 't1', requesterWorkerId: icId, risk: { taskRisk: 'high' }, allowWorkerApproval: true });
    assert.equal(r.kind, 'pending');
    if (r.kind !== 'pending') return;
    assert.equal(r.approval.requiresHuman, true);
    assert.equal(svc.isApprovalCleared('org-1', r.approval.id), false, '未批不放行');
    svc.approveByHuman('org-1', r.approval.id, 'human-alice');
    assert.equal(svc.isApprovalCleared('org-1', r.approval.id), true, '人类批后放行');
  });

  it('★铁律3★：requiresHuman 的审批，上级数字员工批准 → 拒绝', () => {
    const r = svc.request({ orgId: 'org-1', subjectType: 'task_execution', subjectId: 't1', requesterWorkerId: icId, risk: { taskRisk: 'high' }, allowWorkerApproval: true });
    if (r.kind !== 'pending') throw new Error('expected pending');
    assert.throws(() => svc.approveByWorker('org-1', r.approval.id, mgrId), /要求人类批准/);
    assert.equal(svc.isApprovalCleared('org-1', r.approval.id), false, '上级批不算，仍不放行');
  });

  it('★铁律2★：medium + policy 开 worker 审批，**直接上级**可批', () => {
    const r = svc.request({ orgId: 'org-1', subjectType: 'task_execution', subjectId: 't1', requesterWorkerId: icId, risk: { taskRisk: 'medium' }, allowWorkerApproval: true });
    if (r.kind !== 'pending') throw new Error('expected pending');
    svc.approveByWorker('org-1', r.approval.id, mgrId);
    assert.equal(svc.isApprovalCleared('org-1', r.approval.id), true);
  });

  it('★铁律2边界★：非直接上级/平级/自批 不能 worker 审批', () => {
    const r = svc.request({ orgId: 'org-1', subjectType: 'task_execution', subjectId: 't1', requesterWorkerId: icId, risk: { taskRisk: 'medium' }, allowWorkerApproval: true });
    if (r.kind !== 'pending') throw new Error('expected pending');
    /* peer 是平级（同为 mgr 下属）→ 不是 ic 的直接上级。 */
    assert.throws(() => svc.approveByWorker('org-1', r.approval.id, peerId), /直接上级/);
    /* 自批。 */
    assert.throws(() => svc.approveByWorker('org-1', r.approval.id, icId), /自处置/);
  });

  it('★reject 边界对称★：suspended 的直接上级既不能批也不能拒（与 approve 同 helper）', () => {
    /* Codex 复审：reject 的 worker 路径曾缺 active 校验 → suspended 上级仍能越权拒绝污染审计。
     * 现 approve/reject 共用 assertWorkerMayDispose，suspended 上级两条路径都被挡。 */
    const r = svc.request({ orgId: 'org-1', subjectType: 'task_execution', subjectId: 't1', requesterWorkerId: icId, risk: { taskRisk: 'medium' }, allowWorkerApproval: true });
    if (r.kind !== 'pending') throw new Error('expected pending');
    /* 把直接上级 mgr 停用（仍保留 reporting edge）。 */
    db.prepare(`UPDATE digital_workers SET employment_status = 'suspended' WHERE id = ?`).run(mgrId);
    assert.throws(() => svc.approveByWorker('org-1', r.approval.id, mgrId), /active/);
    assert.throws(() => svc.reject('org-1', r.approval.id, { workerId: mgrId }), /active/);
    assert.equal(store.getApproval('org-1', r.approval.id)!.status, 'pending', '两次越权处置后仍 pending');
  });

  it('★reject actor 二选一★：兼填 userId+workerId 被拒（防绕过 worker 边界污染审计）', () => {
    const r = svc.request({ orgId: 'org-1', subjectType: 'task_execution', subjectId: 't1', requesterWorkerId: icId, risk: { taskRisk: 'high' }, allowWorkerApproval: true });
    if (r.kind !== 'pending') throw new Error('expected pending');
    /* 兼填：human 路径本可绕过 worker 边界，却把 workerId 写进 approver_worker_id 污染审计 → 必须直接拒绝。 */
    assert.throws(() => svc.reject('org-1', r.approval.id, { userId: 'human-a', workerId: peerId }), /二选一/);
    assert.equal(store.getApproval('org-1', r.approval.id)!.status, 'pending');
  });

  it('★reject worker 边界★：human_only 审批数字员工不能拒；平级/自处置不能拒', () => {
    /* human_only（high）：worker 不能拒。 */
    const hi = svc.request({ orgId: 'org-1', subjectType: 'task_execution', subjectId: 't1', requesterWorkerId: icId, risk: { taskRisk: 'high' }, allowWorkerApproval: true });
    if (hi.kind !== 'pending') throw new Error('expected pending');
    assert.throws(() => svc.reject('org-1', hi.approval.id, { workerId: mgrId }), /human_only/);
    /* org_or_human（medium+policy 开）：平级不能拒，自处置不能拒，直接上级可拒。 */
    const md = svc.request({ orgId: 'org-1', subjectType: 'task_execution', subjectId: 't2', requesterWorkerId: icId, risk: { taskRisk: 'medium' }, allowWorkerApproval: true });
    if (md.kind !== 'pending') throw new Error('expected pending');
    assert.throws(() => svc.reject('org-1', md.approval.id, { workerId: peerId }), /直接上级/);
    assert.throws(() => svc.reject('org-1', md.approval.id, { workerId: icId }), /自处置/);
    svc.reject('org-1', md.approval.id, { workerId: mgrId });
    assert.equal(store.getApproval('org-1', md.approval.id)!.status, 'rejected');
    assert.equal(store.getApproval('org-1', md.approval.id)!.approverWorkerId, mgrId, '审计记直接上级，未被污染');
  });

  it('★FATAL1 回归锁★：medium + policy 关 → approval_mode=human_only，**直接上级也批不了**，只人类能批', () => {
    /* Codex 复审 FATAL1：medium + allowWorkerApproval=false 时路由为 human_only，
     * 必须把路由结果**持久化**到 approval_mode 并在 approveByWorker 里据此挡住——
     * 否则 mgr 是 ic 的直接上级，能过组织边界，会把「只人类」策略绕过批掉。 */
    const r = svc.request({ orgId: 'org-1', subjectType: 'task_execution', subjectId: 't1', requesterWorkerId: icId, risk: { taskRisk: 'medium' }, allowWorkerApproval: false });
    if (r.kind !== 'pending') throw new Error('expected pending');
    assert.equal(r.approval.approvalMode, 'human_only', 'policy 关 → human_only');
    assert.equal(r.approval.requiresHuman, false, '风险本身 medium，requiresHuman=false');
    /* 直接上级 mgr 能过组织边界，但 approval_mode=human_only 必须把它挡住。 */
    assert.throws(() => svc.approveByWorker('org-1', r.approval.id, mgrId), /human_only/);
    assert.equal(svc.isApprovalCleared('org-1', r.approval.id), false, 'worker 批被拒，仍不放行');
    /* 人类可批。 */
    svc.approveByHuman('org-1', r.approval.id, 'human-bob');
    assert.equal(svc.isApprovalCleared('org-1', r.approval.id), true);
  });

  it('★FATAL2 回归锁★：同一 subject 旧 approved 不放行新 pending（按 approvalId 校验）', () => {
    /* Codex 复审 FATAL2：isCleared 若按 subject 找任意旧 approved，则同一 task 之前 medium 批过，
     * 之后新建 high pending 会被旧 approved 误放行（陈旧批准复用越权）。必须按**当前 approvalId**校验。 */
    /* 第一次：medium 批过。 */
    const first = svc.request({ orgId: 'org-1', subjectType: 'task_execution', subjectId: 't1', requesterWorkerId: icId, risk: { taskRisk: 'medium' }, allowWorkerApproval: true });
    if (first.kind !== 'pending') throw new Error('expected pending');
    svc.approveByWorker('org-1', first.approval.id, mgrId);
    assert.equal(svc.isApprovalCleared('org-1', first.approval.id), true, '旧审批自身已放行');
    /* 第二次：同一 subject 新建 high pending——绝不能被旧 approved 误放行。 */
    const second = svc.request({ orgId: 'org-1', subjectType: 'task_execution', subjectId: 't1', requesterWorkerId: icId, risk: { taskRisk: 'high' }, allowWorkerApproval: true });
    if (second.kind !== 'pending') throw new Error('expected pending');
    assert.notEqual(first.approval.id, second.approval.id, '两次是不同审批');
    assert.equal(svc.isApprovalCleared('org-1', second.approval.id), false, '新 pending 不被旧 approved 放行');
  });

  it('人类审批必须有 approverUserId（非空）', () => {
    const r = svc.request({ orgId: 'org-1', subjectType: 'task_execution', subjectId: 't1', requesterWorkerId: icId, risk: { taskRisk: 'high' }, allowWorkerApproval: true });
    if (r.kind !== 'pending') throw new Error('expected pending');
    assert.throws(() => svc.approveByHuman('org-1', r.approval.id, '  '), /approverUserId/);
  });

  it('拒绝 → 不放行', () => {
    const r = svc.request({ orgId: 'org-1', subjectType: 'task_execution', subjectId: 't1', requesterWorkerId: icId, risk: { taskRisk: 'high' }, allowWorkerApproval: true });
    if (r.kind !== 'pending') throw new Error('expected pending');
    svc.reject('org-1', r.approval.id, { userId: 'human-alice' });
    assert.equal(svc.isApprovalCleared('org-1', r.approval.id), false);
  });

  it('★isExecutionApprovalCleared 绑定★：subject/发起者/风险全匹配才放行（D3 执行门用）', () => {
    const r = svc.request({ orgId: 'org-1', subjectType: 'task_execution', subjectId: 't1', requesterWorkerId: icId, risk: { taskRisk: 'medium' }, allowWorkerApproval: true });
    if (r.kind !== 'pending') throw new Error('expected pending');
    svc.approveByWorker('org-1', r.approval.id, mgrId);
    const base = { orgId: 'org-1', approvalId: r.approval.id, subjectType: 'task_execution' as const, subjectId: 't1', requesterWorkerId: icId, effectiveRisk: 'medium' as const };
    assert.equal(svc.isExecutionApprovalCleared(base), true, '全匹配放行');
    /* subjectId 不匹配。 */
    assert.equal(svc.isExecutionApprovalCleared({ ...base, subjectId: 't2' }), false);
    /* subjectType 不匹配。 */
    assert.equal(svc.isExecutionApprovalCleared({ ...base, subjectType: 'tool_invocation' }), false);
    /* 发起者不匹配。 */
    assert.equal(svc.isExecutionApprovalCleared({ ...base, requesterWorkerId: mgrId }), false);
    /* 执行风险高于批准风险（medium 批准放行 high 执行）→ 拒。 */
    assert.equal(svc.isExecutionApprovalCleared({ ...base, effectiveRisk: 'high' }), false);
    /* 执行风险低于批准风险（high 批准放行 low/medium 执行）→ 放行（不低于即可）。 */
    assert.equal(svc.isExecutionApprovalCleared({ ...base, effectiveRisk: 'low' }), true);
  });

  it('★状态机★：已决定的审批不能再决定', () => {
    const r = svc.request({ orgId: 'org-1', subjectType: 'task_execution', subjectId: 't1', requesterWorkerId: icId, risk: { taskRisk: 'high' }, allowWorkerApproval: true });
    if (r.kind !== 'pending') throw new Error('expected pending');
    svc.approveByHuman('org-1', r.approval.id, 'human-alice');
    assert.throws(() => svc.reject('org-1', r.approval.id, { userId: 'x' }), /已是 approved/);
    assert.throws(() => svc.approveByHuman('org-1', r.approval.id, 'y'), /已是 approved/);
  });

  it('★过期★：pending 过期 → expired，不放行；过期后人类也批不了', () => {
    const r = svc.request({ orgId: 'org-1', subjectType: 'task_execution', subjectId: 't1', requesterWorkerId: icId, risk: { taskRisk: 'high' }, allowWorkerApproval: true, ttlMs: 100 });
    if (r.kind !== 'pending') throw new Error('expected pending');
    clock = 2000; /* 远超 1000+100 */
    assert.equal(svc.isApprovalCleared('org-1', r.approval.id), false, '过期不放行');
    assert.equal(store.getApproval('org-1', r.approval.id)!.status, 'expired', '已标记 expired');
    assert.throws(() => svc.approveByHuman('org-1', r.approval.id, 'human-alice'), /已是 expired/);
  });

  it('发起者必须在组织内', () => {
    assert.throws(() => svc.request({ orgId: 'org-1', subjectType: 'task_execution', subjectId: 't1', requesterWorkerId: 'ghost', risk: { taskRisk: 'high' }, allowWorkerApproval: true }), /不在组织/);
  });

  it('租户隔离：A 的审批 B 看不到', () => {
    const r = svc.request({ orgId: 'org-1', subjectType: 'task_execution', subjectId: 't1', requesterWorkerId: icId, risk: { taskRisk: 'high' }, allowWorkerApproval: true });
    if (r.kind !== 'pending') throw new Error('expected pending');
    assert.equal(new OrgWorkforceStore(db, 'tenant-b').getApproval('org-1', r.approval.id), undefined);
  });
});
