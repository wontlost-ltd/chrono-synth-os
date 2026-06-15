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

/**
 * category 路由模式（ADR-0048 skill-router 脚手架）：owner 对每个任务 category 设定准入路由。
 *   - `autonomous`：该 category 可走自主接单（仍受 reward/AML/熔断等其它 guard 约束）。
 *   - `human_review`：该 category 一律需人工审批（不阻断，但不自动接）。
 *   - `blocked`：该 category 完全禁止接单（硬禁止）。
 * 这是「persona 能自主做哪类活」的可配开关——**值由 owner 按风险决定**，脚手架只提供路由机制。
 */
export type CategoryRouteMode = 'autonomous' | 'human_review' | 'blocked';

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
  /**
   * 允许自主接单的 category 白名单（向后兼容字段）。当未设 categoryRoutes 时，由它派生路由：
   * 在白名单内 → autonomous，其余 → human_review。设了 categoryRoutes 则以后者为准（更细粒度）。
   */
  readonly allowedCategories: readonly MarketplaceTaskCategory[];
  /**
   * per-category 路由表（ADR-0048 skill-router 脚手架，可选）。设了则覆盖 allowedCategories 的派生逻辑：
   * 显式给每个 category 设 autonomous/human_review/blocked。未在表中的 category 走 defaultCategoryRoute。
   * 不设此字段 = 维持原 allowedCategories 行为（向后兼容）。
   */
  readonly categoryRoutes?: Partial<Record<MarketplaceTaskCategory, CategoryRouteMode>>;
  /** categoryRoutes 未覆盖的 category 的兜底路由（默认 human_review——保守，未知类别不自动接）。 */
  readonly defaultCategoryRoute?: CategoryRouteMode;
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
  /**
   * AML 聚合阈值（ADR-0048 related-account cycling / wash-trading 余项）。单 publisher
   * 现有「取消率」guard 只看质量，不看**跨窗口聚合模式**；这里补三类确定性聚合信号的阈值。
   */
  readonly aml: AmlAggregatePolicy;
}

/**
 * AML 聚合检测阈值（ADR-0048）。三类确定性聚合模式，全在 24h 滚动窗口上算，阈值刻意宽松
 * 以**不误伤正常收入**（真实 publisher 一天给 1-2 单远在阈值内）。
 */
export interface AmlAggregatePolicy {
  /** 单 publisher 在窗口内被本 persona 接单数达到此值 → 刷单速率嫌疑（wash-trading）。 */
  readonly maxTasksPerPublisherPerWindow: number;
  /** 单 publisher 占窗口报酬暴露的比例达到此值（且窗口任务数 ≥ concentrationMinTasks）→ 单源集中嫌疑（关联环圈）。 */
  readonly maxPublisherRewardShare: number;
  /** 触发集中度判定所需的窗口最小任务数（任务太少时占比无统计意义，不判）。 */
  readonly concentrationMinTasks: number;
  /** 单 publisher 在窗口内**同额报酬**的接单数达到此值 → 机械刷单嫌疑（identical-reward repeats）。 */
  readonly maxIdenticalRewardRepeats: number;
}

export const DEFAULT_AML_AGGREGATE_POLICY: AmlAggregatePolicy = {
  maxTasksPerPublisherPerWindow: 5,
  maxPublisherRewardShare: 0.8,
  concentrationMinTasks: 4,
  maxIdenticalRewardRepeats: 4,
};

export const DEFAULT_EARNING_POLICY: EarningPolicyConfig = {
  allowedCategories: ['research', 'writing'],
  maxAutonomousReward: 50,
  dailyRewardExposureCap: 200,
  maxConcurrentTasks: 3,
  failureStreakBreaker: 2,
  minReputationForAutonomy: 0,
  aml: DEFAULT_AML_AGGREGATE_POLICY,
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
 * 解析某 category 的路由模式（ADR-0048 skill-router 脚手架，纯函数）。
 *
 * 两条互斥路径（取决于是否设了 categoryRoutes）：
 *   A. routes 模式（设了 categoryRoutes）：categoryRoutes[category] → 命中即用；未列出 → defaultCategoryRoute
 *      → 仍无则 human_review。此模式下 allowedCategories 不再参与（以 routes 为准）。
 *   B. legacy 模式（没设 categoryRoutes）：allowedCategories 内 → autonomous，**其余固定 → human_review**。
 *      此路径**不读 defaultCategoryRoute**（它仅属 routes 模式），确保旧 policy 行为逐字不变（Codex 复审）。
 */
export function resolveCategoryRoute(config: EarningPolicyConfig, category: MarketplaceTaskCategory): CategoryRouteMode {
  /* routes 模式：显式表为准，未列出走 defaultCategoryRoute（默认 human_review）。
   * defaultCategoryRoute **仅在 routes 模式生效**——不污染 legacy 派生路径（Codex 复审）。 */
  if (config.categoryRoutes) {
    return config.categoryRoutes[category] ?? config.defaultCategoryRoute ?? 'human_review';
  }
  /* legacy 派生（无 categoryRoutes）：allowedCategories 内 → autonomous，其余固定 → human_review
   * （与旧行为逐字等价，不受 defaultCategoryRoute 影响）。 */
  return config.allowedCategories.includes(category) ? 'autonomous' : 'human_review';
}

/**
 * 经济行为准入评估（纯函数，ADR-0048）。
 *
 * 熔断/硬禁止优先；再按 category/reward/publisher/能力综合定级与裁决。
 */
export function evaluateEarningAdmission(input: EarningAdmissionInput): EarningAdmissionResult {
  const { task, persona, config } = input;
  const reasons: string[] = [];

  /* category 路由模式（skill-router）：决定该类别走自主/人工/禁止。 */
  const route = resolveCategoryRoute(config, task.category);

  /* ── 硬性熔断/禁止（最高优先） ──
   * 顺序：系统级 critical 熔断（persona 失活 / 连续失败）优先于 category blocked——blocked 是策略配置
   * 层面的禁止（high），不应遮蔽更高优先级的系统熔断原因（Codex 复审：让 reason 反映最严重的拦截因）。 */
  if (persona.status !== 'active') {
    return { admission: 'forbidden', risk: 'critical', reasons: ['persona not active'] };
  }
  if (persona.recentFailureStreak >= config.failureStreakBreaker) {
    return {
      admission: 'forbidden', risk: 'critical',
      reasons: [`failure streak ${persona.recentFailureStreak} ≥ breaker ${config.failureStreakBreaker} (earning paused)`],
    };
  }
  /* category 被 owner 显式禁止（blocked）→ 硬禁止（与「未在白名单」的 needs_human_review 不同，这是完全不接）。 */
  if (route === 'blocked') {
    return { admission: 'forbidden', risk: 'high', reasons: [`category '${task.category}' is blocked by policy`] };
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

  /* category 路由：autonomous=可自主；human_review=需人工（升 high，与旧「未在白名单」行为等价）。
   * blocked 已在上方硬禁止分支返回，这里只剩 autonomous / human_review 两种。
   * reason 文案：legacy 路径（无 categoryRoutes）保留旧文案逐字不变（Codex 复审：reasons 是公开输出）；
   * routes 模式用新文案（语义是 owner 显式路由到人工，不是「不在白名单」）。 */
  const categoryAllowed = route === 'autonomous';
  if (!categoryAllowed) {
    escalate('high', config.categoryRoutes
      ? `category '${task.category}' routed to human review (not autonomous)`
      : `category '${task.category}' not in autonomous allowlist`);
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

/** AML 聚合检测输入（纯数据；窗口任务由调用方按 24h 滚动窗口预筛好）。 */
export interface AmlAggregateInput {
  /** 候选任务的 publisher（要判它在窗口内的聚合行为）。 */
  readonly candidatePublisherUserId: string;
  /** 候选任务的报酬（计入同额重复信号——与速率信号同样把候选这一单算进去，语义一致）。 */
  readonly candidateReward: number;
  /**
   * 本 persona 在 24h 窗口内的**接单行为**任务（调用方预筛好：accepted/completed 且 acceptedAt 在窗口内
   * ——含 completed 是因 wash-trading 常「快速接单并完成」，只看 accepted 会漏判）。
   * 调用方负责窗口预筛——kernel 只做确定性聚合，不碰时钟/IO（与 evaluateEarningAdmission 同风格）。
   */
  readonly windowAcceptedTasks: readonly MarketplaceTask[];
  readonly policy: AmlAggregatePolicy;
}

/** AML 聚合检测结果：blocked=true 时 reasons 非空（拦截原因）。 */
export interface AmlAggregateResult {
  readonly blocked: boolean;
  readonly reasons: readonly string[];
}

/**
 * AML 聚合检测（纯函数，ADR-0048 related-account cycling / wash-trading 余项）。
 *
 * 现有 per-task `amlBlockReason` 只看「单 publisher 取消率」（质量信号）；本函数补**跨窗口聚合
 * 模式**——同一 publisher 在 24h 窗口内对本 persona 的接单行为是否呈现刷单/单源集中/机械重复。
 *
 * 三类确定性信号（任一触发即 blocked）：
 *   1. 速率：该 publisher 在窗口内被接单数 ≥ maxTasksPerPublisherPerWindow（高频喂单 = 刷单嫌疑）。
 *   2. 集中度：该 publisher 占窗口报酬暴露比例 ≥ maxPublisherRewardShare 且窗口任务数 ≥ concentrationMinTasks
 *      （收入被单一来源主导 = 关联账户环圈嫌疑）。
 *   3. 同额重复：该 publisher 在窗口内**同额报酬**接单数 ≥ maxIdenticalRewardRepeats（机械刷单嫌疑）。
 *
 * 阈值刻意宽松，不误伤正常收入（真实 publisher 一天 1-2 单远低于阈值）。纯确定性、零 LLM/IO。
 */
export function evaluateAmlAggregate(input: AmlAggregateInput): AmlAggregateResult {
  const { candidatePublisherUserId: pub, candidateReward, windowAcceptedTasks, policy } = input;
  const reasons: string[] = [];

  /* 该 publisher 在窗口内被本 persona 接的单。 */
  const fromPublisher = windowAcceptedTasks.filter((t) => t.publisherUserId === pub);

  /* 信号 1：接单速率（含候选这一单——所以用 ≥ 而非 >，达到阈值即拦，候选是第 N 单）。 */
  if (fromPublisher.length + 1 >= policy.maxTasksPerPublisherPerWindow) {
    reasons.push(
      `publisher ${pub} 窗口内接单速率过高 (${fromPublisher.length + 1} ≥ ${policy.maxTasksPerPublisherPerWindow})，刷单嫌疑`,
    );
  }

  /* 信号 2：报酬集中度（占窗口总暴露比例）。窗口任务太少不判（占比无统计意义）。
   * 注意：用「已接窗口」算占比，不含候选——候选还没接，占比看已成事实的集中状况。 */
  if (windowAcceptedTasks.length >= policy.concentrationMinTasks) {
    const totalReward = windowAcceptedTasks.reduce((s, t) => s + t.reward, 0);
    const pubReward = fromPublisher.reduce((s, t) => s + t.reward, 0);
    /* totalReward>0 才算占比（全 0 报酬窗口不触发除零，也无集中度意义）。 */
    if (totalReward > 0 && pubReward / totalReward >= policy.maxPublisherRewardShare) {
      reasons.push(
        `publisher ${pub} 报酬集中度过高 (${pubReward}/${totalReward} ≥ ${policy.maxPublisherRewardShare})，关联环圈嫌疑`,
      );
    }
  }

  /* 信号 3：同额报酬机械重复。统计该 publisher 窗口内各报酬额出现次数 + **候选这一单的报酬**
   * （与速率信号一致，把候选算进去：窗口已有 3 单同额 + 候选同额 = 4 次即拦，而非放行第 4 单等第 5 单）。
   * 任一额度达阈值即拦；按报酬额升序输出 reason（reason 文本也确定性，不依赖任务到达顺序）。 */
  const rewardCounts = new Map<number, number>();
  rewardCounts.set(candidateReward, 1); /* 候选先记一票 */
  for (const t of fromPublisher) {
    rewardCounts.set(t.reward, (rewardCounts.get(t.reward) ?? 0) + 1);
  }
  for (const [reward, count] of [...rewardCounts].sort((a, b) => a[0] - b[0])) {
    if (count >= policy.maxIdenticalRewardRepeats) {
      reasons.push(
        `publisher ${pub} 同额报酬 ${reward} 重复 ${count} 次 (≥ ${policy.maxIdenticalRewardRepeats})，机械刷单嫌疑`,
      );
    }
  }

  return { blocked: reasons.length > 0, reasons };
}
