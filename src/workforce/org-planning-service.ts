/**
 * 目标规划/委派 service（digital workforce M1）——数字组织的核心因果链，全零-LLM 确定性。
 *
 *   目标(goal) → 确定性分解(playbook) → 按汇报关系委派给下属 → 下属确定性执行 → 逐级汇报 → manager 聚合
 *
 * 论点（ADR-0047）：分解/委派/执行/聚合全部确定性（playbook + 结构遍历），无运行时 LLM。
 * 可复现：相同 (org, goal, clock) → 相同 task 结构 + 相同委派 + 相同聚合 report。
 *
 * 执行（IC 干活）本切片用**确定性 stub**（结构化产出摘要）——真实工具执行/外部副作用留后续切片，
 * 那时走 ToolInvocationPipeline（授权/预算/确认/审计）。
 */

import { randomUUID } from 'node:crypto';
import type { OrgWorkforceStore } from '../storage/org-workforce-store.js';
import type { OrgChartService } from './org-chart-service.js';
import { getDecompositionPlaybook, supportedGoalTypes } from './decomposition-playbook.js';
import type { OrgTask, TaskReport } from './types.js';

/** 运行一个目标的结果摘要（供对照实验/可观测）。 */
export interface RunGoalResult {
  readonly goalId: string;
  /** 分解出的任务数（manager 级）。 */
  readonly taskCount: number;
  /** 产生的汇报数（每个任务一条 final report + 顶层聚合 report）。 */
  readonly reportCount: number;
  /** manager 聚合后的顶层执行摘要。 */
  readonly executiveSummary: string;
  /** 因果链事件步数（创建/委派/执行/汇报/聚合）——仅作可观测，不作对照核心（日志条数不公平）。 */
  readonly attributableSteps: number;
  /**
   * 可归因责任环节数：每个交付环节都有**具名问责的数字员工** + **来自具名员工的可审计汇报**。
   * 这是与单 agent 对照的**核心公平指标**（单 agent accountableStages=0，无论它记多少日志）。
   * = 任务数（每个任务一个具名 accountable worker + 一条具名 final report）。
   */
  readonly accountableStages: number;
}

/** 未知 goalType（无对应确定性 playbook）。 */
export class UnsupportedGoalTypeError extends Error {
  constructor(goalType: string) {
    super(`不支持的 goalType：${goalType}（已支持：${supportedGoalTypes().join(', ')}）`);
    this.name = 'UnsupportedGoalTypeError';
  }
}

/** 委派目标里某 roleCode 的下属不存在。 */
export class AssigneeNotFoundError extends Error {
  constructor(roleCode: string) {
    super(`分解需要岗位「${roleCode}」的下属，但组织里没有该直接下属`);
    this.name = 'AssigneeNotFoundError';
  }
}

export class OrgPlanningService {
  constructor(
    private readonly store: OrgWorkforceStore,
    private readonly orgChart: OrgChartService,
    private readonly now: () => number,
    private readonly idgen: () => string = randomUUID,
  ) {}

  /**
   * 由某 manager 数字员工运行一个目标：确定性分解 → 委派给直接下属 → 下属执行 → 逐级汇报 → 聚合。
   * @param managerWorkerId 拥有/驱动该目标的数字员工（如数字主管）。
   * @param workerIdByRole roleCode → workerId（来自 bootstrap，用于把分解的 assigneeRoleCode 映射到下属）。
   */
  runGoal(
    orgId: string,
    managerWorkerId: string,
    goal: { readonly title: string; readonly description: string; readonly goalType: string },
    workerIdByRole: ReadonlyMap<string, string>,
  ): RunGoalResult {
    const playbook = getDecompositionPlaybook(goal.goalType);
    if (!playbook) throw new UnsupportedGoalTypeError(goal.goalType);

    /* 确定性分解 → 任务规格序列。 */
    const specs = playbook.decompose({ title: goal.title, description: goal.description });

    /* 原子性（Codex 复审 High）：**先全量预校验**（assignee 存在 + 委派合法），任一不通过就**在落库前**
     * 抛错——避免「goal 已创建但发现委派非法」留下半成品因果链。校验通过后整条因果链包在事务里，
     * 失败整体回滚，保证审计的因果链 DAG 永远完整。 */
    const resolved = specs.map((spec) => {
      const assigneeId = workerIdByRole.get(spec.assigneeRoleCode);
      if (!assigneeId) throw new AssigneeNotFoundError(spec.assigneeRoleCode);
      this.orgChart.assertCanDelegate(orgId, managerWorkerId, assigneeId);
      return { spec, assigneeId };
    });

    let steps = 0;
    const goalId = this.idgen();
    const executiveSummary = this.store.transaction(() => {
      const ts0 = this.now();
      this.store.insertGoal({
        id: goalId, orgId, ownerWorkerId: managerWorkerId, title: goal.title, description: goal.description,
        goalType: goal.goalType, status: 'active', createdAt: ts0, updatedAt: ts0,
      });
      steps++; /* goal 创建 */

      const tasks: OrgTask[] = [];
      for (const { spec, assigneeId } of resolved) {
        const ts = this.now();
        const taskId = this.idgen();
        this.store.insertTask({
          id: taskId, orgId, goalId, parentTaskId: null, assignedToWorkerId: assigneeId,
          accountableWorkerId: managerWorkerId, title: spec.title, taskType: spec.taskType,
          status: 'delegated', resultSummary: null, createdAt: ts, updatedAt: ts,
        });
        steps++; /* 任务创建 + 委派 */

        /* 下属确定性执行（stub）：产出结构化摘要。真实工具执行留后续切片。 */
        const result = this.executeTaskDeterministically(spec.taskType, spec.title);
        const tsExec = this.now();
        this.store.updateTaskExecution(orgId, taskId, 'submitted', result, tsExec);
        steps++; /* 执行 */

        /* 下属向上级（manager）汇报 final。 */
        this.store.insertReport({
          id: this.idgen(), orgId, taskId, fromWorkerId: assigneeId, toWorkerId: managerWorkerId,
          reportType: 'final', summary: result, createdAt: this.now(),
        });
        steps++; /* 汇报 */

        tasks.push({
          id: taskId, tenantId: '', orgId, goalId, parentTaskId: null, assignedToWorkerId: assigneeId,
          accountableWorkerId: managerWorkerId, title: spec.title, taskType: spec.taskType,
          status: 'submitted', resultSummary: result, createdAt: ts, updatedAt: tsExec,
        });
      }

      /* manager 聚合：把所有下属 final report 确定性合成执行摘要。 */
      const summary = this.aggregate(goal.title, tasks);
      /* 聚合本身也作为一条「向 goal owner 汇报」的 final（manager 自报顶层结果）。 */
      const aggReportTaskId = tasks[tasks.length - 1]?.id ?? goalId;
      this.store.insertReport({
        id: this.idgen(), orgId, taskId: aggReportTaskId, fromWorkerId: managerWorkerId, toWorkerId: managerWorkerId,
        reportType: 'final', summary, createdAt: this.now(),
      });
      steps++; /* 聚合汇报 */

      this.store.updateGoalStatus(orgId, goalId, 'completed', this.now());
      steps++; /* 目标完成 */
      return summary;
    });

    const reports = this.store.listReportsByGoal(orgId, goalId);
    return {
      goalId,
      taskCount: resolved.length,
      reportCount: reports.length,
      executiveSummary,
      attributableSteps: steps,
      /* 每个任务环节都有具名 accountable worker + 具名 final report → 该任务即一个可归因责任环节。 */
      accountableStages: resolved.length,
    };
  }

  /** 确定性执行 stub：按任务类型产出固定结构的产出摘要（相同输入相同输出）。 */
  private executeTaskDeterministically(taskType: string, title: string): string {
    return `[${taskType}] 已完成：${title}`;
  }

  /** 确定性聚合：把任务产出按顺序合成顶层摘要。 */
  private aggregate(goalTitle: string, tasks: readonly OrgTask[]): string {
    const lines = tasks.map((t, i) => `${i + 1}. ${t.resultSummary ?? '（无产出）'}`);
    return `目标「${goalTitle}」已交付，共 ${tasks.length} 个环节：\n${lines.join('\n')}`;
  }

  /** 取某目标的完整汇报链（可观测/审计）。 */
  reportTrail(orgId: string, goalId: string): TaskReport[] {
    return this.store.listReportsByGoal(orgId, goalId);
  }
}
