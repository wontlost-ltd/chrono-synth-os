/**
 * 健康衰减子模型 — 纯领域逻辑
 * 基于年龄、压力、生活方式计算健康指数
 * 零 node:* 依赖
 */

import { clamp01 } from '../math.js';

export interface HealthConfig {
  /** 基础年衰减率 */
  readonly baseDecayPerYear: number;
  /** 压力对健康衰减的乘数 */
  readonly stressMultiplier: number;
  /** 低压力时的恢复率 */
  readonly recoveryRate: number;
}

export const DEFAULT_HEALTH_CONFIG: HealthConfig = Object.freeze({
  baseDecayPerYear: 0.01,
  stressMultiplier: 1.5,
  recoveryRate: 0.3,
});

export interface HealthInputs {
  readonly age: number;
  readonly stress: number;
  /** 生活方式评分 0..1（运动、饮食、睡眠） */
  readonly lifestyleScore: number;
}

/**
 * 计算下一年健康指数（纯函数）
 *
 * 年龄因子 = baseDecay × (1 + (age - 40) / 40)
 * 压力衰减 = stress × stressMultiplier × 年龄因子
 * 恢复 = (1 - stress) × recoveryRate × lifestyleScore
 * health = clamp01(prev - 压力衰减 + 恢复)
 */
export function nextHealthIndex(
  prev: number,
  inputs: HealthInputs,
  config: HealthConfig,
): number {
  const ageFactor = config.baseDecayPerYear * (1 + Math.max(0, inputs.age - 40) / 40);
  const stressDecay = clamp01(inputs.stress) * config.stressMultiplier * ageFactor;
  const recovery = (1 - clamp01(inputs.stress)) * config.recoveryRate * clamp01(inputs.lifestyleScore) * 0.1;
  return clamp01(prev - stressDecay + recovery);
}
