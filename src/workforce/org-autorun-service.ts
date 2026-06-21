/**
 * 数字组织有限自主运营（M5）——数字 manager 在**预算/权限内**自主拉起目标，确定性零-LLM。
 *
 * 蓝图 M5「proactive workforce（预算/权限内）」+ 风险 #4「高风险仍需人类」。本 service 让数字组织
 * 不必每个目标都人类手动触发，而是从**目标队列**里在治理限额内自主运行：
 *   - 预算门：每周期最多自主运行 maxGoalsPerCycle 个目标（控制自主吞吐，防失控）；
 *   - 风险天花板：playbook 会产出**超过 maxAutoRiskLevel** 风险任务的目标**不自动运行**，留给人类
 *     （high 风险/对外动作绝不自主拉起；这与 A↔D 一致——真实执行本就经 D2 审批，但 M5 更早在
 *     「要不要自主启动这个目标」就把高风险目标挡在自主路径外）；
 *   - 确定性：相同队列+相同组织+相同时钟 → 相同运行结果（无 LLM/random/now 参与自主决策）。
 *
 * runGoal 本身仍只确定性规划+委派+stub（需真实工具的环节留 delegated 等 D2），故「自主」= 自主**规划
 * 派活**，不是自主**对外执行**——红线守住。
 *
 * 本切片是**无状态决策核心**：QueuedGoal 是一次性请求，不带 id/状态。**幂等去重是调用方/队列层的责任**
 * （同一队列跑两次会创建重复目标）；M5 只保证「在限额内确定性地决定跑哪些、挡哪些」。
 * 治理值（预算/风险天花板）**fail-closed**：非法/缺省一律保守（缺天花板按 medium、非法预算按 0），
 * 绝不因调用方漏传而放行高风险自主运行。
 */

import type { OrgPlanningService, RunGoalResult } from './org-planning-service.js';
import { UnsupportedGoalTypeError, AssigneeNotFoundError } from './org-planning-service.js';
import { getDecompositionPlaybook } from './decomposition-playbook.js';
import type { RiskLevel } from './types.js';

/** 风险序（用于天花板比较）。 */
const RISK_ORDER: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2 };

/** 自主运营策略（治理限额）。 */
export interface OrgAutonomyPolicy {
  /** 每周期最多自主运行的目标数（预算门，≥1）。 */
  readonly maxGoalsPerCycle: number;
  /**
   * 自主可运行的最高任务风险等级（天花板）：playbook 产出任一任务 > 此 → 该目标不自主运行，留人类。
   * 默认 'medium'（high/对外绝不自主拉起）。
   */
  readonly maxAutoRiskLevel: RiskLevel;
}

/** 队列里一个待运行目标请求。 */
export interface QueuedGoal {
  readonly managerWorkerId: string;
  readonly title: string;
  readonly description: string;
  readonly goalType: string;
}

/** 单个目标的自主运行结局。 */
export type AutorunOutcome =
  | { readonly kind: 'ran'; readonly goal: QueuedGoal; readonly result: RunGoalResult }
  | { readonly kind: 'deferred_high_risk'; readonly goal: QueuedGoal; readonly maxTaskRisk: RiskLevel }
  | { readonly kind: 'deferred_budget'; readonly goal: QueuedGoal }
  | { readonly kind: 'failed'; readonly goal: QueuedGoal; readonly reason: string };

/** 一个自主运营周期的结果。 */
export interface OrgAutorunResult {
  readonly ranCount: number;
  readonly deferredHighRisk: number;
  readonly deferredBudget: number;
  readonly failed: number;
  readonly outcomes: readonly AutorunOutcome[];
}

export class OrgAutorunService {
  constructor(
    private readonly planning: OrgPlanningService,
    /** roleCode→workerId 解析（与 runGoal 同源；由调用方按 org 重建后传入，确定性）。 */
    private readonly workerIdByRole: ReadonlyMap<string, string>,
  ) {}

  /**
   * 跑一个自主运营周期：按队列顺序，在预算/风险天花板内自主运行目标。确定性。
   * 不抛错（单目标失败隔离为 failed outcome，不中断整批）；预算耗尽后剩余目标记 deferred_budget。
   */
  runCycle(orgId: string, queue: readonly QueuedGoal[], policy: OrgAutonomyPolicy): OrgAutorunResult {
    /* 治理值 fail-closed：非法/缺省一律保守，绝不因调用方漏传而放行高风险自主运行（Codex 复审）。 */
    const budget = Number.isFinite(policy.maxGoalsPerCycle) ? Math.max(0, Math.floor(policy.maxGoalsPerCycle)) : 0;
    /* 缺省/非法风险天花板 → 按最严保守值 medium（high/对外绝不自主）。 */
    const ceiling = RISK_ORDER[policy.maxAutoRiskLevel] ?? RISK_ORDER.medium;
    const outcomes: AutorunOutcome[] = [];
    let ran = 0;

    for (const goal of queue) {
      /* 预算门：本周期已运行数达上限 → 剩余全部 deferred_budget（不再尝试，留下周期/人类）。 */
      if (ran >= budget) {
        outcomes.push({ kind: 'deferred_budget', goal });
        continue;
      }

      /* 风险天花板：playbook 产出任一任务 > 天花板 → 不自主运行，留人类。 */
      const maxTaskRisk = this.maxTaskRiskOf(goal);
      if (maxTaskRisk === undefined) {
        /* 未知 goalType：不自主臆造，记 failed（诚实）。 */
        outcomes.push({ kind: 'failed', goal, reason: `未知 goalType：${goal.goalType}` });
        continue;
      }
      if (RISK_ORDER[maxTaskRisk] > ceiling) {
        outcomes.push({ kind: 'deferred_high_risk', goal, maxTaskRisk });
        continue;
      }

      /* 在限额内 → 自主运行（runGoal 仍确定性规划+委派+stub，高风险工具环节留 D2）。 */
      try {
        const result = this.planning.runGoal(orgId, goal.managerWorkerId, goal, this.workerIdByRole);
        outcomes.push({ kind: 'ran', goal, result });
        ran++;
      } catch (err) {
        /* 单目标失败隔离（缺下属/校验等），不中断整批。 */
        const reason = err instanceof UnsupportedGoalTypeError || err instanceof AssigneeNotFoundError
          ? err.message
          : err instanceof Error ? err.message : String(err);
        outcomes.push({ kind: 'failed', goal, reason });
      }
    }

    return {
      ranCount: ran,
      deferredHighRisk: outcomes.filter((o) => o.kind === 'deferred_high_risk').length,
      deferredBudget: outcomes.filter((o) => o.kind === 'deferred_budget').length,
      failed: outcomes.filter((o) => o.kind === 'failed').length,
      outcomes,
    };
  }

  /** 某目标的 playbook 会产出的最高任务风险；未知 goalType → undefined。确定性（不调用 runGoal,不落库）。 */
  private maxTaskRiskOf(goal: QueuedGoal): RiskLevel | undefined {
    const playbook = getDecompositionPlaybook(goal.goalType);
    if (!playbook) return undefined;
    const specs = playbook.decompose({ title: goal.title, description: goal.description });
    let max: RiskLevel = 'low';
    for (const s of specs) if (RISK_ORDER[s.riskLevel] > RISK_ORDER[max]) max = s.riskLevel;
    return max;
  }
}
