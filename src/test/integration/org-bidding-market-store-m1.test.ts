/**
 * 双边工单市场 M1（ADR-0058）store 层测试——org 申请/指派平行表原语 + 向后兼容（persona 表零改动）。
 *
 * org 接单走平行表 task_org_applications/task_org_assignments（不污染 persona 的 task_applications）。
 * 验证：申请唯一/状态流转/发布者视角列表/org 视角列表/指派 CAS；marketplace_tasks 新列默认 persona（向后兼容）。
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDatabase } from '../../storage/database.js';
import { runDslSqliteMigrations } from '../../storage/index.js';
import type { IDatabase } from '../../storage/database.js';
import { OrgWorkforceStore } from '../../storage/org-workforce-store.js';

describe('双边市场 M1 store（org 申请/指派平行表 + 向后兼容）', () => {
  let db: IDatabase;
  let store: OrgWorkforceStore;
  let clock: number;

  beforeEach(() => {
    db = createMemoryDatabase();
    runDslSqliteMigrations(db);
    store = new OrgWorkforceStore(db, 't1');
    clock = 1000;
  });

  /* ── org 申请 ── */

  it('★org 领取工单：插入申请 + 幂等查★', () => {
    store.insertOrgTaskApplication({ id: 'a1', taskId: 'task-1', orgId: 'acme', rankingScore: 0, status: 'submitted', createdAt: clock, updatedAt: clock });
    const app = store.getOrgTaskApplication('task-1', 'acme')!;
    assert.equal(app.orgId, 'acme');
    assert.equal(app.status, 'submitted');
  });

  it('★申请唯一：同 org 对同工单只能申请一次★', () => {
    store.insertOrgTaskApplication({ id: 'a1', taskId: 'task-1', orgId: 'acme', rankingScore: 0, status: 'submitted', createdAt: clock, updatedAt: clock });
    assert.throws(() => store.insertOrgTaskApplication({ id: 'a2', taskId: 'task-1', orgId: 'acme', rankingScore: 0, status: 'submitted', createdAt: clock, updatedAt: clock }), /UNIQUE|constraint/i);
  });

  it('★发布者视角：列某工单所有 org 申请（分降序）★', () => {
    store.insertOrgTaskApplication({ id: 'a1', taskId: 'task-1', orgId: 'acme', rankingScore: 5, status: 'submitted', createdAt: clock, updatedAt: clock });
    store.insertOrgTaskApplication({ id: 'a2', taskId: 'task-1', orgId: 'beta', rankingScore: 9, status: 'submitted', createdAt: clock + 1, updatedAt: clock + 1 });
    const apps = store.listOrgTaskApplications('task-1');
    assert.equal(apps.length, 2);
    assert.equal(apps[0]!.orgId, 'beta', '高分在前');
  });

  it('★org 视角：列某 org 自己的申请★', () => {
    store.insertOrgTaskApplication({ id: 'a1', taskId: 'task-1', orgId: 'acme', rankingScore: 0, status: 'submitted', createdAt: clock, updatedAt: clock });
    store.insertOrgTaskApplication({ id: 'a2', taskId: 'task-2', orgId: 'acme', rankingScore: 0, status: 'submitted', createdAt: clock + 1, updatedAt: clock + 1 });
    store.insertOrgTaskApplication({ id: 'a3', taskId: 'task-1', orgId: 'beta', rankingScore: 0, status: 'submitted', createdAt: clock, updatedAt: clock });
    assert.equal(store.listOrgApplicationsByOrg('acme').length, 2, 'acme 有 2 个申请');
  });

  it('★申请状态流转：submitted→assigned/rejected★', () => {
    store.insertOrgTaskApplication({ id: 'a1', taskId: 'task-1', orgId: 'acme', rankingScore: 0, status: 'submitted', createdAt: clock, updatedAt: clock });
    assert.ok(store.setOrgTaskApplicationStatus('task-1', 'acme', 'assigned', clock + 10));
    assert.equal(store.getOrgTaskApplication('task-1', 'acme')!.status, 'assigned');
  });

  /* ── org 指派 ── */

  it('★发布者确认委派：插入指派 + 取最新★', () => {
    store.insertOrgTaskAssignment({ id: 'as1', taskId: 'task-1', orgId: 'acme', applicationId: 'a1', orgGoalId: null, status: 'assigned', assignedAt: clock, submittedAt: null, completedAt: null, createdAt: clock, updatedAt: clock });
    const as = store.getLatestOrgTaskAssignment('task-1')!;
    assert.equal(as.orgId, 'acme');
    assert.equal(as.status, 'assigned');
    assert.equal(as.applicationId, 'a1');
  });

  it('★指派状态 CAS：assigned→in_progress 写 org_goal_id★', () => {
    store.insertOrgTaskAssignment({ id: 'as1', taskId: 'task-1', orgId: 'acme', applicationId: null, orgGoalId: null, status: 'assigned', assignedAt: clock, submittedAt: null, completedAt: null, createdAt: clock, updatedAt: clock });
    assert.ok(store.updateOrgTaskAssignmentStatus('as1', 'assigned', 'in_progress', clock + 5, 'goal-99'), 'CAS 成功');
    const as = store.getLatestOrgTaskAssignment('task-1')!;
    assert.equal(as.status, 'in_progress');
    assert.equal(as.orgGoalId, 'goal-99', 'org_goal_id 写入');
    /* CAS 守：from 不匹配 → 失败。 */
    assert.equal(store.updateOrgTaskAssignmentStatus('as1', 'assigned', 'submitted', clock + 6), false, 'from 不符 CAS 失败');
  });

  it('★指派完工时间戳：submitted/accepted 写对应时间★', () => {
    store.insertOrgTaskAssignment({ id: 'as1', taskId: 'task-1', orgId: 'acme', applicationId: null, orgGoalId: null, status: 'assigned', assignedAt: clock, submittedAt: null, completedAt: null, createdAt: clock, updatedAt: clock });
    store.updateOrgTaskAssignmentStatus('as1', 'assigned', 'submitted', clock + 10);
    assert.equal(store.getLatestOrgTaskAssignment('task-1')!.submittedAt, clock + 10, 'submitted_at 写入');
    store.updateOrgTaskAssignmentStatus('as1', 'submitted', 'accepted', clock + 20);
    assert.equal(store.getLatestOrgTaskAssignment('task-1')!.completedAt, clock + 20, 'completed_at 写入');
  });

  it('★org 视角：列委派给某 org 的工单★', () => {
    store.insertOrgTaskAssignment({ id: 'as1', taskId: 'task-1', orgId: 'acme', applicationId: null, orgGoalId: null, status: 'assigned', assignedAt: clock, submittedAt: null, completedAt: null, createdAt: clock, updatedAt: clock });
    store.insertOrgTaskAssignment({ id: 'as2', taskId: 'task-2', orgId: 'acme', applicationId: null, orgGoalId: null, status: 'assigned', assignedAt: clock + 1, submittedAt: null, completedAt: null, createdAt: clock + 1, updatedAt: clock + 1 });
    assert.equal(store.listOrgAssignmentsByOrg('acme').length, 2);
  });

  /* ── 向后兼容 ── */

  it('★向后兼容：marketplace_tasks 新列默认 persona + publisher_verified=0★', () => {
    /* 直接插一行 persona 工单（只填旧列），新列应取默认。关 FK（publisher_user_id 的 users FK 与本测试无关）。 */
    db.exec('PRAGMA foreign_keys = OFF');
    db.prepare(
      `INSERT INTO marketplace_tasks (id, tenant_id, publisher_user_id, title, description, category, reward, currency, status, published_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('t-legacy', 't1', 'pub-1', '旧工单', 'desc', 'general', 100, 'CRED', 'open', clock, clock, clock);
    const row = db.prepare<{ assignee_kind: string; assignee_org_id: unknown; publisher_verified: number }>(
      `SELECT assignee_kind, assignee_org_id, publisher_verified FROM marketplace_tasks WHERE id = ?`,
    ).get('t-legacy')!;
    assert.equal(row.assignee_kind, 'persona', '新列默认 persona');
    assert.equal(row.assignee_org_id, null, 'org_id 默认空');
    assert.equal(Number(row.publisher_verified), 0, '验资默认 0（未验资）');
  });

  it('★租户隔离：org 申请跨租户不可见★', () => {
    store.insertOrgTaskApplication({ id: 'a1', taskId: 'task-1', orgId: 'acme', rankingScore: 0, status: 'submitted', createdAt: clock, updatedAt: clock });
    const store2 = new OrgWorkforceStore(db, 't2');
    assert.equal(store2.getOrgTaskApplication('task-1', 'acme'), undefined, 't2 看不到 t1 申请');
  });
});
