/**
 * 集成引擎：将快层实验结果合并到慢层
 * 基于适应度评分和置信度决定是否采纳
 */

import type { CoreRhythmLayer } from '../core/core-rhythm-layer.js';
import type { IntegrationProposal } from '../types/meta-regulation.js';
import type { SimulationResult } from '../types/persona-version.js';
import type { Clock } from '../utils/clock.js';
import { generatePrefixedId } from '../utils/id-generator.js';

export interface IntegrationConfig {
  /** 最低接受适应度 */
  minFitness: number;
  /** 最低接受置信度 */
  minConfidence: number;
  /** 最大单次权重调整幅度 */
  maxWeightDelta: number;
}

const DEFAULT_CONFIG: IntegrationConfig = {
  minFitness: 0.6,
  minConfidence: 0.7,
  maxWeightDelta: 0.1,
};

export class IntegrationEngine {
  private readonly config: IntegrationConfig;

  constructor(
    private readonly clock: Clock,
    config?: Partial<IntegrationConfig>,
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /** 从模拟结果生成集成提案 */
  propose(result: SimulationResult): IntegrationProposal {
    const valueChanges = new Map<string, number>();

    /* 提取目标权重（绝对值）；实际限制在 apply() 中通过 maxWeightDelta 执行 */
    for (const [key, newWeight] of result.valueAdjustments) {
      valueChanges.set(key, newWeight);
    }

    const confidence = result.fitnessScore;
    const narrativeUpdate = result.insights.length > 0
      ? result.insights.join('; ')
      : undefined;

    return {
      id: generatePrefixedId('proposal'),
      sourceVersionId: result.personaVersionId,
      valueChanges,
      narrativeUpdate,
      confidence,
      proposedAt: this.clock.now(),
    };
  }

  /** 评估提案是否应被接受 */
  evaluate(proposal: IntegrationProposal, fitnessScore: number): boolean {
    return fitnessScore >= this.config.minFitness
      && proposal.confidence >= this.config.minConfidence;
  }

  /** 将已接受的提案应用到核心层 */
  apply(proposal: IntegrationProposal, coreLayer: CoreRhythmLayer): void {
    const currentValues = coreLayer.values.getAll();

    for (const [valueId, targetWeight] of proposal.valueChanges) {
      const existing = currentValues.get(valueId);
      if (!existing) continue;

      /* 限制单次调整幅度 */
      const delta = Math.max(
        -this.config.maxWeightDelta,
        Math.min(this.config.maxWeightDelta, targetWeight - existing.weight),
      );
      const newWeight = Math.max(0, Math.min(1, existing.weight + delta));
      coreLayer.updateValue(valueId, newWeight);
    }

    if (proposal.narrativeUpdate) {
      const current = coreLayer.narrative.get();
      const updated = current
        ? `${current}\n---\n${proposal.narrativeUpdate}`
        : proposal.narrativeUpdate;
      coreLayer.updateNarrative(updated);
    }
  }
}
