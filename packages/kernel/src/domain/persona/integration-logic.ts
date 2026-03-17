/**
 * 集成引擎 — 纯领域逻辑
 * 将快层实验结果合并到慢层的评估与计算
 * 零 node:* 依赖
 */

/** 集成引擎配置 */
export interface IntegrationConfig {
  /** 最低接受适应度 */
  minFitness: number;
  /** 最低接受置信度 */
  minConfidence: number;
  /** 最大单次权重调整幅度 */
  maxWeightDelta: number;
}

export const DEFAULT_INTEGRATION_CONFIG: IntegrationConfig = {
  minFitness: 0.6,
  minConfidence: 0.7,
  maxWeightDelta: 0.1,
};

/**
 * 评估集成提案是否应被接受（纯函数）
 */
export function evaluateProposal(
  config: IntegrationConfig,
  fitnessScore: number,
  confidence: number,
): boolean {
  return fitnessScore >= config.minFitness
    && confidence >= config.minConfidence;
}

/**
 * 计算受限的权重调整值（纯函数）
 * 确保单次调整不超过 maxWeightDelta，结果夹紧在 [0, 1]
 */
export function clampWeightDelta(
  currentWeight: number,
  targetWeight: number,
  maxDelta: number,
): { newWeight: number; delta: number } {
  const delta = Math.max(-maxDelta, Math.min(maxDelta, targetWeight - currentWeight));
  const newWeight = Math.max(0, Math.min(1, currentWeight + delta));
  return { newWeight, delta };
}
