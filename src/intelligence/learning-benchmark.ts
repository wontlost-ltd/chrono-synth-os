/**
 * Persona learning benchmark（自演化补强 WP-2）。
 *
 * 把「数字人真的在变好吗」从叙事变成**可回归的数字**：同一组固定 decision case，分别在
 * baseline persona 与 learned persona（经价值蒸馏后）上跑**确定性零-LLM** 决策引擎（autonomous 模式），
 * 采集可度量指标，对比学习前后的变化。
 *
 * 指标全部来自决策引擎既有输出（DecisionResult.rankedOptions[].{overallScore, regretProbability}），
 * 不新增侵入式埋点。runner 纯编排，便于测 + 接 ga:check（advisory）。
 */

import type { DecisionCase, DecisionResult } from './types.js';

/** 单个 case 的度量。 */
export interface CaseMetrics {
  readonly caseId: string;
  readonly recommended: string;
  /** 推荐项的综合分（越高越好）。 */
  readonly topScore: number;
  /** 推荐项的后悔概率（越低越好）。 */
  readonly topRegret: number;
}

/** 一次 benchmark 运行（一组 case）的汇总指标。 */
export interface BenchmarkMetrics {
  readonly cases: readonly CaseMetrics[];
  /** 平均综合分（推荐项）。 */
  readonly meanScore: number;
  /** 平均后悔概率（推荐项）。 */
  readonly meanRegret: number;
}

/** baseline vs learned 的对比结果。 */
export interface BenchmarkComparison {
  readonly baseline: BenchmarkMetrics;
  readonly learned: BenchmarkMetrics;
  /** learned - baseline（meanScore 升为正向改善；meanRegret 降为正向改善）。 */
  readonly meanScoreDelta: number;
  readonly meanRegretDelta: number;
  /** 推荐项发生变化的 case 数（学习改变了决策）。 */
  readonly recommendationChanges: number;
}

/** 决策引擎的最小接口（便于测试注入；真实是 DecisionEngine.evaluate）。 */
export interface BenchmarkEngine {
  evaluate(decisionCase: DecisionCase, options: { mode: 'autonomous' }): Promise<DecisionResult>;
}

function toCaseMetrics(r: DecisionResult): CaseMetrics {
  const top = r.rankedOptions[0];
  return {
    caseId: r.caseId,
    recommended: r.recommendedAlternative,
    topScore: top?.overallScore ?? 0,
    topRegret: top?.regretProbability ?? 0,
  };
}

function mean(xs: readonly number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((s, x) => s + x, 0) / xs.length;
}

/** 在给定引擎上跑一组 case，汇总指标（确定性，autonomous 零-LLM）。 */
export async function runBenchmark(
  engine: BenchmarkEngine,
  cases: readonly DecisionCase[],
): Promise<BenchmarkMetrics> {
  const results: CaseMetrics[] = [];
  for (const c of cases) {
    results.push(toCaseMetrics(await engine.evaluate(c, { mode: 'autonomous' })));
  }
  return {
    cases: results,
    meanScore: mean(results.map((m) => m.topScore)),
    meanRegret: mean(results.map((m) => m.topRegret)),
  };
}

/**
 * 对比 baseline 引擎与 learned 引擎在同一组 case 上的指标（纯对比，无副作用）。
 * meanScoreDelta>0 / meanRegretDelta<0 表示「学习后决策更好」（更高综合分、更低后悔）。
 */
export function compareBenchmarks(
  baseline: BenchmarkMetrics,
  learned: BenchmarkMetrics,
): BenchmarkComparison {
  const byId = new Map(baseline.cases.map((c) => [c.caseId, c]));
  let recommendationChanges = 0;
  for (const lc of learned.cases) {
    const bc = byId.get(lc.caseId);
    if (bc && bc.recommended !== lc.recommended) recommendationChanges++;
  }
  return {
    baseline,
    learned,
    meanScoreDelta: learned.meanScore - baseline.meanScore,
    meanRegretDelta: learned.meanRegret - baseline.meanRegret,
    recommendationChanges,
  };
}
