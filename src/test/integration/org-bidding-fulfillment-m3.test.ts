/**
 * 双边工单市场 M3（ADR-0058）——org 接单后执行 + 验收结算入金库（完整双边闭环）。
 *
 * 端到端：发布工单 → org 领取 → 发布者确认委派 → org 启动(runGoal 分解) → org 提交 → 发布者验收 → 报酬入组织金库。
 * 守红线：发布者鉴权、确认才实施、结算入 org wallet、幂等。
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDatabase } from '../../storage/database.js';
import { runDslSqliteMigrations } from '../../storage/index.js';
import type { IDatabase } from '../../storage/database.js';
import { OrgWorkforceStore } from '../../storage/org-workforce-store.js';
import { OrgChartService, type WorkerSpec } from '../../workforce/org-chart-service.js';
import { OrgBiddingService, OrgAssignmentStateError, NotPublisherError } from '../../workforce/org-bidding-service.js';
import { GOAL_TYPE_CONTENT_PIECE } from '../../workforce/decomposition-playbook.js';

describe('双边市场 M3（org 接单执行 + 验收结算入金库）', () => {
  let db: IDatabase;
  let store: OrgWorkforceStore;
  let svc: OrgBiddingService;
  let clock: number;
  let counter: number;
  const PUBLISHER = 'user-publisher';

  /** content_piece playbook 需要的岗位：researcher_ic/writer_ic/reviewer_ic/publisher_ic 全是 lead 直接下属。 */
  function contentPod(): WorkerSpec[] {
    return [
      { roleCode: 'lead', title: '主编', jobFamily: 'manager', seniority: 'lead', displayName: '主编', personaId: 'p-lead', managerRoleCode: null },
      { roleCode: 'researcher_ic', title: '研究', jobFamily: 'ic', seniority: 'ic', displayName: '研究', personaId: 'p-r', managerRoleCode: 'lead' },
      { roleCode: 'writer_ic', title: '写作', jobFamily: 'ic', seniority: 'ic', displayName: '写作', personaId: 'p-w', managerRoleCode: 'lead' },
      { roleCode: 'reviewer_ic', title: '审核', jobFamily: 'ic', seniority: 'ic', displayName: '审核', personaId: 'p-rv', managerRoleCode: 'lead' },
      { roleCode: 'publisher_ic', title: '发布', jobFamily: 'ic', seniority: 'ic', displayName: '发布', personaId: 'p-p', managerRoleCode: 'lead' },
    ];
  }
  let leadId: string;
  function bootstrapOrg(orgId: string): void {
    const chart = new OrgChartService(store, () => clock, () => `${orgId}-id-${++counter}`);
    const boot = chart.bootstrap(orgId, contentPod());
    leadId = boot.workerIdByRole.get('lead')!;
  }
  function seedOpenTask(taskId: string, reward = 500, publisher = PUBLISHER): void {
    db.exec('PRAGMA foreign_keys = OFF');
    db.prepare(
      `INSERT INTO marketplace_tasks (id, tenant_id, publisher_user_id, title, description, category, reward, currency, status, published_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)`,
    ).run(taskId, 't1', publisher, '写一篇文章', '客户工单', 'writing', reward, 'CRED', clock, clock, clock);
  }

  beforeEach(() => {
    db = createMemoryDatabase();
    runDslSqliteMigrations(db);
    store = new OrgWorkforceStore(db, 't1');
    clock = 1000; counter = 0;
    svc = new OrgBiddingService(store, () => clock, () => `id-${++counter}`);
    bootstrapOrg('acme');
  });

  it('★完整双边闭环：领取→确认委派→启动分解→提交→验收→入金库★', () => {
    seedOpenTask('task-1', 500);
    /* 1. org 领取 */
    svc.applyAsOrg({ taskId: 'task-1', orgId: 'acme' });
    /* 2. 发布者确认委派 */
    svc.confirmAssignToOrg({ taskId: 'task-1', orgId: 'acme', actorUserId: PUBLISHER });
    /* 3. org 启动执行（runGoal 分解 content_piece） */
    const started = svc.startOrgTask({ taskId: 'task-1', orgId: 'acme', managerWorkerId: leadId, goalType: GOAL_TYPE_CONTENT_PIECE });
    assert.equal(started.goal.taskCount, 4, 'content_piece 分解 4 步');
    assert.equal(started.assignment.status, 'in_progress', '指派 in_progress');
    assert.ok(started.assignment.orgGoalId, '回填 org_goal_id');
    /* 目标带溯源到工单。 */
    assert.equal(store.getGoal('acme', started.goal.goalId)!.sourceMarketplaceTaskId, 'task-1', '目标溯源工单');
    /* 4. org 提交 */
    const submitted = svc.submitOrgTask({ taskId: 'task-1', orgId: 'acme' });
    assert.equal(submitted.status, 'submitted');
    /* 5. 发布者验收 → 结算入金库 */
    const accepted = svc.acceptOrgTask({ taskId: 'task-1', actorUserId: PUBLISHER, platformPct: 20 });
    assert.equal(accepted.assignment.status, 'accepted');
    assert.ok(accepted.settlement, '产生结算');
    assert.equal(accepted.settlement!.totalAmountMinor, 50000, '500 元 = 50000 分');
    assert.equal(accepted.settlement!.orgAmountMinor, 40000, '组织净留存 40000');
    assert.equal(accepted.walletBalance, 40000, '金库余额 40000');
    /* 工单 completed。 */
    assert.equal(store.getMarketplaceTaskBrief('task-1')!.status, 'completed', '工单完工');
  });

  it('★红线：非发布者验收 → 拒★', () => {
    seedOpenTask('task-1');
    svc.applyAsOrg({ taskId: 'task-1', orgId: 'acme' });
    svc.confirmAssignToOrg({ taskId: 'task-1', orgId: 'acme', actorUserId: PUBLISHER });
    svc.startOrgTask({ taskId: 'task-1', orgId: 'acme', managerWorkerId: leadId, goalType: GOAL_TYPE_CONTENT_PIECE });
    svc.submitOrgTask({ taskId: 'task-1', orgId: 'acme' });
    assert.throws(() => svc.acceptOrgTask({ taskId: 'task-1', actorUserId: 'not-publisher' }), NotPublisherError);
  });

  it('★状态守：未确认委派不能启动★', () => {
    seedOpenTask('task-1');
    svc.applyAsOrg({ taskId: 'task-1', orgId: 'acme' });
    /* 没 confirmAssign 就 start → 无 assignment 拒。 */
    assert.throws(() => svc.startOrgTask({ taskId: 'task-1', orgId: 'acme', managerWorkerId: leadId, goalType: GOAL_TYPE_CONTENT_PIECE }), OrgAssignmentStateError);
  });

  it('★状态守：未启动不能提交★', () => {
    seedOpenTask('task-1');
    svc.applyAsOrg({ taskId: 'task-1', orgId: 'acme' });
    svc.confirmAssignToOrg({ taskId: 'task-1', orgId: 'acme', actorUserId: PUBLISHER });
    /* assigned 但未 start（in_progress）→ submit 拒。 */
    assert.throws(() => svc.submitOrgTask({ taskId: 'task-1', orgId: 'acme' }), OrgAssignmentStateError);
  });

  it('★验收幂等：reward=0 工单跳过结算只标完工★', () => {
    seedOpenTask('task-1', 0);
    svc.applyAsOrg({ taskId: 'task-1', orgId: 'acme' });
    svc.confirmAssignToOrg({ taskId: 'task-1', orgId: 'acme', actorUserId: PUBLISHER });
    svc.startOrgTask({ taskId: 'task-1', orgId: 'acme', managerWorkerId: leadId, goalType: GOAL_TYPE_CONTENT_PIECE });
    svc.submitOrgTask({ taskId: 'task-1', orgId: 'acme' });
    const accepted = svc.acceptOrgTask({ taskId: 'task-1', actorUserId: PUBLISHER });
    assert.equal(accepted.settlement, null, 'reward=0 不结算');
    assert.equal(accepted.assignment.status, 'accepted', '仍正常验收');
    assert.equal(store.getMarketplaceTaskBrief('task-1')!.status, 'completed', '工单完工');
  });
});
