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
/** 图遍历邻居相关度衰减系数：沿同一路径每跳 relevance = 上一跳 relevance × 边强度 × 此系数（同路径逐跳衰减）。 */
export const NEIGHBOR_DECAY = 0.8;
/** 图遍历最大跳数：1 = 仅直接命中的 1 跳邻居（默认，向后兼容）；2+ 启用多跳串联。 */
export const MAX_HOPS = 1;

/**
 * 取边器：给定记忆 id 返回与之相连的所有边（无向，source/target 任一端等于 id）。
 * 生产用 tenantOS.core.memories.getEdgesFor；基准/测试可注入内存实现。
 */
export type EdgeLookup = (id: MemoryId) => MemoryEdge[];
/** 取记忆用于匹配/呈现的文本（多语：目标语言变体优先，无则原 content）。缺省 = node.content。 */
export type ContentFor = (node: MemoryNode) => string;

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
  /** 图遍历最大跳数（1 = 仅 1 跳邻居，向后兼容；2+ 多跳串联，每跳复合衰减）。 */
  readonly maxHops: number;
}

export const DEFAULT_RETRIEVAL_PARAMS: RetrievalParams = {
  maxResults: MAX_GROUNDING_MEMORIES,
  minScore: MIN_GROUNDING_SCORE,
  expandSeeds: GRAPH_EXPAND_SEEDS,
  minEdgeStrength: MIN_EDGE_STRENGTH,
  neighborDecay: NEIGHBOR_DECAY,
  maxHops: MAX_HOPS,
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
  contentFor?: ContentFor,
): RelevantKnowledge[] {
  const tokens = tokenize(message);
  if (tokens.length === 0) return [];

  /* 取记忆用于**匹配**的文本（多语：目标语言变体优先，无则原 content）；呈现也用同一文本。
   * 这让英文 query 能命中已翻译成英文的中文记忆，并以英文变体呈现（变体由成长期老师预翻，运行时零-LLM）。 */
  const textOf = (node: MemoryNode): string => contentFor?.(node) ?? node.content;

  /* 直接命中：关键词分 + 连续短语加分（消歧）。relevance 饱和归一化 score/(score+4)。 */
  const direct: RelevantKnowledge[] = [];
  for (const node of memories.values()) {
    const text = textOf(node);
    const score = scoreTextByKeyword(text, tokens) + scorePhraseBonus(text, message);
    if (score < params.minScore) continue;
    direct.push({ id: node.id, title: '', content: text, relevance: score / (score + 4) });
  }
  direct.sort((a, b) => b.relevance - a.relevance || a.id.localeCompare(b.id));

  /* 多跳图遍历扩展（确定性 max-product 松弛）：从前 expandSeeds 条直接命中出发，逐跳沿强边拉语义相邻
   * 记忆。每跳 relevance = 上一跳 relevance × 边强度 × neighborDecay（复合衰减）。同邻居经任意路径到达取
   * **全局最高分**（不论路径长短——强 2 跳可胜过弱 1 跳，Codex 复审采纳）。maxHops=1 即原单跳行为。
   * 纯确定性图遍历——边由蒸馏期老师产，运行期不调任何模型。 */
  const neighborBest = expandGraph(direct, memories, edgesFor, params, textOf);

  /* 合并：直接命中（按 relevance）在前，图遍历邻居（按 relevance，id 稳定 tie-break）在后，截断 top-K。 */
  const neighbors = [...neighborBest.values()].sort((a, b) => b.relevance - a.relevance || a.id.localeCompare(b.id));
  return [...direct, ...neighbors].slice(0, params.maxResults);
}

/**
 * 多跳图遍历扩展（确定性 max-product 松弛纯函数）。从 direct 命中的前 expandSeeds 条出发，逐跳扩展到
 * 未直接命中的语义相邻记忆，返回「邻居 id → **全局最优 relevance** 知识」。
 *
 * 语义：邻居 relevance = 「沿任意 ≤maxHops 跳路径」的最大 (起点 relevance × ∏ 边强度 × neighborDecay^跳数)。
 * 不论路径长短取全局最高——强 2 跳路径可胜过弱 1 跳路径（这是 Dijkstra 式松弛，不是「浅跳锁定」）。
 *
 * 确定性保证（与到达顺序/Map 迭代序无关）：
 *   1. 每波 frontier 显式按 (relevance desc, id asc) 排序后再扩展；
 *   2. 邻居分**只在严格变大时**更新（松弛），故最终值 = 全局最优，与处理顺序无关；
 *   3. 直接命中（directIds）是 relevance 下界、永不被邻居覆盖——它们靠关键词直接命中，语义更强。
 *
 * 收敛性：relevance 每跳乘 (strength × neighborDecay) < 1 严格递减，故任一节点的最优值必来自 ≤maxHops
 * 跳的有限路径；外层固定迭代 maxHops 波，每波只把「本波被改善的节点」推进下一波 → 有界、必收敛、无死循环。
 */
function expandGraph(
  direct: readonly RelevantKnowledge[],
  memories: ReadonlyMap<MemoryId, MemoryNode>,
  edgesFor: EdgeLookup,
  params: RetrievalParams,
  textOf: (node: MemoryNode) => string,
): Map<MemoryId, RelevantKnowledge> {
  const neighborBest = new Map<MemoryId, RelevantKnowledge>();
  /* 直接命中集：它们的 relevance 是关键词命中的强信号，永不被图遍历邻居分覆盖（下界 + 防回头）。 */
  const directIds = new Set(direct.map((d) => d.id));
  /* maxHops 兜底：JS 调用方若传旧形状 params（无 maxHops）→ NaN，Math.max(1,NaN)=NaN 会让循环跳过图扩展。
   * 这里显式把非有限/小于 1 的值归一到 1（向后兼容旧单跳语义），并向下取整防小数跳数。 */
  const hops = Number.isFinite(params.maxHops) ? Math.max(1, Math.floor(params.maxHops)) : 1;

  /* 第 0 波 frontier = 前 expandSeeds 条直接命中（作为多跳起点）。 */
  let frontier: RelevantKnowledge[] = direct.slice(0, params.expandSeeds);

  for (let hop = 0; hop < hops && frontier.length > 0; hop++) {
    /* 显式稳定排序当前波次——确定性的关键（不靠 Map/插入顺序）。 */
    const ordered = [...frontier].sort((a, b) => b.relevance - a.relevance || a.id.localeCompare(b.id));
    /* 本波被改善（分数严格变大）的邻居 → 下一波 frontier。仅改善者推进，保证有界收敛。 */
    const improved = new Map<MemoryId, RelevantKnowledge>();

    for (const seed of ordered) {
      for (const edge of edgesFor(seed.id)) {
        if (edge.strength < params.minEdgeStrength) continue;
        const neighborId = edge.source === seed.id ? edge.target : edge.source;
        if (directIds.has(neighborId)) continue; /* 直接命中不被邻居覆盖（防回头 + 强信号下界） */
        const node = memories.get(neighborId);
        if (!node) continue;
        const relevance = seed.relevance * edge.strength * params.neighborDecay;
        /* 松弛：仅当严格优于已知最优才更新（全局 max，与处理顺序无关）。 */
        const existing = neighborBest.get(neighborId);
        if (!existing || relevance > existing.relevance) {
          const entry: RelevantKnowledge = { id: neighborId, title: '', content: textOf(node), relevance };
          neighborBest.set(neighborId, entry);
          improved.set(neighborId, entry); /* 被改善 → 下一波从它继续松弛（可能发现更强深路径） */
        }
      }
    }

    frontier = [...improved.values()];
  }

  return neighborBest;
}
