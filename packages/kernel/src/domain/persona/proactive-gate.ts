/**
 * 主动性门控（ADR-0054 Phase 3）——「该不该开口」的确定性纯函数。
 *
 * 主动性 = 对既有内部信号的确定性门控，不是新推理循环（ADR-0054 核心决策）。本模块只决定
 * **节制**（值不值得说、会不会骚扰），不做真伪校验（信号是人格自己内部真发生的事，本就可信）。
 * 零 LLM、纯函数、可复现。
 *
 * 红线（ADR-0054）：
 *   - 红线 1 零-LLM：纯函数判定，绝不调 LLM 决定主动行为。
 *   - 红线 3 主动≠骚扰：enabled + 静默期 + 频率上限是一等约束，默认保守。
 */

/** 可触发主动性的内部信号类型（ADR-0054 Phase 3 订阅子集）。 */
export type ProactiveSignalType =
  | 'core:memory-consolidated'
  | 'core:narrative-changed'
  | 'system:evolution-completed';

/** Gate 配置（per-persona 可覆盖；默认保守）。 */
export interface ProactiveGateConfig {
  /** 主动性总开关。false → 一律 suppress（ADR-0054 红线 3，0/关闭语义）。 */
  readonly enabled: boolean;
  /** 静默期（ms）：距上次主动消息不足此值 → suppress。 */
  readonly quietPeriodMs: number;
  /** 频率上限：窗口内主动消息数 ≥ 此值 → suppress。 */
  readonly maxPerWindow: number;
  /** 频率上限窗口（ms）。 */
  readonly windowMs: number;
}

/** 默认 Gate 配置——刻意保守（ADR-0054 红线 3「宁可少说」）。 */
export const DEFAULT_PROACTIVE_GATE_CONFIG: ProactiveGateConfig = {
  enabled: true,
  /* 4 小时静默期：同一段时间内最多被主动找一次，避免连环触发。 */
  quietPeriodMs: 4 * 60 * 60 * 1000,
  /* 每 24h 最多 3 条主动消息。 */
  maxPerWindow: 3,
  windowMs: 24 * 60 * 60 * 1000,
};

/** 各信号类型的显著性门槛——只有「够值得说」的信号才考虑开口。 */
const SIGNAL_SIGNIFICANCE: Readonly<Record<ProactiveSignalType, boolean>> = {
  /* 巩固了一段记忆（episodic→semantic）= 内化了一段经历，值得分享。 */
  'core:memory-consolidated': true,
  /* 叙事（「我是谁」）变化 = 自我认知演进，值得说。 */
  'core:narrative-changed': true,
  /* 自演化完成 = 人格成长了，值得说。 */
  'system:evolution-completed': true,
};

/** Gate 输入：信号 + 配置 + 窗口统计（来自 store.windowStats）。 */
export interface ProactiveGateInput {
  readonly signalType: ProactiveSignalType;
  readonly now: number;
  readonly config: ProactiveGateConfig;
  readonly windowCount: number;
  readonly lastCreatedAt: number | null;
}

/** Gate 决策：是否开口 + 抑制原因（可观测/审计）。 */
export interface ProactiveGateDecision {
  readonly emit: boolean;
  readonly reason: 'ok' | 'disabled' | 'not_significant' | 'quiet_period' | 'rate_limited';
}

/**
 * 判定是否该就此信号主动开口（纯函数，确定性）。
 * 抑制优先级：disabled > not_significant > quiet_period > rate_limited。
 */
export function evaluateProactiveGate(input: ProactiveGateInput): ProactiveGateDecision {
  if (!input.config.enabled) return { emit: false, reason: 'disabled' };
  if (!SIGNAL_SIGNIFICANCE[input.signalType]) return { emit: false, reason: 'not_significant' };

  /* 静默期：距上次主动消息不足 quietPeriodMs → 抑制（不连环骚扰）。 */
  if (input.lastCreatedAt !== null && input.now - input.lastCreatedAt < input.config.quietPeriodMs) {
    return { emit: false, reason: 'quiet_period' };
  }
  /* 频率上限：窗口内已达上限 → 抑制。 */
  if (input.windowCount >= input.config.maxPerWindow) {
    return { emit: false, reason: 'rate_limited' };
  }
  return { emit: true, reason: 'ok' };
}
