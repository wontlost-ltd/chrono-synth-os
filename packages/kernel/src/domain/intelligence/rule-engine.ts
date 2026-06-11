/**
 * 规则引擎（离线决策能力） — 纯领域逻辑
 * 基于 L0-L3 结构化评分的规则决策
 * 零 node:* 依赖
 */

import type { CoreValue } from '../core-self/value-types.js';
import type { SurvivalAnchor } from '../core-self/anchor-types.js';
import type { DecisionStyle } from '../core-self/decision-style-types.js';
import type { CognitiveModel } from '../core-self/cognitive-model-types.js';
import type { RulePayload } from '../core-self/distilled-artifact-types.js';
import type { ScoreBreakdown } from './structural-scorer.js';
import { computeStructuralScore } from './structural-scorer.js';
import {
  DEFAULT_ALTERNATIVES,
  type DecisionCase,
  type DecisionResult,
  type Explanation,
  type RankedOption,
} from './decision-types.js';
import { clamp01 } from '../math.js';

/** 规则引擎所需的人格状态（与 SimulationPersonaState 相同结构） */
export interface RuleEnginePersonaState {
  readonly L0: readonly SurvivalAnchor[];
  readonly L1: ReadonlyMap<string, CoreValue>;
  readonly L2: DecisionStyle;
  readonly L3: CognitiveModel;
  /** 可选持久规则：未提供时保持历史行为。 */
  readonly rules?: readonly RulePayload[];
}

/** 规则引擎配置 */
export interface RuleEngineConfig {
  readonly enabled: boolean;
  readonly fallbackStrategy: 'rule_only' | 'error';
}

export const DEFAULT_RULE_ENGINE_CONFIG: RuleEngineConfig = Object.freeze({
  enabled: true,
  fallbackStrategy: 'rule_only' as const,
});

/** 分词（中英文混合） */
function tokenize(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9\u4e00-\u9fff]+/).filter(Boolean);
}

/** 关键词相关度计算 */
function computeKeywordRelevance(valueLabel: string, alternative: string, description: string): number {
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

/** 从上下文提取时间视野 */
function extractTimeHorizonMonths(context?: Record<string, unknown>): number | undefined {
  if (!context) return undefined;
  const raw = context.timeHorizonMonths;
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string' && raw.trim() !== '') {
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

/** 选取贡献度最高的价值维度 */
function pickTopContribution(contributions: Record<string, number>): [string, number] | undefined {
  let best: [string, number] | undefined;
  for (const [key, value] of Object.entries(contributions)) {
    if (!best || value > best[1]) {
      best = [key, value];
    }
  }
  return best;
}

/** 构建决策解释 */
function buildExplanation(
  alternative: string,
  alignmentScore: number,
  overallScore: number,
  breakdown: ScoreBreakdown,
): Explanation {
  const top = pickTopContribution(breakdown.valueContributions);
  const evidence = top
    ? [{ source: 'rule', content: `关键词匹配偏重: ${top[0]}`, relevance: clamp01(Math.abs(top[1])) }]
    : [];
  return {
    summary: `规则引擎评估：${alternative} 对齐度 ${alignmentScore.toFixed(2)}，综合得分 ${overallScore.toFixed(2)}。`,
    evidence,
    counterfactuals: [],
  };
}

/** 计算备选方案与约束的冲突惩罚（独立于 L0 锚点） */
function computeConstraintPenalty(
  alternative: string,
  constraints?: readonly string[],
): number {
  if (!constraints || constraints.length === 0) return 0;
  const altLower = alternative.toLowerCase();
  let penaltyCount = 0;
  for (const constraint of constraints) {
    const cLower = constraint.toLowerCase();
    /* 子串匹配：约束关键词出现在备选方案中 */
    if (altLower.includes(cLower) || cLower.includes(altLower)) {
      penaltyCount++;
      continue;
    }
    /* token 交集匹配 */
    const altTokens = new Set(tokenize(alternative));
    const constraintTokens = tokenize(constraint);
    if (constraintTokens.length === 0) continue;
    const overlap = constraintTokens.filter(t => altTokens.has(t)).length;
    if (overlap > 0 && overlap >= Math.max(1, constraintTokens.length * 0.3)) {
      penaltyCount++;
    }
  }
  /* 每个命中约束扣 0.15，最多扣 0.6 */
  return Math.min(penaltyCount * 0.15, 0.6);
}

/** 按 active rules 对已惩罚分数做确定性微调：prefer 加分，avoid 减分。 */
function applyRuleAdjustment(
  score: number,
  alternative: string,
  textContext: string,
  rules?: readonly RulePayload[],
): number {
  if (!rules || rules.length === 0) return score;
  let adjusted = score;
  for (const rule of rules) {
    const relevance = computeKeywordRelevance(rule.condition, alternative, textContext);
    if (relevance <= 0) continue;
    const delta = rule.weight * relevance;
    adjusted += rule.action === 'prefer' ? delta : -delta;
  }
  return clamp01(adjusted);
}

/** 规则引擎评估（纯函数） */
export function evaluateDecisionCase(
  decisionCase: DecisionCase,
  persona: RuleEnginePersonaState,
  now: number,
): DecisionResult {
  const alternatives = decisionCase.alternatives && decisionCase.alternatives.length > 0
    ? [...decisionCase.alternatives]
    : [...DEFAULT_ALTERNATIVES];

  const valueWeights = new Map<string, number>();
  for (const value of persona.L1.values()) {
    valueWeights.set(value.id, value.weight);
    valueWeights.set(value.label, value.weight);
  }

  const timeHorizonMonths = extractTimeHorizonMonths(decisionCase.context);
  const scored: Array<{ option: RankedOption; score: number }> = [];

  const textContext = [decisionCase.title, decisionCase.description].filter(Boolean).join(' ');

  for (const alternative of alternatives) {
    const relevance = new Map<string, number>();
    for (const value of persona.L1.values()) {
      const score = computeKeywordRelevance(value.label, alternative, textContext);
      relevance.set(value.id, score);
      relevance.set(value.label, score);
    }

    const riskScore = 0.5;
    const structural = computeStructuralScore({
      valueWeights,
      values: persona.L1,
      scenarioRelevance: relevance,
      anchors: persona.L0,
      violations: [],
      riskScore,
      decisionStyle: persona.L2,
      cognitiveModel: persona.L3,
      timeHorizonMonths,
    });

    /* 约束惩罚独立于 L0 锚点，直接扣减综合得分 */
    const constraintPen = computeConstraintPenalty(alternative, decisionCase.constraints);
    const penalizedScore = clamp01(structural.overallScore - constraintPen);
    const adjustedScore = applyRuleAdjustment(penalizedScore, alternative, textContext, persona.rules);

    const explanation = buildExplanation(alternative, structural.alignmentScore, adjustedScore, structural.breakdown);
    const regretProbability = clamp01(persona.L2.regretSensitivity * (1 - adjustedScore));
    scored.push({
      option: {
        alternative,
        rank: 0,
        alignmentScore: structural.alignmentScore,
        riskScore,
        confidence: 0.4,
        overallScore: adjustedScore,
        regretProbability,
        explanation,
        scoreBreakdown: structural.breakdown,
      },
      score: adjustedScore,
    });
  }

  scored.sort((a, b) => b.score - a.score);
  const rankedOptions = scored.map((entry, idx) => ({ ...entry.option, rank: idx + 1 }));

  return {
    caseId: decisionCase.id,
    recommendedAlternative: rankedOptions[0]?.alternative ?? '',
    rankedOptions,
    simulatedAt: now,
  };
}
