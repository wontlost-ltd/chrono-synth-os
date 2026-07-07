/**
 * 确定性记忆联想建边（融会贯通的地基）。
 *
 * 问题：chat 沉淀的对话记忆、learn-topic 存的参考记忆，彼此**孤立无边** → 现有图遍历检索
 * （deterministic-memory-retrieval）虽能沿 memory_edge 联想，却没边可走 → 数字人记的是散点，
 * 无法「跨话题/跨来源」融会贯通。
 *
 * 方案：新记忆沉淀时，**确定性**地与既有记忆按**共享关键词重叠**连 `co_occurrence` 边——共享得越多、
 * 边越强。零 LLM、零 embedding：复用检索器同一份 tokenize（保证「联想口径」与「检索口径」一致）。
 * 可复现：相同记忆集 → 相同边（排序 + 阈值 + top-K + id 字典序二级键）。
 *
 * 边只**链接真实记忆**（安全：不改人格身份、不产知识），故直接建、不走蒸馏门（门的自动编译阈值是给
 * LLM 提议的边用的；确定性共现边本身即可信）。
 */

import { tokenize } from './conversation-knowledge-retriever.js';

/** 联想边关系名（与 perceive 的 co_perceived 区分：这是跨来源关键词共现）。 */
export const ASSOCIATION_RELATION = 'co_occurrence';

/** 触发建边的最低共享关键词数（<此视为无关，不连边——避免噪声边把无关记忆拉进联想）。 */
const MIN_SHARED_KEYWORDS = 2;
/** 单条新记忆最多连几条边（防一条泛词记忆与全库连边，稀释联想信号 + 控图规模）。 */
const MAX_EDGES_PER_MEMORY = 5;
/** 边强度下限（Jaccard 重叠 <此不连——太弱的关联是噪声）。 */
const MIN_EDGE_STRENGTH = 0.1;

/** 一条待建联想边。 */
export interface AssociativeEdge {
  readonly targetId: string;
  /** 边强度 [0,1]，= 共享关键词的 Jaccard 重叠度。 */
  readonly strength: number;
}

interface MemoryLike {
  readonly id: string;
  readonly content: string;
}

/**
 * 计算新记忆应与哪些既有记忆连联想边。纯函数、确定性。
 *   - 共享关键词 ≥ MIN_SHARED_KEYWORDS 才连；
 *   - 强度 = Jaccard(新记忆关键词, 既有记忆关键词) ≥ MIN_EDGE_STRENGTH；
 *   - 按强度降序、id 字典序二级键，取 top MAX_EDGES_PER_MEMORY（确定性、可复现）。
 * 排除 newId 自身。
 */
export function computeAssociativeEdges(
  newId: string,
  newContent: string,
  existing: readonly MemoryLike[],
): AssociativeEdge[] {
  const newTokens = new Set(tokenize(newContent));
  if (newTokens.size === 0) return [];

  const candidates: AssociativeEdge[] = [];
  for (const mem of existing) {
    if (mem.id === newId) continue;
    const memTokens = new Set(tokenize(mem.content));
    if (memTokens.size === 0) continue;

    let shared = 0;
    for (const t of newTokens) if (memTokens.has(t)) shared += 1;
    if (shared < MIN_SHARED_KEYWORDS) continue;

    /* Jaccard 重叠：shared / |并集|——归一化，避免长记忆（关键词多）天然占优。 */
    const unionSize = newTokens.size + memTokens.size - shared;
    const strength = unionSize > 0 ? shared / unionSize : 0;
    if (strength < MIN_EDGE_STRENGTH) continue;

    candidates.push({ targetId: mem.id, strength });
  }

  /* 确定性排序：强度降序，id 字典序二级键（底层集合迭代顺序不可作契约）。 */
  candidates.sort((a, b) => (b.strength - a.strength) || (a.targetId < b.targetId ? -1 : a.targetId > b.targetId ? 1 : 0));
  return candidates.slice(0, MAX_EDGES_PER_MEMORY);
}

/** 建边所需的最小 core.memories 端口（便于测试注入 + 解耦具体实现）。 */
export interface MemoryEdgeStore {
  getAllMemories(): Map<string, MemoryLike>;
  addEdge(source: string, target: string, relation: string, strength: number): unknown;
}

/**
 * 把一条新记忆确定性地联想连边到既有相关记忆（融会贯通地基）。沉淀 chat/learn 记忆后调用。
 * 失败/无关联 → no-op（安全：只加边不改内容）。返回建的边数（供观测/测试）。
 */
export function linkMemoryAssociatively(store: MemoryEdgeStore, newId: string, newContent: string): number {
  const existing = [...store.getAllMemories().values()];
  const edges = computeAssociativeEdges(newId, newContent, existing);
  for (const e of edges) {
    store.addEdge(newId, e.targetId, ASSOCIATION_RELATION, e.strength);
  }
  return edges.length;
}
