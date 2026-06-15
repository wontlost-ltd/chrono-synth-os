/**
 * 确定性检索质量基准（① 把「检索变好了吗」从体感变成可回归的硬数字）。
 *
 * 同 learning-benchmark 的思路：固定一组金标准 case（query → 期望命中的记忆 id），在**同一份生产检索
 * 逻辑**（retrieveMemoriesDeterministic）上跑，用固定 ground-truth 度量 precision@k / recall@k / MRR。
 * 任何动检索算法（② 多跳/边权重调参）的改动，跑一遍基准就知道质量涨没涨——不再靠手动问几句体感判断。
 *
 * 为什么 recall@k 是主指标（Codex learning-benchmark 同源经验）：companion 检索的**最痛点是漏召回**
 * （该记得的没拉出来 → 退化为 honest_offline，用户体感「它忘了」）。recall@k 跨改动可比、直击痛点。
 * precision@k（拉进来的有多少是真相关）与 MRR（第一个正确命中的排名）作辅助，刻画噪声与排序质量。
 *
 * 纯确定性、零 LLM/embedding/网络——基准本身和被测逻辑一样可复现（相同 case + 相同记忆 → 相同数字）。
 */

import type { MemoryNode, MemoryEdge, MemoryId } from '@chrono/kernel';
import {
  retrieveMemoriesDeterministic,
  DEFAULT_RETRIEVAL_PARAMS,
  type RetrievalParams,
  type EdgeLookup,
} from './deterministic-memory-retrieval.js';

/**
 * 单个金标准 case：一句 query + 该 query「应当命中」的记忆 id 集合（人工标注的 ground-truth）。
 * 期望集为「真相关」——检索把它们排进 top-k 才算召回成功。
 */
export interface RetrievalCase {
  readonly id: string;
  readonly query: string;
  /** 该 query 真正相关、应被检索命中的记忆 id（≥1，否则 recall 无意义）。 */
  readonly expectedMemoryIds: readonly MemoryId[];
}

/** 单个 case 在某次检索下的度量。 */
export interface RetrievalCaseMetrics {
  readonly caseId: string;
  /** 检索实际返回的记忆 id（按相关度排序，已截断 top-k）。 */
  readonly retrieved: readonly MemoryId[];
  /** precision@k：命中期望集的项数 / k（分母固定为 k，欠返回会被惩罚——跨配置可比，不被「少返回」作弊抬高）。 */
  readonly precision: number;
  /** recall@k：期望集中被返回命中的比例（**主信号**）。 */
  readonly recall: number;
  /** reciprocal rank：第一个命中期望集的返回项排名倒数（1/rank），无命中记 0。 */
  readonly reciprocalRank: number;
}

/** 一次基准运行的汇总指标（全 case 平均）。 */
export interface RetrievalBenchmarkMetrics {
  readonly cases: readonly RetrievalCaseMetrics[];
  /** **主指标**：平均 recall@k（漏召回是最痛点，跨改动可比）。 */
  readonly meanRecall: number;
  /** 平均 precision@k（分母 k，噪声/欠返回信号，辅助）。 */
  readonly meanPrecision: number;
  /** 平均 reciprocal rank = MRR（排序质量，辅助）。 */
  readonly mrr: number;
}

/** baseline（默认参数）vs candidate（调参后）的对比结果。 */
export interface RetrievalBenchmarkComparison {
  readonly baseline: RetrievalBenchmarkMetrics;
  readonly candidate: RetrievalBenchmarkMetrics;
  /** **主对比**：recall 变化（>0 = 改动让召回更全）。 */
  readonly recallDelta: number;
  /** precision 变化（<0 提醒「召回上去但噪声也上去了」，需权衡）。 */
  readonly precisionDelta: number;
  /** MRR 变化（排序是否更优）。 */
  readonly mrrDelta: number;
}

/** 固定 dataset：被检索的记忆全集 + 边集（基准与生产同构）。 */
export interface RetrievalDataset {
  readonly memories: ReadonlyMap<MemoryId, MemoryNode>;
  readonly edges: readonly MemoryEdge[];
}

/** 由边集构造确定性取边器（无向：source/target 任一端等于 id）。 */
export function buildEdgeLookup(edges: readonly MemoryEdge[]): EdgeLookup {
  const byNode = new Map<MemoryId, MemoryEdge[]>();
  for (const edge of edges) {
    (byNode.get(edge.source) ?? byNode.set(edge.source, []).get(edge.source)!).push(edge);
    if (edge.target !== edge.source) {
      (byNode.get(edge.target) ?? byNode.set(edge.target, []).get(edge.target)!).push(edge);
    }
  }
  return (id) => byNode.get(id) ?? [];
}

/**
 * 跑一组检索金标准 case，汇总 precision/recall@k + MRR（确定性，零 LLM）。
 *
 * fixture 完整性（learning-benchmark 同源经验）：
 *   - 空 case 集抛错（避免「成功但无证据」的空基准）；
 *   - 每个 case 的 expectedMemoryIds 非空、且全部真实存在于 dataset.memories——否则 recall 会
 *     静默偏低（看似「检索差」实为金标准写错 id），显式抛错暴露。
 *
 * @param dataset 被检索的记忆全集 + 边集
 * @param cases   金标准 case
 * @param k       截断深度（top-k）。默认取检索参数的 maxResults，使度量与生产同口径。
 * @param params  检索参数（② 调参时覆盖；默认 DEFAULT_RETRIEVAL_PARAMS）
 */
export function runRetrievalBenchmark(
  dataset: RetrievalDataset,
  cases: readonly RetrievalCase[],
  k: number = DEFAULT_RETRIEVAL_PARAMS.maxResults,
  params: RetrievalParams = DEFAULT_RETRIEVAL_PARAMS,
): RetrievalBenchmarkMetrics {
  if (cases.length === 0) throw new Error('runRetrievalBenchmark: cases must not be empty');
  if (k < 1) throw new Error(`runRetrievalBenchmark: k must be >= 1, got ${k}`);

  const edgesFor = buildEdgeLookup(dataset.edges);
  /* 用调参后的 maxResults 还是固定 k？基准固定 k，确保 baseline/candidate 在**同一截断深度**下可比
   * （否则调大 maxResults 会"作弊"提升 recall）。检索内部仍按 params 打分/扩边，仅最终截断用 k。 */
  const evalParams: RetrievalParams = { ...params, maxResults: k };

  const results: RetrievalCaseMetrics[] = [];
  for (const c of cases) {
    if (c.expectedMemoryIds.length === 0) {
      throw new Error(`runRetrievalBenchmark: case ${c.id} has empty expectedMemoryIds`);
    }
    for (const id of c.expectedMemoryIds) {
      if (!dataset.memories.has(id)) {
        throw new Error(`runRetrievalBenchmark: case ${c.id} expects memory "${id}" not present in dataset`);
      }
    }

    const retrieved = retrieveMemoriesDeterministic(c.query, dataset.memories, edgesFor, evalParams).map((r) => r.id);
    results.push(scoreCase(c, retrieved, k));
  }

  return {
    cases: results,
    meanRecall: mean(results.map((m) => m.recall)),
    meanPrecision: mean(results.map((m) => m.precision)),
    mrr: mean(results.map((m) => m.reciprocalRank)),
  };
}

/**
 * 对单个 case 算 precision@k / recall@k / RR（纯函数，便于单测）。
 * precision@k 分母固定为 k（非 retrieved.length）：欠返回（返回 < k 条）会被惩罚，避免「少返回但都命中」
 * 把 precision 虚高到 1.0（Codex 复审采纳）——这样跨配置比较时 precision 才公平。
 */
function scoreCase(c: RetrievalCase, retrieved: readonly MemoryId[], k: number): RetrievalCaseMetrics {
  const expected = new Set(c.expectedMemoryIds);
  let hits = 0;
  let reciprocalRank = 0;
  for (let i = 0; i < retrieved.length; i++) {
    if (expected.has(retrieved[i])) {
      hits++;
      if (reciprocalRank === 0) reciprocalRank = 1 / (i + 1); /* 第一个命中的排名倒数 */
    }
  }
  return {
    caseId: c.id,
    retrieved,
    precision: hits / k,
    recall: hits / expected.size,
    reciprocalRank,
  };
}

/**
 * 对比 baseline 与 candidate（纯对比，无副作用）。② 调参时：baseline=默认参数跑的指标，
 * candidate=调参后跑的指标，recallDelta>0 即「改动让召回更全」。
 *
 * 强校验 case 集一致（learning-benchmark 同源经验）：caseId 集合必须完全相同、无重复，
 * 否则缺/多/重复 case 会静默产生看似有效的 delta → 抛错。
 */
export function compareRetrievalBenchmarks(
  baseline: RetrievalBenchmarkMetrics,
  candidate: RetrievalBenchmarkMetrics,
): RetrievalBenchmarkComparison {
  assertSameCaseSet(baseline, candidate);
  return {
    baseline,
    candidate,
    recallDelta: candidate.meanRecall - baseline.meanRecall,
    precisionDelta: candidate.meanPrecision - baseline.meanPrecision,
    mrrDelta: candidate.mrr - baseline.mrr,
  };
}

function assertSameCaseSet(a: RetrievalBenchmarkMetrics, b: RetrievalBenchmarkMetrics): void {
  const ids = (m: RetrievalBenchmarkMetrics) => m.cases.map((c) => c.caseId);
  const aIds = ids(a);
  const bIds = ids(b);
  const aSet = new Set(aIds);
  const bSet = new Set(bIds);
  if (aSet.size !== aIds.length || bSet.size !== bIds.length) {
    throw new Error('compareRetrievalBenchmarks: duplicate caseId in a run');
  }
  if (aSet.size !== bSet.size || [...aSet].some((id) => !bSet.has(id))) {
    throw new Error('compareRetrievalBenchmarks: baseline/candidate case sets differ');
  }
}

function mean(xs: readonly number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((s, x) => s + x, 0) / xs.length;
}
