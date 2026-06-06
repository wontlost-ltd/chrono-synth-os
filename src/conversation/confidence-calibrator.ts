/**
 * 置信度校准（P1-C 加固 4）
 *
 * 输出 CalibratedConfidence：包含中心 score、置信区间 [lower, upper]、
 * 因子分解 factors[]。让前端可视化"为什么是这个分数"。
 *
 * 校准方法：
 *   - base = 0.5
 *   - knowledge_coverage：检索到的知识相关度均值（每条最高加 0.1，最多 0.3）
 *   - knowledge_count：检索条数（>= 3 加 0.1）
 *   - guard_post_redact: -0.3（强不确定性，因为 LLM 输出被改写）
 *   - guard_escalate: -0.15（人工兜底语义信号，前端宜淡化）
 *   - llm_fallback: -0.4（LLM 完全失败，纯模板回复）
 *   - quota_exceeded: -0.4
 *   - low_token_output: -0.1（completionTokens < 5 → 极短输出）
 *
 * 区间 = score ± 0.1（默认）；不确定性大的场景区间扩大到 ±0.2。
 */

import type {
  CalibratedConfidence,
  ConfidenceFactor,
  ConfidenceLevel,
  GuardAction,
  RelevantKnowledge,
} from './conversation-types.js';

export interface CalibrationInput {
  memoriesUsed: RelevantKnowledge[];
  guardAction: GuardAction;
  shouldEscalate: boolean;
  llmFallback: boolean;
  quotaExceeded: boolean;
  completionTokens: number;
}

export function calibrateConfidence(input: CalibrationInput): CalibratedConfidence {
  const factors: ConfidenceFactor[] = [];
  let score = 0.5;
  factors.push({
    name: 'base',
    weight: 1,
    contribution: 0.5,
    detail: 'base score',
  });

  /* 知识覆盖度 */
  if (input.memoriesUsed.length > 0) {
    const avgRelevance = input.memoriesUsed.reduce((s, m) => s + m.relevance, 0) / input.memoriesUsed.length;
    const knowledgeBoost = Math.min(0.3, input.memoriesUsed.length * 0.1) * avgRelevance;
    score += knowledgeBoost;
    factors.push({
      name: 'knowledge_coverage',
      weight: 0.3,
      contribution: knowledgeBoost,
      detail: `${input.memoriesUsed.length} items, avg relevance ${avgRelevance.toFixed(2)}`,
    });
  }
  if (input.memoriesUsed.length >= 3) {
    score += 0.1;
    factors.push({
      name: 'knowledge_count',
      weight: 0.1,
      contribution: 0.1,
      detail: `${input.memoriesUsed.length} >= 3 sources`,
    });
  }

  let intervalWidth = 0.1;
  if (input.guardAction === 'post_redact') {
    score -= 0.3;
    intervalWidth = 0.2;
    factors.push({ name: 'guard_post_redact', weight: 0.3, contribution: -0.3, detail: 'output redacted by guard' });
  } else if (input.shouldEscalate) {
    score -= 0.15;
    intervalWidth = 0.15;
    factors.push({ name: 'guard_escalate', weight: 0.15, contribution: -0.15, detail: 'always_escalate matched' });
  } else if (input.guardAction === 'pre_block') {
    score = 0.2;
    intervalWidth = 0.05;
    factors.push({ name: 'guard_pre_block', weight: 0, contribution: 0, detail: 'pinned at low confidence' });
  } else if (input.guardAction === 'needs_confirmation') {
    score = 0.3;
    intervalWidth = 0.05;
    factors.push({ name: 'guard_needs_confirmation', weight: 0, contribution: 0, detail: 'awaiting user confirmation' });
  }

  if (input.llmFallback) {
    score -= 0.4;
    intervalWidth = 0.25;
    /* ADR-0047：区分自主离线回应（人格落地）与无能力时的静态降级 */
    if (input.guardAction === 'autonomous_response') {
      factors.push({ name: 'autonomous_response', weight: 0.4, contribution: -0.4, detail: 'offline deterministic response (no LLM)' });
    } else {
      factors.push({ name: 'llm_fallback', weight: 0.4, contribution: -0.4, detail: 'LLM unreachable, template response' });
    }
  }
  if (input.quotaExceeded) {
    score -= 0.4;
    intervalWidth = 0.25;
    factors.push({ name: 'quota_exceeded', weight: 0.4, contribution: -0.4, detail: 'tenant token quota exhausted' });
  }
  if (input.completionTokens > 0 && input.completionTokens < 5 && !input.llmFallback) {
    score -= 0.1;
    factors.push({ name: 'low_token_output', weight: 0.1, contribution: -0.1, detail: `${input.completionTokens} completion tokens` });
  }

  score = clamp01(score);
  const lower = clamp01(score - intervalWidth);
  const upper = clamp01(score + intervalWidth);

  const level: ConfidenceLevel = score >= 0.75 ? 'high' : score >= 0.45 ? 'medium' : 'low';

  return {
    score: round3(score),
    level,
    interval: { lower: round3(lower), upper: round3(upper) },
    factors: factors.map((f) => ({ ...f, contribution: round3(f.contribution) })),
  };
}

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
