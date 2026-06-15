/**
 * 确定性记忆检索（零 LLM、零 embedding、离线可复现）—— ADR-0047 D2 Layer 1 的检索内核。
 *
 * 把原先内嵌在 companion/chat.ts 路由闭包里的 retrieveRelevantMemories 抽成**纯函数**：
 *   输入（记忆集 + 取边器 + query）→ 输出（按相关度排序、截断 top-K 的相关知识）。
 *
 * 抽离的唯一目的：让**检索质量基准**（retrieval-benchmark.ts）和**生产路由**跑同一份逻辑，
 * 而不是各测一份替身——否则基准测的是假目标，调参会被带偏（这正是 ① 的全部价值）。
 *
 * 检索两段（与抽离前逐字一致，零行为变化）：
 *   1. 直接命中：关键词分（scoreTextByKeyword）+ 连续短语加分（scorePhraseBonus，消歧）；
 *   2. 图遍历扩展：从前 GRAPH_EXPAND_SEEDS 条直接命中出发，沿强边（≥MIN_EDGE_STRENGTH）拉 1 跳
 *      语义相邻记忆。语义在蒸馏期沉淀为边，运行期纯确定性遍历——保住「相同输入→相同输出」+ 离线。
 *
 * 确定性保证：排序均带 id 字典序二级键（底层 Map 迭代顺序不可作契约）；邻居被多边拉到取最高分。
 */

import { tokenize, scoreTextByKeyword, scorePhraseBonus } from './conversation-knowledge-retriever.js';
import type { RelevantKnowledge } from './conversation-types.js';
import type { MemoryNode, MemoryEdge, MemoryId } from '@chrono/kernel';

/** 检索的相关记忆条数上限（喂给离线回应器作 grounding）。 */
export const MAX_GROUNDING_MEMORIES = 5;
/** 最小关键词分门槛：≥1 即任一内容词命中即可 grounding（停用词已剔除，存活 token 都是内容词）。 */
export const MIN_GROUNDING_SCORE = 1;
/** 图遍历扩展：从前 N 条直接命中的记忆出发，沿 memory_edge 拉语义相邻记忆。 */
export const GRAPH_EXPAND_SEEDS = 2;
/** 边强度门槛：弱于此的语义边不拉邻居（避免噪声边引入无关记忆）。 */
export const MIN_EDGE_STRENGTH = 0.3;
/** 图遍历邻居相关度衰减系数：邻居 relevance = 种子 relevance × 边强度 × 此系数（确保排在直接命中之后）。 */
export const NEIGHBOR_DECAY = 0.8;

/**
 * 取边器：给定记忆 id 返回与之相连的所有边（无向，source/target 任一端等于 id）。
 * 生产用 tenantOS.core.memories.getEdgesFor；基准/测试可注入内存实现。
 */
export type EdgeLookup = (id: MemoryId) => MemoryEdge[];

/**
 * 检索可调参数（默认取上面常量）。② 多跳/边权重调参时通过此入参覆盖，不改内核签名——
 * 这样基准能扫一组参数算 recall@k，找到最优后再回填默认值。
 */
export interface RetrievalParams {
  readonly maxResults: number;
  readonly minScore: number;
  readonly expandSeeds: number;
  readonly minEdgeStrength: number;
  readonly neighborDecay: number;
}

export const DEFAULT_RETRIEVAL_PARAMS: RetrievalParams = {
  maxResults: MAX_GROUNDING_MEMORIES,
  minScore: MIN_GROUNDING_SCORE,
  expandSeeds: GRAPH_EXPAND_SEEDS,
  minEdgeStrength: MIN_EDGE_STRENGTH,
  neighborDecay: NEIGHBOR_DECAY,
};

/**
 * 确定性检索纯函数：query × 记忆集 × 取边器 → 排序后的相关知识（top-K）。
 *
 * 纯函数、无 I/O、零 LLM/embedding。相同输入 → 相同输出（含 id 字典序 tie-break，不依赖 Map 顺序）。
 *
 * @param message     用户消息
 * @param memories    全量记忆（id → 节点）
 * @param edgesFor    取边器（蒸馏期沉淀的语义边，运行期只读遍历）
 * @param params      可调参数（默认 DEFAULT_RETRIEVAL_PARAMS）
 */
export function retrieveMemoriesDeterministic(
  message: string,
  memories: ReadonlyMap<MemoryId, MemoryNode>,
  edgesFor: EdgeLookup,
  params: RetrievalParams = DEFAULT_RETRIEVAL_PARAMS,
): RelevantKnowledge[] {
  const tokens = tokenize(message);
  if (tokens.length === 0) return [];

  /* 直接命中：关键词分 + 连续短语加分（消歧）。relevance 饱和归一化 score/(score+4)。 */
  const direct: RelevantKnowledge[] = [];
  for (const node of memories.values()) {
    const score = scoreTextByKeyword(node.content, tokens) + scorePhraseBonus(node.content, message);
    if (score < params.minScore) continue;
    direct.push({ id: node.id, title: '', content: node.content, relevance: score / (score + 4) });
  }
  direct.sort((a, b) => b.relevance - a.relevance || a.id.localeCompare(b.id));

  /* 图遍历扩展：从前 expandSeeds 条直接命中出发，沿强边拉 1 跳语义相邻记忆（未直接命中的）。
   * 邻居 relevance = 种子 relevance × 边强度 × neighborDecay（衰减，排在直接命中之后）。
   * 同邻居被多条边拉到取最高分。纯确定性图遍历——边由蒸馏期老师产，运行期不调任何模型。 */
  const seenIds = new Set(direct.map((d) => d.id));
  const neighborBest = new Map<MemoryId, RelevantKnowledge>();
  for (const seed of direct.slice(0, params.expandSeeds)) {
    for (const edge of edgesFor(seed.id)) {
      if (edge.strength < params.minEdgeStrength) continue;
      const neighborId = edge.source === seed.id ? edge.target : edge.source;
      if (seenIds.has(neighborId)) continue; /* 已直接命中，不重复 */
      const node = memories.get(neighborId);
      if (!node) continue;
      const relevance = seed.relevance * edge.strength * params.neighborDecay;
      const existing = neighborBest.get(neighborId);
      if (!existing || relevance > existing.relevance) {
        neighborBest.set(neighborId, { id: neighborId, title: '', content: node.content, relevance });
      }
    }
  }

  /* 合并：直接命中（按 relevance）在前，图遍历邻居（按 relevance，id 稳定 tie-break）在后，截断 top-K。 */
  const neighbors = [...neighborBest.values()].sort((a, b) => b.relevance - a.relevance || a.id.localeCompare(b.id));
  return [...direct, ...neighbors].slice(0, params.maxResults);
}
