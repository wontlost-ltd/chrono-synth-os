/**
 * 向量索引：为记忆节点提供嵌入向量存储和余弦相似度检索
 * 使用内存缓存 + 预计算范数 + IVF 分区索引避免 O(N) 全量扫描
 * 缓存有 TTL（默认 5 分钟），过期后从 DB 重载
 *
 * IVF 策略：将向量按质心分区（nPartitions），检索时仅扫描 nProbe 个最近分区
 * 当向量数 < IVF_THRESHOLD 时退化为暴力搜索
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

/** IVF 分区（一组向量共享一个质心） */
interface IVFPartition {
  centroid: Float64Array;
  centroidNorm: number;
  entries: Array<{ memoryId: string; vector: Float64Array; norm: number }>;
}

const CACHE_TTL_MS = 5 * 60 * 1000;
/** 超过此数量才启用 IVF 分区（小数据集暴力搜索更快） */
const IVF_THRESHOLD = 256;
/** 分区数 = sqrt(N)，上限 64 */
const MAX_PARTITIONS = 64;
/** 默认探测分区数 */
const DEFAULT_NPROBE = 4;

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

/** 随机选取 k 个不同索引 */
function sampleIndices(total: number, k: number): number[] {
  const indices = new Set<number>();
  while (indices.size < k) {
    indices.add(Math.floor(Math.random() * total));
  }
  return [...indices];
}

/** 向量加法（a += b） */
function vectorAdd(a: Float64Array, b: Float64Array): void {
  for (let i = 0; i < a.length; i++) a[i] += b[i];
}

/** 向量除以标量 */
function vectorScale(a: Float64Array, s: number): void {
  for (let i = 0; i < a.length; i++) a[i] /= s;
}

export class EmbeddingIndex {
  /** 内存向量缓存：memoryId → 预计算向量 + 范数 */
  private vectorCache = new Map<string, CachedVector>();
  private cacheLoadedAt = 0;
  /** IVF 分区索引（仅当向量数 >= IVF_THRESHOLD 时构建） */
  private partitions: IVFPartition[] = [];
  private ivfBuilt = false;

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
      /* 新向量使 IVF 索引失效，下次检索时重建 */
      this.ivfBuilt = false;
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
    this.ivfBuilt = false;
  }

  /** 构建 IVF 分区索引（简化 K-Means，3 轮迭代） */
  private buildIVF(): void {
    const entries = [...this.vectorCache.entries()].map(([id, c]) => ({
      memoryId: id, vector: c.vector, norm: c.norm,
    }));

    if (entries.length < IVF_THRESHOLD) {
      this.partitions = [];
      this.ivfBuilt = true;
      return;
    }

    const dim = entries[0].vector.length;
    const nPartitions = Math.min(MAX_PARTITIONS, Math.ceil(Math.sqrt(entries.length)));

    /* 初始化质心（随机选取） */
    const seedIdx = sampleIndices(entries.length, nPartitions);
    const centroids = seedIdx.map(i => Float64Array.from(entries[i].vector));

    /* 3 轮 K-Means 迭代 */
    let assignments = new Int32Array(entries.length);
    for (let iter = 0; iter < 3; iter++) {
      /* 分配阶段 */
      for (let i = 0; i < entries.length; i++) {
        let bestSim = -Infinity;
        let bestIdx = 0;
        const eNorm = entries[i].norm;
        for (let c = 0; c < centroids.length; c++) {
          const cNorm = computeNorm(centroids[c]);
          const sim = cosineSimilarityFast(entries[i].vector, eNorm, centroids[c], cNorm);
          if (sim > bestSim) { bestSim = sim; bestIdx = c; }
        }
        assignments[i] = bestIdx;
      }
      /* 更新质心 */
      const counts = new Int32Array(nPartitions);
      const sums = centroids.map(() => new Float64Array(dim));
      for (let i = 0; i < entries.length; i++) {
        const c = assignments[i];
        counts[c]++;
        vectorAdd(sums[c], entries[i].vector);
      }
      for (let c = 0; c < nPartitions; c++) {
        if (counts[c] > 0) {
          vectorScale(sums[c], counts[c]);
          centroids[c] = sums[c];
        }
      }
    }

    /* 构建分区 */
    this.partitions = centroids.map(c => ({
      centroid: c,
      centroidNorm: computeNorm(c),
      entries: [],
    }));
    for (let i = 0; i < entries.length; i++) {
      this.partitions[assignments[i]].entries.push(entries[i]);
    }

    this.ivfBuilt = true;
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

    /* 当向量数 >= IVF_THRESHOLD 时使用分区索引 */
    if (this.vectorCache.size >= IVF_THRESHOLD) {
      if (!this.ivfBuilt) this.buildIVF();
      if (this.partitions.length > 0) {
        return this.searchIVF(queryEmbedding, queryNorm, k);
      }
    }

    /* 暴力搜索（小数据集或 IVF 未就绪） */
    return this.searchBrute(queryEmbedding, queryNorm, k);
  }

  /** 暴力搜索所有向量 */
  private searchBrute(queryEmbedding: readonly number[], queryNorm: number, k: number): EmbeddingMatch[] {
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

  /** IVF 分区检索：仅扫描最近的 nProbe 个分区 */
  private searchIVF(queryEmbedding: readonly number[], queryNorm: number, k: number): EmbeddingMatch[] {
    const nProbe = Math.min(DEFAULT_NPROBE, this.partitions.length);

    /* 找到与查询最接近的 nProbe 个分区 */
    const partitionScores = this.partitions.map((p, idx) => ({
      idx,
      sim: cosineSimilarityFast(queryEmbedding, queryNorm, p.centroid, p.centroidNorm),
    }));
    partitionScores.sort((a, b) => b.sim - a.sim);

    const heap: EmbeddingMatch[] = [];

    for (let pi = 0; pi < nProbe; pi++) {
      const partition = this.partitions[partitionScores[pi].idx];
      for (const entry of partition.entries) {
        const score = cosineSimilarityFast(queryEmbedding, queryNorm, entry.vector, entry.norm);
        if (!Number.isFinite(score)) continue;

        if (heap.length < k) {
          heap.push({ memoryId: entry.memoryId, score });
          if (heap.length === k) heap.sort((a, b) => a.score - b.score);
        } else if (score > heap[0].score) {
          heap[0] = { memoryId: entry.memoryId, score };
          heap.sort((a, b) => a.score - b.score);
        }
      }
    }

    return heap.sort((a, b) => b.score - a.score);
  }

  /** 缓存大小（用于监控） */
  get cacheSize(): number {
    return this.vectorCache.size;
  }

  /** 分区数（用于监控） */
  get partitionCount(): number {
    return this.partitions.length;
  }
}
