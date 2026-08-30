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

  /* ⚠️ 审计 #406：`markMarketplaceTaskCompleted` 的返回值此前被**丢弃**。
   *
   * 它的 SQL 带 `AND status = 'accepted'` 守卫，工单不在 accepted 时静默返回
   * false，**而结算照常执行**。实测：工单被撤单流程改成 `cancelled` 后，
   * 发布者仍能验收并付款 —— 一笔已取消的 500 CRED 工单向组织金库付了
   * 40000 minor，且工单状态永远停在 cancelled（账上看不出这笔钱对应哪个已完成工单）。
   *
   * 同一函数另外两处状态迁移都检查了返回值并抛错，唯独这条没查。 */
  it('★审计 #406：工单已 cancelled 时验收必须拒绝且不得付款★', () => {
    seedOpenTask('task-1');
    svc.applyAsOrg({ taskId: 'task-1', orgId: 'acme' });
    svc.confirmAssignToOrg({ taskId: 'task-1', orgId: 'acme', actorUserId: PUBLISHER });
    svc.startOrgTask({ taskId: 'task-1', orgId: 'acme', managerWorkerId: leadId, goalType: GOAL_TYPE_CONTENT_PIECE });
    svc.submitOrgTask({ taskId: 'task-1', orgId: 'acme' });

    /* ★竞态窗口★：撤单流程把工单推到 cancelled（指派仍是 submitted，
     * 故事务外的 `assign.status !== 'submitted'` 前置判定**不会**拦截，
     * 互斥只剩 markMarketplaceTaskCompleted 的 CAS）。 */
    db.prepare<void>(`UPDATE marketplace_tasks SET status = 'cancelled' WHERE id = ?`).run('task-1');

    const balanceBefore = store.getOrgWallet('acme')?.balance ?? 0;

    assert.throws(
      () => svc.acceptOrgTask({ taskId: 'task-1', actorUserId: PUBLISHER, platformPct: 20 }),
      OrgAssignmentStateError,
      '已取消工单不得验收成功',
    );

    /* 变异实测：丢弃 CAS 返回值 → 金库被打进 40000，而工单仍是 cancelled。 */
    assert.equal(store.getOrgWallet('acme')?.balance ?? 0, balanceBefore, '拒绝路径不得动金库');
    assert.equal(store.getMarketplaceTaskBrief('task-1')!.status, 'cancelled', '工单状态不变');
    const settlements = db.prepare<{ n: number }>(
      `SELECT COUNT(*) AS n FROM org_wallet_settlements WHERE source_marketplace_task_id = ?`,
    ).get('task-1')!.n;
    assert.equal(settlements, 0, '不得留下结算行');
  });

  /* ⚠️ 审计 #440-1：`startOrgTask` 此前把 `runGoal`（落库一整棵目标树：
   * org_goals + 全部 org_tasks + 委派边）放在事务外、且排在 CAS **之前**。
   * CAS 失败时抛 409，但那棵树**已经提交**——成为孤儿：goal 挂在 org 上、
   * 其下任务处于 delegated 可被正常领取执行，而它并不对应任何有效指派。
   *
   * ★竞态窗口★：只推进 CAS 谓词读的那一列（assignment.status），其余留在
   * 能通过**事务外前置判定**的旧值上。若把状态推成终态，`:123` 的
   * `assign.status !== 'assigned'` 会先拦下，根本进不到 CAS——那就测不到东西了。
   * （同文件 #406 用的是同一手法。） */
  it('★审计 #440-1：CAS 失败时不得留下孤儿目标树★', () => {
    seedOpenTask('task-1');
    svc.applyAsOrg({ taskId: 'task-1', orgId: 'acme' });
    svc.confirmAssignToOrg({ taskId: 'task-1', orgId: 'acme', actorUserId: PUBLISHER });

    const assign = store.getLatestOrgTaskAssignment('task-1')!;
    const goalsBefore = db.prepare<{ n: number }>(
      `SELECT COUNT(*) AS n FROM org_goals WHERE tenant_id = ? AND org_id = ?`,
    ).get('t1', 'acme')!.n;
    const tasksBefore = db.prepare<{ n: number }>(
      `SELECT COUNT(*) AS n FROM org_tasks WHERE tenant_id = ? AND org_id = ?`,
    ).get('t1', 'acme')!.n;

    /* ★竞态窗口的构造★
     *
     * 前置判定（`:124` 的 `assign.status !== 'assigned'`）与 CAS 读的是**同一行**，
     * 所以先把状态推走会被前置判定当场拦下，根本走不到建树/CAS —— 实测抛的是
     * 「指派状态 in_progress，不能启动」，跟本用例要测的东西无关。
     *
     * 真实并发里，另一方是在「本方通过前置判定之后、CAS 之前」抢走状态的。
     * 单进程复现就必须在这两点之间插入交错：包一层 store，让
     * `getMarketplaceTaskBrief`（前置判定的最后一步）**返回之后**把状态推走。
     * 这样前置判定拿到的是 assigned（通过），而 CAS 面对的已是 in_progress（失败）。 */
    let raced = false;
    const racingStore = new Proxy(store, {
      get(target, prop, recv) {
        const v = Reflect.get(target, prop, recv);
        if (prop !== 'getMarketplaceTaskBrief' || typeof v !== 'function') return v;
        return (...args: unknown[]) => {
          const out = (v as (...a: unknown[]) => unknown).apply(target, args);
          if (!raced) {
            raced = true;
            db.prepare<void>(
              `UPDATE task_org_assignments SET status = 'in_progress' WHERE tenant_id = ? AND id = ?`,
            ).run('t1', assign.id);
          }
          return out;
        };
      },
    });
    const racingSvc = new OrgBiddingService(racingStore, () => clock, () => `race-${++counter}`);

    assert.throws(
      () => racingSvc.startOrgTask({
        taskId: 'task-1', orgId: 'acme',
        managerWorkerId: leadId, goalType: GOAL_TYPE_CONTENT_PIECE,
      }),
      OrgAssignmentStateError,
      'CAS 失败必须抛错',
    );
    assert.ok(raced, '窗口必须真的被注入过（否则本用例什么都没测）');

    /* 核心断言：抛错之后**一条都不能留**。
     * 变异实测：把 runGoal 移回事务外/CAS 之前 → 这两条转红
     * （org_goals +1、org_tasks +4，全是无人回收的孤儿）。 */
    const goalsAfter = db.prepare<{ n: number }>(
      `SELECT COUNT(*) AS n FROM org_goals WHERE tenant_id = ? AND org_id = ?`,
    ).get('t1', 'acme')!.n;
    const tasksAfter = db.prepare<{ n: number }>(
      `SELECT COUNT(*) AS n FROM org_tasks WHERE tenant_id = ? AND org_id = ?`,
    ).get('t1', 'acme')!.n;
    assert.equal(goalsAfter, goalsBefore, 'CAS 失败不得留下孤儿 goal');
    assert.equal(tasksAfter, tasksBefore, 'CAS 失败不得留下孤儿 org_tasks');
  });

  /* 对照：正常路径仍能启动（别把功能一起关掉）。 */
  it('对照：#440-1 修复后正常启动仍建树并回填 goalId', () => {
    seedOpenTask('task-2');
    svc.applyAsOrg({ taskId: 'task-2', orgId: 'acme' });
    svc.confirmAssignToOrg({ taskId: 'task-2', orgId: 'acme', actorUserId: PUBLISHER });

    const started = svc.startOrgTask({
      taskId: 'task-2', orgId: 'acme',
      managerWorkerId: leadId, goalType: GOAL_TYPE_CONTENT_PIECE,
    });
    assert.equal(started.assignment.status, 'in_progress');
    assert.ok(started.assignment.orgGoalId, '必须回填 org_goal_id（CAS 前置后仍要回填）');
    assert.equal(started.goal.taskCount, 4);
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
