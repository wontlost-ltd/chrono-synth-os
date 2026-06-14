/**
 * 对话知识检索器（P1-C 生产级混合检索）
 *
 * 检索策略（按性价比排序）：
 *   1. 关键词层：bigram/trigram CJK + latin token 匹配（O(n) 一遍 SQL 全量扫，n < 1k 可接受）
 *   2. 语义层（注入 EmbeddingProvider 时启用）：
 *      - 查询向量 ←= provider.embed([userInput])
 *      - 每条候选实时 embed 后做 cosine（仅前 50 个关键词候选，控制成本）
 *      - score = 0.4 * 关键词分 + 0.6 * 语义分
 *
 * 缓存：知识条目向量按 (id, content_hash) 缓存到内存 LRU（构造时可注入持久层）。
 * Provider 调用失败时静默降级到纯关键词层。
 */

import { createHash } from 'node:crypto';
import type { SyncWriteUnitOfWork } from '@chrono/kernel';
import { krtvQueryByPersona } from '@chrono/kernel';
import { registerCoreSelfExecutors } from '../storage/executors/index.js';
import type { Logger } from '../utils/logger.js';
import type { RelevantKnowledge } from './conversation-types.js';

interface KnowledgeRow {
  id: string;
  title: string;
  content: string;
  confidence: number;
  fingerprint: string | null;
}

const STOPWORDS = new Set([
  '的', '了', '在', '是', '我', '有', '和', '就', '不', '人', '都', '一', '一个', '上', '也', '很', '到', '说', '要', '去', '你', '会', '着', '没有', '看', '好', '自己', '这', '那', '什么', '怎么', '吗', '呢', '吧',
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did', 'i', 'you', 'we', 'they', 'he', 'she', 'it', 'this', 'that', 'these', 'those', 'and', 'or', 'but', 'if', 'then', 'else', 'how', 'what', 'when', 'where', 'why', 'who', 'to', 'of', 'in', 'on', 'at', 'by', 'for', 'with', 'about', 'as',
]);

const MIN_TOKEN_LENGTH = 2;
const MAX_TOKEN_COUNT = 32;
const SEMANTIC_CANDIDATE_LIMIT = 50;
const KEYWORD_WEIGHT = 0.4;
const SEMANTIC_WEIGHT = 0.6;

export interface EmbeddingProvider {
  embed(texts: readonly string[]): Promise<number[][]>;
}

export interface RetrieverOptions {
  embeddingProvider?: EmbeddingProvider;
  logger?: Logger;
  /** 测试钩子：跳过实际 embedding 调用（内部用 deterministic fake） */
  fakeEmbedding?: (text: string) => number[];
}

export class ConversationKnowledgeRetriever {
  /* 简单 LRU：fingerprint → embedding；命中跳过 provider 调用 */
  private readonly embeddingCache = new Map<string, number[]>();
  private readonly cacheCap = 1024;

  constructor(
    private readonly tx: SyncWriteUnitOfWork,
    private readonly options: RetrieverOptions = {},
  ) {
    registerCoreSelfExecutors();
  }

  async retrieve(input: {
    tenantId: string;
    personaId: string;
    userInput: string;
    topK: number;
  }): Promise<RelevantKnowledge[]> {
    const tokens = tokenize(input.userInput);
    if (tokens.length === 0) return [];

    const rows = this.tx.queryMany(krtvQueryByPersona({
      tenantId: input.tenantId, personaId: input.personaId,
    }));
    if (rows.length === 0) return [];

    /* Step 1: 关键词层全量打分 */
    const keywordScored = rows
      .map((row) => ({ row, keywordScore: scoreByKeyword(row, tokens) }))
      .filter((s) => s.keywordScore > 0)
      .sort((a, b) => b.keywordScore - a.keywordScore);

    if (keywordScored.length === 0) return [];

    /* Step 2: 语义层 —— 仅对 top SEMANTIC_CANDIDATE_LIMIT 候选做 embedding */
    const candidates = keywordScored.slice(0, SEMANTIC_CANDIDATE_LIMIT);
    if (this.options.embeddingProvider || this.options.fakeEmbedding) {
      try {
        const semanticScores = await this.computeSemanticScores(input.userInput, candidates);
        for (let i = 0; i < candidates.length; i++) {
          const sem = semanticScores[i];
          if (sem !== undefined) {
            const blended = KEYWORD_WEIGHT * normalizeKeywordScore(candidates[i].keywordScore, tokens.length) + SEMANTIC_WEIGHT * sem;
            (candidates[i] as { combinedScore?: number }).combinedScore = blended;
          }
        }
      } catch (err) {
        this.options.logger?.warn(
          'ConversationKnowledgeRetriever',
          `语义检索失败，降级到纯关键词: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    /* 输出排序：有 combinedScore 的优先按 combinedScore，否则按归一化关键词分 */
    return candidates
      .map((c) => ({
        c,
        finalScore: (c as { combinedScore?: number }).combinedScore ?? normalizeKeywordScore(c.keywordScore, tokens.length),
      }))
      .sort((a, b) => b.finalScore - a.finalScore)
      .slice(0, Math.max(1, input.topK))
      .map(({ c, finalScore }) => ({
        id: c.row.id,
        title: c.row.title,
        content: c.row.content,
        relevance: clamp01(finalScore),
      }));
  }

  private async computeSemanticScores(
    userInput: string,
    candidates: Array<{ row: KnowledgeRow }>,
  ): Promise<number[]> {
    const provider = this.options.embeddingProvider;
    const fake = this.options.fakeEmbedding;
    if (!provider && !fake) return [];

    const queryEmb = fake ? fake(userInput) : (await provider!.embed([userInput]))[0];
    if (!queryEmb || queryEmb.length === 0) return [];

    /* 区分已缓存与未缓存 */
    const missingIdx: number[] = [];
    const missingTexts: string[] = [];
    const cached: Array<number[] | null> = candidates.map(({ row }) => {
      const key = cacheKey(row);
      if (this.embeddingCache.has(key)) {
        const v = this.embeddingCache.get(key)!;
        /* 触摸 LRU */
        this.embeddingCache.delete(key);
        this.embeddingCache.set(key, v);
        return v;
      }
      return null;
    });

    candidates.forEach((c, i) => {
      if (cached[i] === null) {
        missingIdx.push(i);
        missingTexts.push(`${c.row.title}\n${c.row.content.slice(0, 2000)}`);
      }
    });

    if (missingTexts.length > 0) {
      const newEmbs = fake
        ? missingTexts.map(fake)
        : await provider!.embed(missingTexts);
      missingIdx.forEach((idx, i) => {
        const emb = newEmbs[i];
        if (emb && emb.length === queryEmb.length) {
          cached[idx] = emb;
          const key = cacheKey(candidates[idx].row);
          this.embeddingCache.set(key, emb);
          this.evictIfNeeded();
        }
      });
    }

    return cached.map((emb) => (emb ? cosine(queryEmb, emb) : 0));
  }

  private evictIfNeeded(): void {
    while (this.embeddingCache.size > this.cacheCap) {
      const oldest = this.embeddingCache.keys().next().value;
      if (!oldest) break;
      this.embeddingCache.delete(oldest);
    }
  }
}

/**
 * 确定性分词（latin 词 + CJK 2/3-gram，去停用词）。导出供 companion 零-LLM 对话复用同一分词质量。
 */
export function tokenize(text: string): string[] {
  const lower = text.toLowerCase();
  const tokens = new Set<string>();
  const latinMatches = lower.match(/[a-z0-9¥$€£%]+/g) ?? [];
  for (const m of latinMatches) {
    if (m.length >= MIN_TOKEN_LENGTH && !STOPWORDS.has(m)) tokens.add(m);
  }
  const cjkMatches = lower.match(/[一-鿿]+/g) ?? [];
  for (const segment of cjkMatches) {
    for (let n = 2; n <= 3; n++) {
      for (let i = 0; i + n <= segment.length; i++) {
        const gram = segment.slice(i, i + n);
        if (!STOPWORDS.has(gram)) tokens.add(gram);
      }
    }
  }
  return [...tokens].slice(0, MAX_TOKEN_COUNT);
}

/** 文本 × tokens 的确定性关键词分（长词权重更高）。导出供 companion 复用同一打分口径。 */
export function scoreTextByKeyword(haystack: string, tokens: string[]): number {
  const hay = haystack.toLowerCase();
  let score = 0;
  for (const t of tokens) {
    if (hay.includes(t)) score += t.length >= 4 ? 2 : 1;
  }
  return score;
}

function scoreByKeyword(row: KnowledgeRow, tokens: string[]): number {
  return scoreTextByKeyword(`${row.title}\n${row.content}`, tokens) * (0.5 + 0.5 * row.confidence);
}

function normalizeKeywordScore(score: number, tokenCount: number): number {
  if (tokenCount === 0) return 0;
  return clamp01(score / (tokenCount * 2));
}

function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function cacheKey(row: KnowledgeRow): string {
  if (row.fingerprint) return `fp:${row.fingerprint}`;
  return `id:${row.id}:${createHash('sha256').update(row.content, 'utf8').digest('hex').slice(0, 16)}`;
}

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}
