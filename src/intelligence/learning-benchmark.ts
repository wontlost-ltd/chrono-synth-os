/**
 * Persona learning benchmark（自演化补强 WP-2）。
 *
 * 把「数字人真的在变好吗」从叙事变成**可回归的数字**：同一组固定 decision case，分别在
 * baseline persona 与 learned persona（经价值蒸馏后）上跑**确定性零-LLM** 决策引擎（autonomous 模式），
 * 用**固定外部 oracle**（每个 case 的 expectedAlternative）度量命中率。
 *
 * 关键（Codex WP-2 Major）：主指标是 **accuracy（命中 oracle 的比例）**，跨 baseline/learned 可比——
 * 它度量「决策对不对」而非「persona 更偏好它学到的」。overallScore/regretProbability 只作辅助参考，
 * 因为它们在不同 persona 权重下定义已变，不可直接跨配置比较（同一推荐项的分数含义不同）。
 */

import type { DecisionCase, DecisionResult } from './types.js';

/**
 * benchmark 用的 case：DecisionCase + 固定 oracle（该 case「更好」的备选，应是 alternatives 之一）。
 */
export interface BenchmarkCase {
  readonly decisionCase: DecisionCase;
  readonly expectedAlternative: string;
}

/** 单个 case 的度量。 */
export interface CaseMetrics {
  readonly caseId: string;
  readonly recommended: string;
  /** 推荐是否命中 oracle（固定 ground-truth，跨配置可比 → 主信号）。 */
  readonly correct: boolean;
  /** 推荐项综合分（persona 视角，**非跨配置可比**，仅辅助）。 */
  readonly topScore: number;
  /** 推荐项后悔概率（overallScore 派生量，辅助）。 */
  readonly topRegret: number;
}

/** 一次 benchmark 运行的汇总指标。 */
export interface BenchmarkMetrics {
  readonly cases: readonly CaseMetrics[];
  /** **主指标**：命中 oracle 的比例（0..1，跨 baseline/learned 可比）。 */
  readonly accuracy: number;
  /** 平均综合分（辅助，不可跨配置直接比）。 */
  readonly meanScore: number;
  /** 平均后悔概率（辅助派生量）。 */
  readonly meanRegret: number;
}

/** baseline vs learned 的对比结果。 */
export interface BenchmarkComparison {
  readonly baseline: BenchmarkMetrics;
  readonly learned: BenchmarkMetrics;
  /** **主对比**：命中率变化（>0 = 学习让决策更靠近 ground-truth）。 */
  readonly accuracyDelta: number;
  /** 推荐项发生变化的 case 数（学习改变了决策）。 */
  readonly recommendationChanges: number;
}

/** 决策引擎的最小接口（便于测试注入；真实是 DecisionEngine.evaluate）。 */
export interface BenchmarkEngine {
  evaluate(decisionCase: DecisionCase, options: { mode: 'autonomous' }): Promise<DecisionResult>;
}

/** 取推荐项：用 rankedOptions[0]（top）；若与 recommendedAlternative 不一致则以 top 为准并暴露。 */
function recommendedOf(r: DecisionResult): string {
  const top = r.rankedOptions[0]?.alternative;
  return top ?? r.recommendedAlternative;
}

function mean(xs: readonly number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((s, x) => s + x, 0) / xs.length;
}

/**
 * 在给定引擎上跑一组 benchmark case，按 oracle 汇总指标（确定性，autonomous 零-LLM）。
 * 空 case 集抛错（避免「成功但无证据」的空 benchmark，Codex WP-2 Minor）。
 */
export async function runBenchmark(
  engine: BenchmarkEngine,
  cases: readonly BenchmarkCase[],
): Promise<BenchmarkMetrics> {
  if (cases.length === 0) throw new Error('runBenchmark: cases must not be empty');
  const results: CaseMetrics[] = [];
  for (const bc of cases) {
    /* fixture 完整性（Codex WP-2 Minor）：oracle 必须是该 case 的备选之一，否则 accuracy
     * 会静默偏低（看似「学得差」实为 benchmark 数据写错）→ 显式抛错暴露。
     * alternatives 可选（决策引擎可自生成备选），但 benchmark 要求 fixture 显式给出可比备选。 */
    const alternatives = bc.decisionCase.alternatives ?? [];
    if (!alternatives.includes(bc.expectedAlternative)) {
      throw new Error(
        `runBenchmark: expectedAlternative "${bc.expectedAlternative}" not in alternatives of case ${bc.decisionCase.id}`,
      );
    }
    const r = await engine.evaluate(bc.decisionCase, { mode: 'autonomous' });
    /* 引擎返回的 caseId 必须与输入一致，否则结果错位归档、后续 case-set 校验也会被误导。 */
    if (r.caseId !== bc.decisionCase.id) {
      throw new Error(`runBenchmark: engine returned caseId "${r.caseId}" for input case "${bc.decisionCase.id}"`);
    }
    const top = r.rankedOptions[0];
    const recommended = recommendedOf(r);
    results.push({
      caseId: r.caseId,
      recommended,
      correct: recommended === bc.expectedAlternative,
      topScore: top?.overallScore ?? 0,
      topRegret: top?.regretProbability ?? 0,
    });
  }
  return {
    cases: results,
    accuracy: mean(results.map((m) => (m.correct ? 1 : 0))),
    meanScore: mean(results.map((m) => m.topScore)),
    meanRegret: mean(results.map((m) => m.topRegret)),
  };
}

/**
 * 对比 baseline 与 learned（纯对比，无副作用）。
 * accuracyDelta>0 表示「learned 配置比 baseline 更靠近 oracle」。证明强度取决于 learned
 * **怎么来的**：经真实 earn→distill→门控→编译闭环得到的 learned 才是「自我进化使决策更优」
 * 的证据；手动调权得到的 learned 只证明「权重变化会改变 RuleEngine 排序」。两类测试都有，
 * 见 learning-benchmark.test.ts。
 *
 * 强校验 case 集一致（Codex WP-2 Major）：caseId 集合必须完全相同、无重复，否则抛错——
 * 否则缺/多/重复 case 会静默产生看似有效的 delta。
 */
export function compareBenchmarks(
  baseline: BenchmarkMetrics,
  learned: BenchmarkMetrics,
): BenchmarkComparison {
  assertSameCaseSet(baseline, learned);
  const byId = new Map(baseline.cases.map((c) => [c.caseId, c]));
  let recommendationChanges = 0;
  for (const lc of learned.cases) {
    const bc = byId.get(lc.caseId)!;
    if (bc.recommended !== lc.recommended) recommendationChanges++;
  }
  return {
    baseline,
    learned,
    accuracyDelta: learned.accuracy - baseline.accuracy,
    recommendationChanges,
  };
}

function assertSameCaseSet(a: BenchmarkMetrics, b: BenchmarkMetrics): void {
  const ids = (m: BenchmarkMetrics) => m.cases.map((c) => c.caseId);
  const aIds = ids(a);
  const bIds = ids(b);
  const aSet = new Set(aIds);
  const bSet = new Set(bIds);
  if (aSet.size !== aIds.length || bSet.size !== bIds.length) {
    throw new Error('compareBenchmarks: duplicate caseId in a run');
  }
  if (aSet.size !== bSet.size || [...aSet].some((id) => !bSet.has(id))) {
    throw new Error('compareBenchmarks: baseline/learned case sets differ');
  }
}
