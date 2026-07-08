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
 * 强度度量 = **重叠系数** overlap = 共享 / min(|A|,|B|)，**非** Jaccard。
 * 为何：tokenize 是 CJK bigram/trigram 字符 n-gram，一句话产 ~30 token；Jaccard=共享/并集 会被长文本的
 * 并集稀释（真·相关的「杭州旅游↔杭州美食」Jaccard 仅 0.094，永远连不上）。overlap 度量「较短记忆的概念有
 * 多少被共享」——才是「两条记忆是否谈同一批概念」的正确刻画：杭州对 overlap=0.185 连上，Java↔Rust（只共享
 * 「我在学」这类短语碎片）overlap=0.143 被拒，天气无关 overlap=0.043 被拒，分离清晰。
 *
 * 边只**链接真实记忆**（安全：不改人格身份、不产知识），故直接建、不走蒸馏门（门的自动编译阈值是给
 * LLM 提议的边用的；确定性共现边本身即可信）。
 */

import { tokenize } from './conversation-knowledge-retriever.js';

/** 联想边关系名（与 perceive 的 co_perceived 区分：这是跨来源关键词共现）。 */
export const ASSOCIATION_RELATION = 'co_occurrence';

/** 记忆来源显示前缀（沉淀/学习时加的样板标注）。计算联想关键词前必须剥除——否则每条对话记忆都共享
 * 「来自/对话」等样板 token，把无关记忆（如 Java↔Rust 仅共享「我在学」）虚抬过门槛，误连成联想。
 * 与 conversation-memory-capture 的 CONVERSATION_MEMORY_PREFIX、me.ts 学习记忆前缀保持同步。 */
const BOILERPLATE_PREFIXES: readonly RegExp[] = [
  /^（来自对话）/,              // chat 沉淀（CONVERSATION_MEMORY_PREFIX）
  /^关于「[^」]*」：/,          // learn-topic 参考记忆（me.ts：关于「主题」：…）
];

/** 剥除已知来源样板前缀，只保留语义正文——让联想按「真实内容概念」建边，不被样板 token 污染。 */
function stripBoilerplate(content: string): string {
  let text = content;
  for (const re of BOILERPLATE_PREFIXES) text = text.replace(re, '');
  return text;
}

/** 触发建边的最低共享关键词数（<此视为无关，不连边——避免噪声边把无关记忆拉进联想）。
 * 3（原 2）：2 个泛词（如「线程」「状态」）易把 Java 记忆误连到 Rust；要求 3 个共享才连，收紧噪声。 */
const MIN_SHARED_KEYWORDS = 3;
/** 单条新记忆最多连几条边（防一条泛词记忆与全库连边，稀释联想信号 + 控图规模）。 */
const MAX_EDGES_PER_MEMORY = 5;
/** 边强度下限（**重叠系数** <此不连——太弱的关联是噪声）。0.15：杭州相关 0.185 连上、Java↔Rust 0.143 被拒。
 * 必须 = 检索侧 CO_OCCURRENCE_TRAVERSE_MIN——否则建的边落在「建了但检索遍历不到」的死区、联想静默失效。
 * 两处一致性由 deterministic-memory-association.test 断言守护。 */
export const MIN_EDGE_STRENGTH = 0.15;

/** 一条待建联想边。 */
export interface AssociativeEdge {
  readonly targetId: string;
  /** 边强度 [0,1]，= 共享关键词的**重叠系数** shared / min(|A|,|B|)。 */
  readonly strength: number;
}

interface MemoryLike {
  readonly id: string;
  readonly content: string;
}

/**
 * 计算新记忆应与哪些既有记忆连联想边。纯函数、确定性。
 *   - 共享关键词 ≥ MIN_SHARED_KEYWORDS 才连；
 *   - 强度 = overlap(新记忆关键词, 既有记忆关键词) = 共享 / min(|A|,|B|) ≥ MIN_EDGE_STRENGTH；
 *   - 按强度降序、id 字典序二级键，取 top MAX_EDGES_PER_MEMORY（确定性、可复现）。
 * 排除 newId 自身。
 */
export function computeAssociativeEdges(
  newId: string,
  newContent: string,
  existing: readonly MemoryLike[],
): AssociativeEdge[] {
  /* 剥来源样板前缀再分词：让联想按真实语义内容建边，不被「（来自对话）」等共享样板 token 污染。 */
  const newTokens = new Set(tokenize(stripBoilerplate(newContent)));
  if (newTokens.size === 0) return [];

  const candidates: AssociativeEdge[] = [];
  for (const mem of existing) {
    if (mem.id === newId) continue;
    const memTokens = new Set(tokenize(stripBoilerplate(mem.content)));
    if (memTokens.size === 0) continue;

    let shared = 0;
    for (const t of newTokens) if (memTokens.has(t)) shared += 1;
    if (shared < MIN_SHARED_KEYWORDS) continue;

    /* 重叠系数：shared / min(|A|,|B|)——「较短记忆的概念有多少被共享」。用 min 而非并集（Jaccard），
     * 因 CJK n-gram 使长文本 token 数虚高，Jaccard 会把真·相关的长记忆稀释到连不上。 */
    const minSize = Math.min(newTokens.size, memTokens.size);
    const strength = minSize > 0 ? shared / minSize : 0;
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
