/**
 * 结构化评分器
 * 基于 L0/L1/L2/L3 结构化信号计算综合分数
 */

import type { CoreValue } from '../types/core-self.js';
import type { CognitiveModel, DecisionStyle, SurvivalAnchor } from '../types/personality-os.js';

export interface ScoreBreakdown {
  valueContributions: Record<string, number>;
  anchorViolations: string[];
  biasAdjustments: Record<string, number>;
  timeHorizonEffect: number;
  cognitiveBiasTotal: number;
}

export interface StructuralScoreInput {
  valueWeights: ReadonlyMap<string, number>;
  values: ReadonlyMap<string, CoreValue>;
  scenarioRelevance: ReadonlyMap<string, number>;
  anchors: readonly SurvivalAnchor[];
  violations: readonly string[];
  riskScore: number;
  decisionStyle: DecisionStyle;
  cognitiveModel: CognitiveModel;
  timeHorizonMonths?: number;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

function resolveWeight(value: CoreValue, valueWeights: ReadonlyMap<string, number>): number {
  const override = valueWeights.get(value.id) ?? valueWeights.get(value.label);
  return Number.isFinite(override) ? (override as number) : value.weight;
}

function computeConstraintPenalty(
  anchors: readonly SurvivalAnchor[],
  violations: readonly string[],
): { penalty: number; matches: string[] } {
  if (anchors.length === 0 || violations.length === 0) return { penalty: 0, matches: [] };
  let penalty = 0;
  const matches: string[] = [];
  for (const violation of violations) {
    const match = anchors.find(a => violation.includes(a.id) || violation.includes(a.label));
    penalty += (match?.severity ?? 1) / 5;
    matches.push(match ? match.label : violation);
  }
  return { penalty: clamp01(penalty / Math.max(1, violations.length)) * 0.4, matches };
}

function computeStylePenalty(riskScore: number, style: DecisionStyle): number {
  const targetRisk = 1 - clamp01(style.riskAppetite);
  const riskGap = Math.abs(clamp01(riskScore) - targetRisk);
  const horizonPenalty = (1 - clamp01(style.timeHorizon)) * 0.1;
  return clamp01(riskGap * 0.3 + horizonPenalty);
}

function computeCognitiveBias(
  riskScore: number,
  cognitiveModel: CognitiveModel,
): { total: number; adjustments: Record<string, number> } {
  const adjustments: Record<string, number> = {};
  let total = 0;
  const clampedRisk = clamp01(riskScore);

  for (const [bias, weight] of cognitiveModel.biasWeights) {
    if (!Number.isFinite(weight)) continue;
    if (bias === 'confirmation') {
      const delta = weight * 0.05;
      adjustments.confirmation = (adjustments.confirmation ?? 0) + delta;
      total += delta;
    } else if (bias === 'loss_aversion') {
      const delta = -weight * clampedRisk * 0.1;
      adjustments.loss_aversion = (adjustments.loss_aversion ?? 0) + delta;
      total += delta;
    } else if (bias === 'optimism') {
      const delta = weight * 0.03;
      adjustments.optimism = (adjustments.optimism ?? 0) + delta;
      total += delta;
    } else if (bias === 'sunk_cost') {
      const delta = -weight * 0.02;
      adjustments.sunk_cost = (adjustments.sunk_cost ?? 0) + delta;
      total += delta;
    }
  }

  const growthFactor = 0.5 + clamp01(cognitiveModel.growthMindset) * 0.5;
  for (const key of Object.keys(adjustments)) {
    adjustments[key] *= growthFactor;
  }
  total *= growthFactor;

  const attributionAdjustment = (1 - clamp01(cognitiveModel.attributionStyle)) * 0.02;
  adjustments.attribution_style = (adjustments.attribution_style ?? 0) + attributionAdjustment;
  total += attributionAdjustment;

  return { total, adjustments };
}

export function computeStructuralScore(input: StructuralScoreInput): {
  alignmentScore: number;
  constraintPenalty: number;
  stylePenalty: number;
  cognitiveBias: number;
  overallScore: number;
  breakdown: ScoreBreakdown;
} {
  const values = [...input.values.values()];
  const valueContributions: Record<string, number> = {};
  let totalWeight = 0;
  let weightedSum = 0;
  let timeWeighted = 0;
  const horizonMonths = Number.isFinite(input.timeHorizonMonths) ? (input.timeHorizonMonths as number) : 12;

  for (const value of values) {
    const weight = resolveWeight(value, input.valueWeights);
    if (!Number.isFinite(weight)) continue;
    const emotionAmplifier = clamp(value.emotionAmplifier, 0.5, 2);
    const relevance = clamp01(input.scenarioRelevance.get(value.id) ?? input.scenarioRelevance.get(value.label) ?? 0);
    const contribution = weight * emotionAmplifier * relevance;
    const timeDiscount = clamp01(value.timeDiscount);
    const timeDecay = 1 - (1 - timeDiscount) * horizonMonths / 60;
    const timeFactor = clamp01(timeDecay);
    const timeAdjusted = contribution * timeFactor;

    weightedSum += timeAdjusted;
    const weighted = weight * emotionAmplifier;
    totalWeight += weighted;
    timeWeighted += weighted * timeFactor;
    valueContributions[value.label] = timeAdjusted;
  }

  const alignmentScore = weightedSum / Math.max(totalWeight, 0.001);
  const timeHorizonEffect = totalWeight > 0 ? timeWeighted / totalWeight : 0;

  const constraint = computeConstraintPenalty(input.anchors, input.violations);
  const stylePenalty = computeStylePenalty(input.riskScore, input.decisionStyle);
  const cognitiveBias = computeCognitiveBias(input.riskScore, input.cognitiveModel);
  const boundedBias = clamp(cognitiveBias.total, -0.2, 0.2);
  const overallScore = alignmentScore - constraint.penalty - stylePenalty + boundedBias;

  return {
    alignmentScore,
    constraintPenalty: constraint.penalty,
    stylePenalty,
    cognitiveBias: boundedBias,
    overallScore,
    breakdown: {
      valueContributions,
      anchorViolations: constraint.matches,
      biasAdjustments: cognitiveBias.adjustments,
      timeHorizonEffect,
      cognitiveBiasTotal: cognitiveBias.total,
    },
  };
}
