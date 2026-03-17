/**
 * 决策引擎类型定义 — 纯领域类型
 * 零 node:* 依赖
 */

import type { ScoreBreakdown } from './structural-scorer.js';

/** 决策案例输入 */
export interface DecisionCase {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly alternatives?: readonly string[];
  readonly constraints?: readonly string[];
  readonly context?: Record<string, unknown>;
}

/** 决策引擎输出 */
export interface DecisionResult {
  readonly caseId: string;
  readonly recommendedAlternative: string;
  readonly rankedOptions: readonly RankedOption[];
  readonly simulatedAt: number;
}

/** 排序后的备选方案 */
export interface RankedOption {
  readonly alternative: string;
  readonly rank: number;
  readonly alignmentScore: number;
  readonly riskScore: number;
  readonly confidence: number;
  readonly overallScore: number;
  /** 后悔概率 = regretSensitivity × (1 - overallScore) */
  readonly regretProbability: number;
  readonly explanation: Explanation;
  readonly scoreBreakdown?: ScoreBreakdown;
}

/** 决策解释 */
export interface Explanation {
  readonly summary: string;
  readonly evidence: readonly EvidenceItem[];
  readonly counterfactuals: readonly Counterfactual[];
}

/** 证据条目 */
export interface EvidenceItem {
  readonly source: string;
  readonly content: string;
  readonly relevance: number;
}

/** 反事实推理 */
export interface Counterfactual {
  readonly scenario: string;
  readonly outcome: string;
  readonly probability: number;
}

/** 单次模拟展开结果 */
export interface SimulationRollout {
  readonly alternative: string;
  readonly outcomes: readonly string[];
  readonly valueAlignment: ReadonlyMap<string, number>;
  readonly constraintViolations: readonly string[];
  readonly alignmentScore: number;
  readonly riskScore: number;
  readonly confidence: number;
  readonly overallScore: number;
  readonly scoreBreakdown?: ScoreBreakdown;
}

/** 模拟配置 */
export interface SimulationConfig {
  readonly rollouts: number;
  readonly maxOptions: number;
}

/** 无备选方案时的默认选项 */
export const DEFAULT_ALTERNATIVES: readonly string[] = Object.freeze(['保持现状', '采取行动']);
