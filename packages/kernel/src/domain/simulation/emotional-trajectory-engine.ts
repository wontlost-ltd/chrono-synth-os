/**
 * 情绪轨迹引擎 — 纯领域逻辑
 * 价态、压力、满足感、后悔的年度演化
 * 零 node:* 依赖
 */

import type { EmotionalState, FinanceState, FamilyState } from './types.js';
import { clamp, clamp01 } from '../math.js';

export interface EmotionalConfig {
  /** 压力对价态的负向权重 */
  readonly stressToValenceWeight: number;
  /** 上一年满足感的保留率（惯性） */
  readonly fulfillmentInertia: number;
  /** 后悔逐年累积率 */
  readonly regretAccumulationRate: number;
}

export const DEFAULT_EMOTIONAL_CONFIG: EmotionalConfig = Object.freeze({
  stressToValenceWeight: -0.3,
  fulfillmentInertia: 0.7,
  regretAccumulationRate: 0.05,
});

export interface EmotionalInputs {
  readonly finance: FinanceState;
  readonly family: FamilyState;
  readonly healthIndex: number;
  readonly year: number;
  /** computeStructuralScore 的 overallScore，代表价值对齐度 */
  readonly valueAlignment: number;
}

/**
 * 计算下一年情绪状态（纯函数）
 *
 * valence: 综合情绪基调（-1..1），受压力、家庭安全、健康、价值对齐影响
 * stress: 综合压力（0..1），受家庭压力、财务压力、健康影响
 * fulfillment: 满足感（0..1），受价值对齐和惯性影响
 * regret: 后悔感（0..1），低对齐时累积，高对齐时缓慢回落
 */
export function nextEmotionalState(
  prev: EmotionalState,
  inputs: EmotionalInputs,
  config: EmotionalConfig,
): EmotionalState {
  /* 财务压力：收入为 0 或财富耗尽时压力最大 */
  const financialStress = inputs.finance.income <= 0
    ? 0.9
    : clamp01(1 - Math.min(inputs.finance.wealth / Math.max(inputs.finance.income * 2, 1), 1));

  /* 综合压力 = 家庭压力 + 财务压力 + 健康衰退，加权平均 */
  const healthStress = clamp01(1 - inputs.healthIndex);
  const stress = clamp01(
    inputs.family.familyPressure * 0.35 +
    financialStress * 0.35 +
    healthStress * 0.3,
  );

  /* 满足感：价值对齐 × (1 - 新权重) + 上一年惯性 */
  const newFulfillment = clamp01(inputs.valueAlignment) * (1 - config.fulfillmentInertia)
    + prev.fulfillment * config.fulfillmentInertia;
  const fulfillment = clamp01(newFulfillment);

  /* 价态：受压力拖拽 + 满足感提升 + 家庭安全感 */
  const rawValence =
    stress * config.stressToValenceWeight +
    fulfillment * 0.4 +
    inputs.family.spouseSecurity * 0.2 +
    inputs.healthIndex * 0.1;
  const valence = clamp(rawValence, -1, 1);

  /* 后悔：对齐度低时累积，高时缓慢消退 */
  const alignmentGap = Math.max(0, 0.5 - clamp01(inputs.valueAlignment));
  const regretDelta = alignmentGap * config.regretAccumulationRate;
  const regretDecay = clamp01(inputs.valueAlignment) * 0.02;
  const regret = clamp01(prev.regret + regretDelta - regretDecay);

  return { valence, stress, fulfillment, regret };
}
