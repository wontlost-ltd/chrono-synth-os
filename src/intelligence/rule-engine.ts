/**
 * 规则引擎（离线决策能力）
 */

import type { DecisionCase, DecisionResult, Explanation, RankedOption } from './types.js';
import type { PersonaOSState } from '../types/personality-os.js';
import type { Clock } from '../utils/clock.js';
import { computeStructuralScore } from './structural-scorer.js';
import type { ScoreBreakdown } from './structural-scorer.js';

export interface RuleEngineConfig {
  enabled: boolean;
  fallbackStrategy: 'rule_only' | 'error';
}

function clamp01(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}

function tokenize(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9\u4e00-\u9fff]+/).filter(Boolean);
}

export class RuleEngine {
  private readonly config: RuleEngineConfig;

  constructor(
    private readonly clock: Clock,
    config?: Partial<RuleEngineConfig>,
  ) {
    this.config = { enabled: true, fallbackStrategy: 'rule_only', ...config };
  }

  /** 是否允许作为 LLM 的回退方案 */
  allowsFallback(): boolean {
    return this.config.fallbackStrategy === 'rule_only';
  }

  evaluate(decisionCase: DecisionCase, personaState: PersonaOSState): DecisionResult {
    if (!this.config.enabled) {
      throw new Error('Rule engine disabled');
    }

    const alternatives = decisionCase.alternatives && decisionCase.alternatives.length > 0
      ? [...decisionCase.alternatives]
      : ['保持现状', '采取行动'];

    const valueWeights = new Map<string, number>();
    for (const value of personaState.L1.values()) {
      valueWeights.set(value.id, value.weight);
      valueWeights.set(value.label, value.weight);
    }

    const timeHorizonMonths = this.extractTimeHorizonMonths(decisionCase.context);
    const scored: Array<{ option: RankedOption; score: number }> = [];

    for (const alternative of alternatives) {
      const relevance = new Map<string, number>();
      for (const value of personaState.L1.values()) {
        const score = this.computeKeywordRelevance(value.label, alternative, decisionCase.description);
        relevance.set(value.id, score);
        relevance.set(value.label, score);
      }

      const riskScore = 0.5;
      const structural = computeStructuralScore({
        valueWeights,
        values: personaState.L1,
        scenarioRelevance: relevance,
        anchors: personaState.L0,
        violations: [],
        riskScore,
        decisionStyle: personaState.L2,
        cognitiveModel: personaState.L3,
        timeHorizonMonths,
      });

      const explanation = this.buildExplanation(alternative, structural.alignmentScore, structural.overallScore, structural.breakdown);
      scored.push({
        option: {
          alternative,
          rank: 0,
          alignmentScore: structural.alignmentScore,
          riskScore,
          confidence: 0.4,
          overallScore: structural.overallScore,
          explanation,
          scoreBreakdown: structural.breakdown,
        },
        score: structural.overallScore,
      });
    }

    scored.sort((a, b) => b.score - a.score);
    const rankedOptions = scored.map((entry, idx) => ({ ...entry.option, rank: idx + 1 }));

    return {
      caseId: decisionCase.id,
      recommendedAlternative: rankedOptions[0]?.alternative ?? '',
      rankedOptions,
      simulatedAt: this.clock.now(),
    };
  }

  private buildExplanation(
    alternative: string,
    alignmentScore: number,
    overallScore: number,
    breakdown: ScoreBreakdown,
  ): Explanation {
    const top = this.pickTopContribution(breakdown.valueContributions);
    const evidence = top
      ? [{ source: 'rule', content: `关键词匹配偏重: ${top[0]}`, relevance: clamp01(Math.abs(top[1])) }]
      : [];
    return {
      summary: `规则引擎评估：${alternative} 对齐度 ${alignmentScore.toFixed(2)}，综合得分 ${overallScore.toFixed(2)}。`,
      evidence,
      counterfactuals: [],
    };
  }

  private pickTopContribution(contributions: Record<string, number>): [string, number] | undefined {
    let best: [string, number] | undefined;
    for (const [key, value] of Object.entries(contributions)) {
      if (!best || value > best[1]) {
        best = [key, value];
      }
    }
    return best;
  }

  private computeKeywordRelevance(valueLabel: string, alternative: string, description: string): number {
    const labelTokens = tokenize(valueLabel);
    const textTokens = tokenize(`${alternative} ${description}`);
    const labelSet = new Set(labelTokens);
    const textSet = new Set(textTokens);
    let overlap = 0;
    for (const token of labelSet) {
      if (textSet.has(token)) overlap += 1;
    }
    const denom = Math.max(labelSet.size, textSet.size, 1);
    let score = overlap / denom;
    if (valueLabel && alternative.toLowerCase().includes(valueLabel.toLowerCase())) {
      score = Math.min(1, score + 0.2);
    }
    return clamp01(score);
  }

  private extractTimeHorizonMonths(context?: Record<string, unknown>): number | undefined {
    if (!context) return undefined;
    const raw = context.timeHorizonMonths;
    if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
    if (typeof raw === 'string' && raw.trim() !== '') {
      const parsed = Number(raw);
      return Number.isFinite(parsed) ? parsed : undefined;
    }
    return undefined;
  }
}
