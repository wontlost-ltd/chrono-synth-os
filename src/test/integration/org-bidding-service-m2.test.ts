/**
 * 双边工单市场 M2（ADR-0058）service 测试——org 领取 + 发布者确认委派 + 红线守卫。
 *
 * 验证：org 领取登记申请（不触发执行）；发布者鉴权（只发布者能确认委派）；委派后工单 open→accepted +
 * assignee_kind='org'；只能委派给已申请的组织；CAS 防并发双 assign；向后兼容（persona 流程不受影响）。
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDatabase } from '../../storage/database.js';
import { runDslSqliteMigrations } from '../../storage/index.js';
import type { IDatabase } from '../../storage/database.js';
import { OrgWorkforceStore } from '../../storage/org-workforce-store.js';
import { OrgChartService, type WorkerSpec } from '../../workforce/org-chart-service.js';
import {
  OrgBiddingService, TaskNotAvailableError, NotPublisherError,
  NoOrgApplicationError, DuplicateOrgApplicationError, OrgNotFoundError,
} from '../../workforce/org-bidding-service.js';

describe('OrgBiddingService M2（org 竞标 + 发布者确认委派）', () => {
  let db: IDatabase;
  let store: OrgWorkforceStore;
  let svc: OrgBiddingService;
  let clock: number;
  let counter: number;
  const PUBLISHER = 'user-publisher';

  function pod(prefix: string): WorkerSpec[] {
    return [
      { roleCode: 'ceo', title: 'CEO', jobFamily: 'exec', seniority: 'exec', displayName: `${prefix}-CEO`, personaId: `p-${prefix}-ceo`, managerRoleCode: null },
      { roleCode: 'ic', title: 'IC', jobFamily: 'ic', seniority: 'ic', displayName: `${prefix}-IC`, personaId: `p-${prefix}-ic`, managerRoleCode: 'ceo' },
    ];
  }
  function bootstrapOrg(orgId: string): void {
    const chart = new OrgChartService(store, () => clock, () => `${orgId}-id-${++counter}`);
    chart.bootstrap(orgId, pod(orgId));
  }
  /** 种一个 open 工单（直接插 marketplace_tasks；关 FK 因 publisher/users 在本测试无关）。 */
  function seedOpenTask(taskId: string, publisher = PUBLISHER): void {
    db.exec('PRAGMA foreign_keys = OFF');
    db.prepare(
      `INSERT INTO marketplace_tasks (id, tenant_id, publisher_user_id, title, description, category, reward, currency, status, published_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)`,
    ).run(taskId, 't1', publisher, '工单标题', '描述', 'general', 500, 'CRED', clock, clock, clock);
  }
  function taskStatus(taskId: string): string {
    return store.getMarketplaceTaskBrief(taskId)!.status;
  }

  beforeEach(() => {
    db = createMemoryDatabase();
    runDslSqliteMigrations(db);
    store = new OrgWorkforceStore(db, 't1');
    clock = 1000; counter = 0;
    svc = new OrgBiddingService(store, () => clock, () => `id-${++counter}`);
    bootstrapOrg('acme');
    bootstrapOrg('beta');
  });

  /* ── 领取 ── */

  it('★org 领取 open 工单：登记申请，工单仍 open（不触发执行）★', () => {
    seedOpenTask('task-1');
    const app = svc.applyAsOrg({ taskId: 'task-1', orgId: 'acme' });
    assert.equal(app.status, 'submitted');
    assert.ok(app.rankingScore >= 1, '排序分=在职员工数');
    assert.equal(taskStatus('task-1'), 'open', '申请不改工单状态（红线2：确认才实施）');
  });

  it('★领取守：工单不存在 / 非 open → 拒★', () => {
    assert.throws(() => svc.applyAsOrg({ taskId: 'ghost', orgId: 'acme' }), TaskNotAvailableError);
    seedOpenTask('task-1');
    /* 先委派掉（变 accepted），再申请应拒。 */
    svc.applyAsOrg({ taskId: 'task-1', orgId: 'acme' });
    svc.confirmAssignToOrg({ taskId: 'task-1', orgId: 'acme', actorUserId: PUBLISHER });
    assert.throws(() => svc.applyAsOrg({ taskId: 'task-1', orgId: 'beta' }), TaskNotAvailableError, '非 open 拒');
  });

  it('★领取守：组织不存在 → 拒★', () => {
    seedOpenTask('task-1');
    assert.throws(() => svc.applyAsOrg({ taskId: 'task-1', orgId: 'ghost-org' }), OrgNotFoundError);
  });

  it('★领取守：重复申请 → 拒★', () => {
    seedOpenTask('task-1');
    svc.applyAsOrg({ taskId: 'task-1', orgId: 'acme' });
    assert.throws(() => svc.applyAsOrg({ taskId: 'task-1', orgId: 'acme' }), DuplicateOrgApplicationError);
  });

  it('★多组织竞标：两个组织都申请，发布者看到 2 个申请★', () => {
    seedOpenTask('task-1');
    svc.applyAsOrg({ taskId: 'task-1', orgId: 'acme' });
    svc.applyAsOrg({ taskId: 'task-1', orgId: 'beta' });
    assert.equal(store.listOrgTaskApplications('task-1').length, 2, '两个组织竞标');
  });

  /* ── 发布者确认委派 ── */

  it('★发布者确认委派给 acme：工单 open→accepted + assignee_kind=org★', () => {
    seedOpenTask('task-1');
    svc.applyAsOrg({ taskId: 'task-1', orgId: 'acme' });
    const assign = svc.confirmAssignToOrg({ taskId: 'task-1', orgId: 'acme', actorUserId: PUBLISHER });
    assert.equal(assign.status, 'assigned');
    assert.equal(assign.orgId, 'acme');
    const task = store.getMarketplaceTaskBrief('task-1')!;
    assert.equal(task.status, 'accepted', '工单 accepted');
    assert.equal(task.assigneeKind, 'org', 'assignee_kind=org');
    assert.equal(task.assigneeOrgId, 'acme', 'assignee_org_id=acme');
    /* 申请标 assigned。 */
    assert.equal(store.getOrgTaskApplication('task-1', 'acme')!.status, 'assigned');
  });

  it('★红线3：非发布者确认委派 → 拒（NotPublisherError）★', () => {
    seedOpenTask('task-1', PUBLISHER);
    svc.applyAsOrg({ taskId: 'task-1', orgId: 'acme' });
    assert.throws(() => svc.confirmAssignToOrg({ taskId: 'task-1', orgId: 'acme', actorUserId: 'someone-else' }), NotPublisherError);
    /* 工单仍 open（未被非发布者改动）。 */
    assert.equal(taskStatus('task-1'), 'open');
  });

  it('★委派守：委派给没申请的组织 → 拒★', () => {
    seedOpenTask('task-1');
    svc.applyAsOrg({ taskId: 'task-1', orgId: 'acme' });
    /* beta 没申请，发布者不能委派给它。 */
    assert.throws(() => svc.confirmAssignToOrg({ taskId: 'task-1', orgId: 'beta', actorUserId: PUBLISHER }), NoOrgApplicationError);
  });

  it('★委派后落选组织申请仍 submitted（只 assigned 中选者）★', () => {
    seedOpenTask('task-1');
    svc.applyAsOrg({ taskId: 'task-1', orgId: 'acme' });
    svc.applyAsOrg({ taskId: 'task-1', orgId: 'beta' });
    svc.confirmAssignToOrg({ taskId: 'task-1', orgId: 'acme', actorUserId: PUBLISHER });
    assert.equal(store.getOrgTaskApplication('task-1', 'acme')!.status, 'assigned', '中选 acme=assigned');
    assert.equal(store.getOrgTaskApplication('task-1', 'beta')!.status, 'submitted', '落选 beta 仍 submitted');
  });

  it('★CAS 防并发双 assign：工单已 accepted 后再委派 → 拒★', () => {
    seedOpenTask('task-1');
    svc.applyAsOrg({ taskId: 'task-1', orgId: 'acme' });
    svc.applyAsOrg({ taskId: 'task-1', orgId: 'beta' });
    svc.confirmAssignToOrg({ taskId: 'task-1', orgId: 'acme', actorUserId: PUBLISHER });
    /* beta 也曾 submitted，但工单已 accepted → 再委派 beta 应被 requireOpenTask 挡。 */
    assert.throws(() => svc.confirmAssignToOrg({ taskId: 'task-1', orgId: 'beta', actorUserId: PUBLISHER }), TaskNotAvailableError);
  });

  it('★向后兼容：org 申请不污染 persona task_applications★', () => {
    seedOpenTask('task-1');
    svc.applyAsOrg({ taskId: 'task-1', orgId: 'acme' });
    /* persona 的 task_applications 表应为空（org 走平行表）。 */
    const personaApps = db.prepare<{ c: number }>('SELECT COUNT(*) AS c FROM task_applications').get()!;
    assert.equal(Number(personaApps.c), 0, 'persona 申请表不受 org 申请影响');
  });
});
