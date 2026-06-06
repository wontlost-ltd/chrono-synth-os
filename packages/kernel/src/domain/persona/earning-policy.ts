/**
 * 挣钱策略引擎（ADR-0048 D1 + 治理矩阵）— 纯领域逻辑，零 node:* 依赖。
 *
 * 在工具管线之前做经济行为准入：风险分级 + 自主/审批/禁止裁决。
 * 工具权限（budget/quota/confirmation）管"单次工具调用"；本引擎管"接这个活
 * 在经济上是否安全"——两者叠加。
 */

import type { MarketplaceTask, MarketplaceTaskCategory } from './types.js';

/** 经济行为风险级（ADR-0048 治理矩阵） */
export type EarningRiskLevel = 'low' | 'medium' | 'high' | 'critical';

/** 准入裁决 */
export type EarningAdmission = 'autonomous' | 'needs_human_review' | 'forbidden';

/** 接单决策所需的 persona 侧快照 */
export interface EarningPersonaSnapshot {
  readonly status: string;
  readonly reputation: number;
  /** 当前未完成（已接但未结算）任务数 */
  readonly openTaskCount: number;
  /** 该 persona 在此 category 的历史完成数（信任积累） */
  readonly categoryCompletedCount: number;
  /** 近期连续失败/被拒次数（熔断信号） */
  readonly recentFailureStreak: number;
}

/** 策略配置（owner 通过授权中心设定；此处为纯数据） */
export interface EarningPolicyConfig {
  /** 允许自主接单的 category 白名单 */
  readonly allowedCategories: readonly MarketplaceTaskCategory[];
  /** 单任务最高自主报酬（超过 → 需人工审批） */
  readonly maxAutonomousReward: number;
  /** 每日累计报酬暴露上限（已接单报酬之和） */
  readonly dailyRewardExposureCap: number;
  /** 最大并发未完成任务数 */
  readonly maxConcurrentTasks: number;
  /** 连续失败达到此值则熔断（暂停 earning cycle） */
  readonly failureStreakBreaker: number;
  /** 自主接单要求的最低声誉 */
  readonly minReputationForAutonomy: number;
}

export const DEFAULT_EARNING_POLICY: EarningPolicyConfig = {
  allowedCategories: ['research', 'writing'],
  maxAutonomousReward: 50,
  dailyRewardExposureCap: 200,
  maxConcurrentTasks: 3,
  failureStreakBreaker: 2,
  minReputationForAutonomy: 0,
};

/** 准入评估输入 */
export interface EarningAdmissionInput {
  readonly task: MarketplaceTask;
  readonly persona: EarningPersonaSnapshot;
  readonly config: EarningPolicyConfig;
  /** 今日已接单累计报酬（不含本任务） */
  readonly todayRewardExposure: number;
  /** 该 publisher 是否为新发布方（首次合作 → 风险升级） */
  readonly publisherIsNew: boolean;
}

/** 准入结果 */
export interface EarningAdmissionResult {
  readonly admission: EarningAdmission;
  readonly risk: EarningRiskLevel;
  readonly reasons: readonly string[];
}

/**
 * 经济行为准入评估（纯函数，ADR-0048）。
 *
 * 熔断/硬禁止优先；再按 category/reward/publisher/能力综合定级与裁决。
 */
export function evaluateEarningAdmission(input: EarningAdmissionInput): EarningAdmissionResult {
  const { task, persona, config } = input;
  const reasons: string[] = [];

  /* ── 硬性熔断/禁止（最高优先） ── */
  if (persona.status !== 'active') {
    return { admission: 'forbidden', risk: 'critical', reasons: ['persona not active'] };
  }
  if (persona.recentFailureStreak >= config.failureStreakBreaker) {
    return {
      admission: 'forbidden', risk: 'critical',
      reasons: [`failure streak ${persona.recentFailureStreak} ≥ breaker ${config.failureStreakBreaker} (earning paused)`],
    };
  }
  if (persona.openTaskCount >= config.maxConcurrentTasks) {
    return {
      admission: 'forbidden', risk: 'high',
      reasons: [`open tasks ${persona.openTaskCount} ≥ max ${config.maxConcurrentTasks}`],
    };
  }
  if (input.todayRewardExposure + task.reward > config.dailyRewardExposureCap) {
    return {
      admission: 'needs_human_review', risk: 'high',
      reasons: [`daily reward exposure ${input.todayRewardExposure}+${task.reward} > cap ${config.dailyRewardExposureCap}`],
    };
  }

  /* ── 风险分级（累积信号） ── */
  let risk: EarningRiskLevel = 'low';
  const escalate = (to: EarningRiskLevel, why: string): void => {
    risk = maxRisk(risk, to);
    reasons.push(why);
  };

  const categoryAllowed = config.allowedCategories.includes(task.category);
  if (!categoryAllowed) {
    escalate('high', `category '${task.category}' not in autonomous allowlist`);
  }
  if (persona.categoryCompletedCount === 0) {
    escalate('medium', `first task in category '${task.category}'`);
  }
  if (input.publisherIsNew) {
    escalate('medium', 'new publisher (no prior collaboration)');
  }
  if (task.reward > config.maxAutonomousReward) {
    escalate('high', `reward ${task.reward} > autonomous max ${config.maxAutonomousReward}`);
  }
  if (persona.reputation < config.minReputationForAutonomy) {
    escalate('high', `reputation ${persona.reputation} < min ${config.minReputationForAutonomy}`);
  }

  /* ── 裁决：风险 → 准入 ──
   * low + 已授权 category → autonomous；其余（medium/high，或 low 但 category 未授权）
   * → needs_human_review。critical 已在上方硬禁止分支提前返回。 */
  const admission: EarningAdmission =
    risk === 'low' && categoryAllowed ? 'autonomous' : 'needs_human_review';
  if (reasons.length === 0) reasons.push('low-risk, allowed category, within all limits');

  return { admission, risk, reasons };
}

const RISK_ORDER: Record<EarningRiskLevel, number> = { low: 0, medium: 1, high: 2, critical: 3 };
function maxRisk(a: EarningRiskLevel, b: EarningRiskLevel): EarningRiskLevel {
  return RISK_ORDER[a] >= RISK_ORDER[b] ? a : b;
}
