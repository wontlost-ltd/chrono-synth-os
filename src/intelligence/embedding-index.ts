/**
 * 向量索引：为记忆节点提供嵌入向量存储和余弦相似度检索
 * 使用内存缓存 + 预计算范数避免 O(N) JSON 反序列化
 * 缓存有 TTL（默认 5 分钟），过期后从 DB 重载
 */

import type { IDatabase } from '../storage/database.js';
import type { Clock } from '../utils/clock.js';
import type { LLMProvider } from './llm-provider.js';

interface EmbeddingRow {
  memory_id: string;
  embedding_json: string;
}

export interface EmbeddingMatch {
  readonly memoryId: string;
  readonly score: number;
}

interface CachedVector {
  readonly vector: Float64Array;
  readonly norm: number;
}

const CACHE_TTL_MS = 5 * 60 * 1000;

/** 预计算向量的 L2 范数 */
function computeNorm(v: Float64Array): number {
  let sum = 0;
  for (let i = 0; i < v.length; i++) sum += v[i] * v[i];
  return Math.sqrt(sum);
}

/** 快速余弦相似度（使用预计算范数） */
function cosineSimilarityFast(a: readonly number[] | Float64Array, aNorm: number, b: Float64Array, bNorm: number): number {
  if (aNorm === 0 || bNorm === 0 || a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot / (aNorm * bNorm);
}

export class EmbeddingIndex {
  /** 内存向量缓存：memoryId → 预计算向量 + 范数 */
  private vectorCache = new Map<string, CachedVector>();
  private cacheLoadedAt = 0;

  constructor(
    private readonly db: IDatabase,
    private readonly clock: Clock,
    private readonly llm: LLMProvider,
    private readonly model: string,
  ) {}

  /** 对单条记忆建立向量索引 */
  async indexMemory(memoryId: string, text: string): Promise<boolean> {
    const embeddings = await this.llm.embed([text]);
    const vector = embeddings[0];
    if (!vector || vector.length === 0) return false;

    /* 先写 DB，成功后再更新缓存 */
    this.db.prepare<void>(
      `INSERT INTO memory_embeddings (memory_id, embedding_json, model, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(memory_id) DO UPDATE SET embedding_json=excluded.embedding_json, model=excluded.model, updated_at=excluded.updated_at`,
    ).run(memoryId, JSON.stringify(vector), this.model, this.clock.now());

    const typed = Float64Array.from(vector);
    const norm = computeNorm(typed);
    if (norm > 0) {
      this.vectorCache.set(memoryId, { vector: typed, norm });
    }
    return true;
  }

  /** 从 DB 加载全部向量到缓存（TTL 过期时刷新） */
  private refreshCache(): void {
    const now = Date.now();
    if (this.cacheLoadedAt > 0 && now - this.cacheLoadedAt < CACHE_TTL_MS) return;

    const rows = this.db.prepare<EmbeddingRow>(
      'SELECT memory_id, embedding_json FROM memory_embeddings WHERE model = ?',
    ).all(this.model);

    const newCache = new Map<string, CachedVector>();
    for (const row of rows) {
      try {
        const arr = JSON.parse(row.embedding_json) as number[];
        const typed = Float64Array.from(arr);
        const norm = computeNorm(typed);
        if (norm > 0) {
          newCache.set(row.memory_id, { vector: typed, norm });
        }
      } catch { /* 跳过损坏的向量 */ }
    }
    this.vectorCache = newCache;
    this.cacheLoadedAt = now;
  }

  /** 向量检索（余弦相似度排序，返回 topK 个最相似结果） */
  search(queryEmbedding: readonly number[], topK: number): EmbeddingMatch[] {
    if (queryEmbedding.length === 0) return [];
    this.refreshCache();

    /* 预计算查询向量范数 */
    let queryNorm = 0;
    for (let i = 0; i < queryEmbedding.length; i++) queryNorm += queryEmbedding[i] * queryEmbedding[i];
    queryNorm = Math.sqrt(queryNorm);
    if (queryNorm === 0) return [];

    const k = Math.max(1, topK);

    /* 维护一个大小为 K 的最小堆（按 score 升序），保留 topK 最大 */
    const heap: EmbeddingMatch[] = [];

    for (const [memoryId, cached] of this.vectorCache) {
      const score = cosineSimilarityFast(queryEmbedding, queryNorm, cached.vector, cached.norm);
      if (!Number.isFinite(score)) continue;

      if (heap.length < k) {
        heap.push({ memoryId, score });
        if (heap.length === k) heap.sort((a, b) => a.score - b.score);
      } else if (score > heap[0].score) {
        heap[0] = { memoryId, score };
        heap.sort((a, b) => a.score - b.score);
      }
    }

    return heap.sort((a, b) => b.score - a.score);
  }

  /** 缓存大小（用于监控） */
  get cacheSize(): number {
    return this.vectorCache.size;
  }
}
