import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDatabase } from '../../storage/database.js';
import { runDslSqliteMigrations } from '../../storage/index.js';
import type { IDatabase } from '../../storage/database.js';
import { OrgWorkforceStore } from '../../storage/org-workforce-store.js';
import { OrgChartService, type WorkerSpec } from '../../workforce/org-chart-service.js';
import { OrgPlanningService } from '../../workforce/org-planning-service.js';
import { GOAL_TYPE_CONTENT_PIECE } from '../../workforce/decomposition-playbook.js';
import { HandoffService, InvalidHandoffError } from '../../workforce/handoff-service.js';

/* B2 任务 handoff：有状态协商交接，保组织/执行者不变量。 */
describe('HandoffService（B2 任务交接协商）', () => {
  let db: IDatabase;
  let store: OrgWorkforceStore;
  let handoff: HandoffService;
  let writerId: string;
  let reviewerId: string;
  let researcherId: string;
  let taskId: string;
  let counter: number;

  function pod(): WorkerSpec[] {
    return [
      { roleCode: 'managing_editor', title: '主编', jobFamily: 'manager', seniority: 'lead', displayName: '主编', personaId: 'p-me', managerRoleCode: null },
      { roleCode: 'researcher_ic', title: '研究', jobFamily: 'ic', seniority: 'ic', displayName: '研究', personaId: 'p-r', managerRoleCode: 'managing_editor' },
      { roleCode: 'writer_ic', title: '写作', jobFamily: 'ic', seniority: 'ic', displayName: '写作', personaId: 'p-w', managerRoleCode: 'managing_editor' },
      { roleCode: 'reviewer_ic', title: '审核', jobFamily: 'ic', seniority: 'ic', displayName: '审核', personaId: 'p-rv', managerRoleCode: 'managing_editor' },
      { roleCode: 'publisher_ic', title: '发布', jobFamily: 'ic', seniority: 'ic', displayName: '发布', personaId: 'p-p', managerRoleCode: 'managing_editor' },
    ];
  }

  beforeEach(() => {
    db = createMemoryDatabase();
    runDslSqliteMigrations(db);
    store = new OrgWorkforceStore(db, 'tenant-a');
    counter = 0;
    const idg = (): string => `id-${++counter}`;
    const chart = new OrgChartService(store, () => 1000, idg);
    const planning = new OrgPlanningService(store, chart, () => 1000, idg);
    const boot = chart.bootstrap('org-1', pod());
    writerId = boot.workerIdByRole.get('writer_ic')!;
    reviewerId = boot.workerIdByRole.get('reviewer_ic')!;
    researcherId = boot.workerIdByRole.get('researcher_ic')!;
    const res = planning.runGoal('org-1', boot.workerIdByRole.get('managing_editor')!, { title: 'X', description: '', goalType: GOAL_TYPE_CONTENT_PIECE }, boot.workerIdByRole);
    /* 取写作任务（执行者=writer）。 */
    taskId = store.listTasksByGoal('org-1', res.goalId).find((t) => t.taskType === 'writing')!.id;
    handoff = new HandoffService(store, () => 2000, idg, 'tenant-a');
  });

  it('propose → accept：任务执行者从 writer 改成 reviewer（原子）', () => {
    const h = handoff.propose({ orgId: 'org-1', taskId, fromWorkerId: writerId, toWorkerId: reviewerId, reason: '我没空' });
    assert.equal(h.status, 'proposed');
    /* accept 前任务执行者仍是 writer。 */
    assert.equal(store.getTask('org-1', taskId)!.assignedToWorkerId, writerId);
    handoff.accept('org-1', h.id, reviewerId);
    assert.equal(store.getHandoff('org-1', h.id)!.status, 'accepted');
    assert.equal(store.getTask('org-1', taskId)!.assignedToWorkerId, reviewerId, 'accept 后改执行者');
  });

  it('propose → reject：任务执行者不变', () => {
    const h = handoff.propose({ orgId: 'org-1', taskId, fromWorkerId: writerId, toWorkerId: reviewerId });
    handoff.reject('org-1', h.id, reviewerId);
    assert.equal(store.getHandoff('org-1', h.id)!.status, 'rejected');
    assert.equal(store.getTask('org-1', taskId)!.assignedToWorkerId, writerId, 'reject 不改执行者');
  });

  it('propose → cancel（发起者撤回）', () => {
    const h = handoff.propose({ orgId: 'org-1', taskId, fromWorkerId: writerId, toWorkerId: reviewerId });
    handoff.cancel('org-1', h.id, writerId);
    assert.equal(store.getHandoff('org-1', h.id)!.status, 'cancelled');
  });

  it('不变量：只有当前执行者能发起交接', () => {
    /* researcher 不是写作任务的执行者 → 不能发起。 */
    assert.throws(
      () => handoff.propose({ orgId: 'org-1', taskId, fromWorkerId: researcherId, toWorkerId: reviewerId }),
      /只有任务当前执行者/,
    );
  });

  it('不变量：不能交接给自己 / 给非组织 worker', () => {
    assert.throws(() => handoff.propose({ orgId: 'org-1', taskId, fromWorkerId: writerId, toWorkerId: writerId }), /不能交接给自己/);
    assert.throws(() => handoff.propose({ orgId: 'org-1', taskId, fromWorkerId: writerId, toWorkerId: 'ghost' }), /不在组织/);
  });

  it('不变量：只有接收者能 accept/reject，只有发起者能 cancel', () => {
    const h = handoff.propose({ orgId: 'org-1', taskId, fromWorkerId: writerId, toWorkerId: reviewerId });
    assert.throws(() => handoff.accept('org-1', h.id, researcherId), /只有接收者能接受/);
    assert.throws(() => handoff.reject('org-1', h.id, researcherId), /只有接收者能拒绝/);
    assert.throws(() => handoff.cancel('org-1', h.id, reviewerId), /只有发起者能撤回/);
  });

  it('不变量：已响应的交接不能再响应（状态机）', () => {
    const h = handoff.propose({ orgId: 'org-1', taskId, fromWorkerId: writerId, toWorkerId: reviewerId });
    handoff.accept('org-1', h.id, reviewerId);
    assert.throws(() => handoff.reject('org-1', h.id, reviewerId), InvalidHandoffError);
    assert.throws(() => handoff.accept('org-1', h.id, reviewerId), /已是 accepted/);
  });

  it('不变量（Codex 复审）：陈旧交接不能抢走已交接出去的任务', () => {
    /* writer 同时提两个交接：A→reviewer 和 A→researcher。reviewer 先 accept（任务到 reviewer）。
     * 此后旧的 A→researcher 不能再被 accept 抢走任务（任务当前执行者已不是 writer）。 */
    const h1 = handoff.propose({ orgId: 'org-1', taskId, fromWorkerId: writerId, toWorkerId: reviewerId });
    const h2 = handoff.propose({ orgId: 'org-1', taskId, fromWorkerId: writerId, toWorkerId: researcherId });
    handoff.accept('org-1', h1.id, reviewerId);
    assert.equal(store.getTask('org-1', taskId)!.assignedToWorkerId, reviewerId);
    /* 陈旧 h2 accept → 拒绝（任务执行者已变），任务仍在 reviewer。 */
    assert.throws(() => handoff.accept('org-1', h2.id, researcherId), /陈旧交接|执行者已变/);
    assert.equal(store.getTask('org-1', taskId)!.assignedToWorkerId, reviewerId, '陈旧交接没抢走任务');
    /* 事务回滚锚点（Codex 复审）：失败的 accept 不留半状态，h2 仍是 proposed（状态转移已回滚）。 */
    assert.equal(store.getHandoff('org-1', h2.id)!.status, 'proposed', '失败 accept 回滚，h2 仍 proposed');
  });

  it('交接历史可观测：listHandoffsByTask', () => {
    handoff.propose({ orgId: 'org-1', taskId, fromWorkerId: writerId, toWorkerId: reviewerId });
    assert.equal(store.listHandoffsByTask('org-1', taskId).length, 1);
  });

  it('租户隔离：A 的交接 B 看不到', () => {
    const h = handoff.propose({ orgId: 'org-1', taskId, fromWorkerId: writerId, toWorkerId: reviewerId });
    const storeB = new OrgWorkforceStore(db, 'tenant-b');
    assert.equal(storeB.getHandoff('org-1', h.id), undefined);
  });
});
