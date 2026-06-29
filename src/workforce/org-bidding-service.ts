/**
 * 双边工单市场 org 竞标 service（ADR-0058 M2）——组织领取工单 + 发布者确认委派给组织。
 *
 * 守红线：
 *   - 发布者确认才实施（红线2）：org applyAsOrg 只登记意向，**不触发任何执行/扣费**；
 *   - 发布者鉴权不可绕（红线3）：confirmAssignToOrg 必须 actorUserId === task.publisherUserId；
 *   - assignee XOR（红线4）：标记委派给 org 时 marketplace_tasks.assignee_kind='org' + assignee_org_id；
 *   - 向后兼容（红线1）：org 走平行表，不碰 persona 的 task_applications/task_assignments。
 *
 * M2 只做到「申请 + 确认委派落库」。org 接单后的执行（runGoal 分解）+ 验收结算在 M3 接。
 */

import type { OrgWorkforceStore } from '../storage/org-workforce-store.js';
import type { OrgTaskApplication, OrgTaskAssignment, OrgWalletSettlement, MarketplaceTaskBrief } from './types.js';
import { OrgPlanningService, type RunGoalResult } from './org-planning-service.js';
import { OrgChartService } from './org-chart-service.js';
import { OrgWalletService } from './org-wallet-service.js';

/** 工单不存在 / 不可申请（非 open）。 */
export class TaskNotAvailableError extends Error {
  constructor(message: string) { super(message); this.name = 'TaskNotAvailableError'; }
}
/** 调用者不是工单发布者（确认委派鉴权失败）。 */
export class NotPublisherError extends Error {
  constructor() { super('只有工单发布者能确认委派'); this.name = 'NotPublisherError'; }
}
/** 组织不存在（无任何 worker）。 */
export class OrgNotFoundError extends Error {
  constructor(orgId: string) { super(`组织不存在或无成员：${orgId}`); this.name = 'OrgNotFoundError'; }
}
/** 该组织未申请此工单（不能委派给没申请的组织）。 */
export class NoOrgApplicationError extends Error {
  constructor() { super('该组织未申请此工单，不能委派'); this.name = 'NoOrgApplicationError'; }
}
/** 组织已申请过此工单（重复申请）。 */
export class DuplicateOrgApplicationError extends Error {
  constructor() { super('该组织已申请此工单'); this.name = 'DuplicateOrgApplicationError'; }
}
/** org 指派状态不符合操作前置（如未 assigned 就 start，或未 in_progress 就 submit）。 */
export class OrgAssignmentStateError extends Error {
  constructor(message: string) { super(message); this.name = 'OrgAssignmentStateError'; }
}

export interface ApplyAsOrgInput {
  readonly taskId: string;
  readonly orgId: string;
}

export interface ConfirmAssignToOrgInput {
  readonly taskId: string;
  readonly orgId: string;
  /** 当前登录用户（HTTP 层 currentUser().sub）——必须等于工单发布者。 */
  readonly actorUserId: string;
}

export class OrgBiddingService {
  constructor(
    private readonly store: OrgWorkforceStore,
    private readonly now: () => number,
    private readonly idgen: () => string,
  ) {}

  /**
   * 组织领取一个 open 工单——登记接单意向（不触发执行）。
   * 守：工单存在且 open；组织存在；该组织未重复申请。排序分=组织在职员工数（确定性，非门槛）。
   */
  applyAsOrg(input: ApplyAsOrgInput): OrgTaskApplication {
    const task = this.requireOpenTask(input.taskId);
    void task;
    if (this.store.listWorkers(input.orgId).length === 0) throw new OrgNotFoundError(input.orgId);
    if (this.store.getOrgTaskApplication(input.taskId, input.orgId)) throw new DuplicateOrgApplicationError();

    /* 排序辅助分（D6）：在职员工数，纯计数确定性；发布者自行判断，不作门槛。 */
    const rankingScore = this.store.listWorkers(input.orgId).filter((w) => w.employmentStatus === 'active').length;
    const now = this.now();
    const id = this.idgen();
    this.store.insertOrgTaskApplication({
      id, taskId: input.taskId, orgId: input.orgId, rankingScore, status: 'submitted', createdAt: now, updatedAt: now,
    });
    const app = this.store.getOrgTaskApplication(input.taskId, input.orgId);
    if (!app) throw new Error(`申请落库后查不到（数据异常）：task=${input.taskId} org=${input.orgId}`);
    return app;
  }

  /**
   * 发布者确认把工单委派给某组织——工单 open→accepted，建 org 指派（原子）。M3 接此触发 runGoal 分解。
   * 守：发布者鉴权（actorUserId===publisherUserId）；工单仍 open；该组织有 submitted 申请；CAS 防并发双 assign。
   */
  confirmAssignToOrg(input: ConfirmAssignToOrgInput): OrgTaskAssignment {
    const task = this.requireOpenTask(input.taskId);
    if (task.publisherUserId !== input.actorUserId) throw new NotPublisherError();
    const app = this.store.getOrgTaskApplication(input.taskId, input.orgId);
    if (!app || app.status !== 'submitted') throw new NoOrgApplicationError();

    const now = this.now();
    const assignmentId = this.idgen();
    return this.store.transaction(() => {
      /* CAS 标记工单委派给 org（status='open' 守卫，并发只一个能成功）。 */
      if (!this.store.markMarketplaceTaskAssignedToOrg(input.taskId, input.orgId, now)) {
        throw new TaskNotAvailableError(`工单已被并发委派或状态改变：${input.taskId}`);
      }
      /* 申请标 assigned。 */
      this.store.setOrgTaskApplicationStatus(input.taskId, input.orgId, 'assigned', now);
      /* 建 org 指派。M3 触发 runGoal 后回填 org_goal_id。 */
      this.store.insertOrgTaskAssignment({
        id: assignmentId, taskId: input.taskId, orgId: input.orgId, applicationId: app.id,
        orgGoalId: null, status: 'assigned', assignedAt: now, submittedAt: null, completedAt: null,
        createdAt: now, updatedAt: now,
      });
      const assign = this.store.getLatestOrgTaskAssignment(input.taskId);
      if (!assign) throw new Error(`指派落库后查不到（数据异常）：task=${input.taskId}`);
      return assign;
    });
  }

  /**
   * org 接单方启动执行（M3）——被委派后，org admin 决定用哪个 playbook、由谁分解，触发 runGoal。
   * 守：该 org 是被委派方（最新指派 orgId===orgId 且 status='assigned'）；manager 存在。
   * 效果：runGoal 确定性分解委派（带 sourceMarketplaceTaskId 溯源）→ 回填 org_goal_id + 指派 assigned→in_progress。
   */
  startOrgTask(input: StartOrgTaskInput): { assignment: OrgTaskAssignment; goal: RunGoalResult } {
    const assign = this.store.getLatestOrgTaskAssignment(input.taskId);
    if (!assign || assign.orgId !== input.orgId) throw new OrgAssignmentStateError(`组织 ${input.orgId} 未被委派此工单`);
    if (assign.status !== 'assigned') throw new OrgAssignmentStateError(`指派状态 ${assign.status}，不能启动（需 assigned）`);
    if (!this.store.getWorker(input.orgId, input.managerWorkerId)) throw new OrgNotFoundError(`数字员工不存在：${input.managerWorkerId}`);
    const task = this.store.getMarketplaceTaskBrief(input.taskId);
    if (!task) throw new TaskNotAvailableError(`工单不存在：${input.taskId}`);

    const planning = new OrgPlanningService(this.store, new OrgChartService(this.store, this.now), this.now, this.idgen);
    const goal = planning.runGoal(
      input.orgId, input.managerWorkerId,
      { title: task.title, description: task.description, goalType: input.goalType, sourceMarketplaceTaskId: input.taskId },
      this.store.workerIdByRole(input.orgId),
    );
    /* 回填 org_goal_id + 指派进 in_progress。 */
    if (!this.store.updateOrgTaskAssignmentStatus(assign.id, 'assigned', 'in_progress', this.now(), goal.goalId)) {
      throw new OrgAssignmentStateError('指派状态并发改变，启动失败，请重试');
    }
    const updated = this.store.getLatestOrgTaskAssignment(input.taskId)!;
    return { assignment: updated, goal };
  }

  /**
   * org 完工提交（M3）——org admin 标记「已完成，提交给发布者验收」。指派 in_progress→submitted。
   * 守：该 org 是被委派方；指派处于 in_progress。
   */
  submitOrgTask(input: { taskId: string; orgId: string }): OrgTaskAssignment {
    const assign = this.store.getLatestOrgTaskAssignment(input.taskId);
    if (!assign || assign.orgId !== input.orgId) throw new OrgAssignmentStateError(`组织 ${input.orgId} 未被委派此工单`);
    if (assign.status !== 'in_progress') throw new OrgAssignmentStateError(`指派状态 ${assign.status}，不能提交（需 in_progress）`);
    if (!this.store.updateOrgTaskAssignmentStatus(assign.id, 'in_progress', 'submitted', this.now())) {
      throw new OrgAssignmentStateError('指派状态并发改变，提交失败，请重试');
    }
    return this.store.getLatestOrgTaskAssignment(input.taskId)!;
  }

  /**
   * 发布者验收 org 工单并结算入组织金库（M3）——两方分账（复用 OrgWalletService）。
   * 守：发布者鉴权（actorUserId===publisherUserId）；指派 submitted；原子（指派 accepted + 工单 completed + 结算）。
   * reward=0 的工单跳过结算（只标完工）。幂等结算（sourceMarketplaceTaskId 键）。
   */
  acceptOrgTask(input: AcceptOrgTaskInput): { assignment: OrgTaskAssignment; settlement: OrgWalletSettlement | null; walletBalance: number } {
    const task = this.store.getMarketplaceTaskBrief(input.taskId);
    if (!task) throw new TaskNotAvailableError(`工单不存在：${input.taskId}`);
    if (task.publisherUserId !== input.actorUserId) throw new NotPublisherError();
    const assign = this.store.getLatestOrgTaskAssignment(input.taskId);
    if (!assign || assign.status !== 'submitted') throw new OrgAssignmentStateError('无 submitted 指派可验收');

    const platformPct = input.platformPct ?? 20;
    const now = this.now();
    return this.store.transaction(() => {
      /* 指派 submitted→accepted。 */
      if (!this.store.updateOrgTaskAssignmentStatus(assign.id, 'submitted', 'accepted', now)) {
        throw new OrgAssignmentStateError('指派状态并发改变，验收失败');
      }
      /* 工单 accepted→completed。 */
      this.store.markMarketplaceTaskCompleted(input.taskId, now);
      /* 结算入组织金库（reward 浮点 → minor；reward=0 跳过）。用 settleInTx——已在本事务内，
       * settleOrgTaskPayment 会自开事务导致 SQLite 嵌套事务报错。 */
      let settlement: OrgWalletSettlement | null = null;
      const totalMinor = Math.round(task.reward * 100);
      if (totalMinor > 0) {
        const walletSvc = new OrgWalletService(this.store, this.now, this.idgen);
        settlement = walletSvc.settleInTx({
          orgId: assign.orgId, sourceMarketplaceTaskId: input.taskId, goalId: assign.orgGoalId,
          totalAmountMinor: totalMinor, currency: task.currency, platformPct,
        });
      }
      const wallet = this.store.getOrgWallet(assign.orgId);
      return { assignment: this.store.getLatestOrgTaskAssignment(input.taskId)!, settlement, walletBalance: wallet?.balance ?? 0 };
    });
  }

  /** 读 open 工单（不存在/非 open 抛 TaskNotAvailableError）。 */
  private requireOpenTask(taskId: string): MarketplaceTaskBrief {
    const task = this.store.getMarketplaceTaskBrief(taskId);
    if (!task) throw new TaskNotAvailableError(`工单不存在：${taskId}`);
    if (task.status !== 'open') throw new TaskNotAvailableError(`工单不可申请（当前状态 ${task.status}，需 open）：${taskId}`);
    return task;
  }
}

export interface StartOrgTaskInput {
  readonly taskId: string;
  readonly orgId: string;
  /** org 内部哪个 manager 数字员工接（其下属须覆盖 goalType playbook 的岗位）。 */
  readonly managerWorkerId: string;
  /** 用哪个分解 playbook（content_piece/data_analysis/support_ticket）。 */
  readonly goalType: string;
}

export interface AcceptOrgTaskInput {
  readonly taskId: string;
  /** 当前登录用户——必须等于工单发布者。 */
  readonly actorUserId: string;
  /** 平台抽成（%，缺省 20）。 */
  readonly platformPct?: number;
}
