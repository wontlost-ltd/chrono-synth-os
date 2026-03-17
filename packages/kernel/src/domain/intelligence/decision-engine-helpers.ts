/**
 * 决策引擎纯辅助函数 — 纯领域逻辑
 * 从 DecisionEngine 类中提取的无副作用纯函数
 * 零 node:* 依赖
 */

import type { ScoreBreakdown } from './structural-scorer.js';
import type { SimulationRollout } from './decision-types.js';

/** 决策进度回调 */
export interface DecisionProgress {
  readonly progress: number;
  readonly stage: string;
}

/** 记忆检索数量 */
export const CONTEXT_MEMORY_COUNT = 5;
/** 最低备选方案数量 */
export const MIN_ALTERNATIVES = 2;
/** 结构化评分缺失时的默认风险值 */
export const DEFAULT_RISK_SCORE = 0.5;
/** 结构化评分缺失时的默认置信度 */
export const DEFAULT_CONFIDENCE = 0.5;
/** 无 rollout 数据时的降级置信度 */
export const EMPTY_ROLLOUT_CONFIDENCE = 0.3;

/** 安全解析 JSON，容忍被文本包裹的 JSON 片段 */
export function safeParseJson<T>(content: string): T | undefined {
  try {
    return JSON.parse(content) as T;
  } catch {
    const match = content.match(/\{[\s\S]*\}/);
    if (!match) return undefined;
    try {
      return JSON.parse(match[0]) as T;
    } catch {
      return undefined;
    }
  }
}

/** 上下文记忆的最小投影（用于格式化，不依赖完整 ContextMemory） */
export interface ContextMemorySlim {
  readonly score: number;
  readonly kind: string;
  readonly content: string;
}

/** 将记忆列表格式化为提示词文本 */
export function formatMemories(memories: readonly ContextMemorySlim[]): string {
  if (memories.length === 0) return '无';
  return memories.map(m => `- (${m.score.toFixed(2)}) [${m.kind}] ${m.content}`).join('\n');
}

/** 聚合多次模拟 rollout 的评分 */
export function aggregateRollouts(rollouts: readonly SimulationRollout[]): {
  alignmentScore: number;
  riskScore: number;
  confidence: number;
  overallScore: number;
  scoreBreakdown?: ScoreBreakdown;
} {
  if (rollouts.length === 0) {
    return { alignmentScore: 0, riskScore: DEFAULT_RISK_SCORE, confidence: EMPTY_ROLLOUT_CONFIDENCE, overallScore: 0 };
  }
  const avg = (list: readonly number[]) => list.reduce((s, v) => s + v, 0) / list.length;
  const overallScore = avg(rollouts.map(r => r.overallScore));
  const scoreBreakdown = aggregateScoreBreakdown(rollouts);
  return {
    alignmentScore: avg(rollouts.map(r => r.alignmentScore)),
    riskScore: avg(rollouts.map(r => r.riskScore)),
    confidence: avg(rollouts.map(r => r.confidence)),
    overallScore,
    scoreBreakdown,
  };
}

/** 聚合多次 rollout 的评分分解 */
export function aggregateScoreBreakdown(rollouts: readonly SimulationRollout[]): ScoreBreakdown | undefined {
  let count = 0;
  const valueTotals: Record<string, number> = {};
  const biasTotals: Record<string, number> = {};
  const anchorSet = new Set<string>();
  let timeTotal = 0;
  let biasTotal = 0;

  for (const rollout of rollouts) {
    const breakdown = rollout.scoreBreakdown;
    if (!breakdown) continue;
    count += 1;
    for (const [key, value] of Object.entries(breakdown.valueContributions)) {
      valueTotals[key] = (valueTotals[key] ?? 0) + value;
    }
    for (const [key, value] of Object.entries(breakdown.biasAdjustments)) {
      biasTotals[key] = (biasTotals[key] ?? 0) + value;
    }
    for (const violation of breakdown.anchorViolations) {
      anchorSet.add(violation);
    }
    timeTotal += breakdown.timeHorizonEffect;
    biasTotal += breakdown.cognitiveBiasTotal;
  }

  if (count === 0) return undefined;

  for (const key of Object.keys(valueTotals)) {
    valueTotals[key] /= count;
  }
  for (const key of Object.keys(biasTotals)) {
    biasTotals[key] /= count;
  }

  return {
    valueContributions: valueTotals,
    anchorViolations: [...anchorSet],
    biasAdjustments: biasTotals,
    timeHorizonEffect: timeTotal / count,
    cognitiveBiasTotal: biasTotal / count,
  };
}
