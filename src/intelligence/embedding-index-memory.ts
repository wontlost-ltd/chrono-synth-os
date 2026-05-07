/**
 * In-memory + LRU + IVF embedding index. Backed by memory_embeddings.embedding_json
 * (TEXT). Cosine similarity is computed in JS; a small K-Means-built IVF index
 * kicks in past 256 vectors to avoid O(N) scans.
 *
 * This was the only implementation pre-pgvector. It remains the production path
 * for SQLite deployments and for Postgres deployments that haven't enabled the
 * pgvector extension yet.
 */

import type { SyncWriteUnitOfWork } from '@chrono/kernel';
import {
  embCmdUpsert, embQueryByModel,
  ivfCmdUpsert, ivfQueryByModel, ivfQueryMetaByModel,
} from '@chrono/kernel';
import type { IDatabase } from '../storage/database.js';
import { registerCoreSelfExecutors } from '../storage/executors/index.js';
import type { Clock } from '../utils/clock.js';
import type { LLMProvider } from './llm-provider.js';
import type { EmbeddingIndex, EmbeddingMatch } from './embedding-index.js';

interface CachedVector {
  readonly vector: Float64Array;
  readonly norm: number;
}

/** IVF partition: a group of vectors sharing a centroid. */
interface IVFPartition {
  centroid: Float64Array;
  centroidNorm: number;
  entries: Array<{ memoryId: string; vector: Float64Array; norm: number }>;
}

const CACHE_TTL_MS = 5 * 60 * 1000;
const IVF_THRESHOLD = 256;
const MAX_PARTITIONS = 64;
const DEFAULT_NPROBE = 4;
const DEFAULT_MAX_CACHE_SIZE = 50_000;

function computeNorm(v: Float64Array): number {
  let sum = 0;
  for (let i = 0; i < v.length; i++) sum += v[i] * v[i];
  return Math.sqrt(sum);
}

function cosineSimilarityFast(a: readonly number[] | Float64Array, aNorm: number, b: Float64Array, bNorm: number): number {
  if (aNorm === 0 || bNorm === 0 || a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot / (aNorm * bNorm);
}

function sampleIndices(total: number, k: number): number[] {
  const indices = new Set<number>();
  while (indices.size < k) {
    indices.add(Math.floor(Math.random() * total));
  }
  return [...indices];
}

function vectorAdd(a: Float64Array, b: Float64Array): void {
  for (let i = 0; i < a.length; i++) a[i] += b[i];
}

function vectorScale(a: Float64Array, s: number): void {
  for (let i = 0; i < a.length; i++) a[i] /= s;
}

export class InMemoryEmbeddingIndex implements EmbeddingIndex {
  private vectorCache = new Map<string, CachedVector>();
  private accessOrder = new Map<string, number>();
  private cacheLoadedAt = 0;
  private partitions: IVFPartition[] = [];
  private ivfBuilt = false;
  private readonly maxCacheSize: number;
  private readonly tx: SyncWriteUnitOfWork;

  constructor(
    db: IDatabase,
    private readonly clock: Clock,
    private readonly llm: LLMProvider,
    private readonly model: string,
    maxCacheSize?: number,
  ) {
    this.maxCacheSize = maxCacheSize ?? DEFAULT_MAX_CACHE_SIZE;
    registerCoreSelfExecutors();
    this.tx = db;
  }

  private evictIfNeeded(): void {
    const overflow = this.vectorCache.size - this.maxCacheSize;
    if (overflow <= 0) return;

    const victims: Array<[string, number]> = [];
    let maxInVictims = -Infinity;
    for (const entry of this.accessOrder) {
      if (victims.length < overflow) {
        victims.push(entry);
        if (entry[1] > maxInVictims) maxInVictims = entry[1];
      } else if (entry[1] < maxInVictims) {
        let maxIdx = 0;
        for (let i = 1; i < victims.length; i++) {
          if (victims[i][1] > victims[maxIdx][1]) maxIdx = i;
        }
        victims[maxIdx] = entry;
        maxInVictims = -Infinity;
        for (const v of victims) { if (v[1] > maxInVictims) maxInVictims = v[1]; }
      }
    }

    for (const [key] of victims) {
      this.vectorCache.delete(key);
      this.accessOrder.delete(key);
    }
    this.ivfBuilt = false;
  }

  async indexMemory(memoryId: string, text: string): Promise<boolean> {
    const embeddings = await this.llm.embed([text]);
    const vector = embeddings[0];
    if (!vector || vector.length === 0) return false;

    /* Persist to DB first; only then update the cache. */
    this.tx.execute(embCmdUpsert({
      memoryId, embeddingJson: JSON.stringify(vector), model: this.model, updatedAt: this.clock.now(),
    }));

    const typed = Float64Array.from(vector);
    const norm = computeNorm(typed);
    if (norm > 0) {
      this.vectorCache.set(memoryId, { vector: typed, norm });
      this.accessOrder.set(memoryId, Date.now());
      this.evictIfNeeded();
      this.ivfBuilt = false;
    }
    return true;
  }

  private refreshCache(): void {
    const now = Date.now();
    if (this.cacheLoadedAt > 0 && now - this.cacheLoadedAt < CACHE_TTL_MS) return;

    const rows = this.tx.queryMany(embQueryByModel({ model: this.model }));

    const newCache = new Map<string, CachedVector>();
    for (const row of rows) {
      try {
        const arr = JSON.parse(row.embedding_json) as number[];
        const typed = Float64Array.from(arr);
        const norm = computeNorm(typed);
        if (norm > 0) {
          newCache.set(row.memory_id, { vector: typed, norm });
        }
      } catch { /* skip corrupted vectors */ }
    }
    this.vectorCache = newCache;
    this.accessOrder = new Map([...newCache.keys()].map(k => [k, now]));
    this.cacheLoadedAt = now;
    this.evictIfNeeded();
    this.ivfBuilt = false;
  }

  private loadPersistedCentroids(): Float64Array[] | null {
    try {
      const row = this.tx.queryOne(ivfQueryByModel({ model: this.model }));
      if (!row) return null;
      const parsed = JSON.parse(row.centroids_json) as number[][];
      return parsed.map(arr => Float64Array.from(arr));
    } catch { return null; }
  }

  private loadPersistedMeta(): { numVectors: number; builtAt: number } | null {
    try {
      const row = this.tx.queryOne(ivfQueryMetaByModel({ model: this.model }));
      return row ? { numVectors: row.num_vectors, builtAt: row.built_at } : null;
    } catch { return null; }
  }

  private persistCentroids(centroids: Float64Array[]): void {
    try {
      this.tx.execute(ivfCmdUpsert({
        model: this.model,
        centroidsJson: JSON.stringify(centroids.map(c => Array.from(c))),
        numVectors: this.vectorCache.size,
        builtAt: Date.now(),
      }));
    } catch { /* best-effort persistence; failure must not block search */ }
  }

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

    const IVF_MAX_AGE_MS = 24 * 60 * 60 * 1000;
    let centroids: Float64Array[];
    const persisted = this.loadPersistedCentroids();
    const persistedMeta = this.loadPersistedMeta();
    const centroidsValid = persisted
      && persisted.length === nPartitions
      && persisted[0].length === dim
      && persistedMeta !== null
      && Math.abs(persistedMeta.numVectors - entries.length) / Math.max(persistedMeta.numVectors, 1) < 0.5
      && (Date.now() - persistedMeta.builtAt) < IVF_MAX_AGE_MS;
    if (centroidsValid && persisted) {
      centroids = persisted;
    } else {
      const seedIdx = sampleIndices(entries.length, nPartitions);
      centroids = seedIdx.map(i => Float64Array.from(entries[i].vector));

      for (let iter = 0; iter < 3; iter++) {
        const assignments = new Int32Array(entries.length);
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

      this.persistCentroids(centroids);
    }

    const finalAssignments = new Int32Array(entries.length);
    for (let i = 0; i < entries.length; i++) {
      let bestSim = -Infinity;
      let bestIdx = 0;
      const eNorm = entries[i].norm;
      for (let c = 0; c < centroids.length; c++) {
        const cNorm = computeNorm(centroids[c]);
        const sim = cosineSimilarityFast(entries[i].vector, eNorm, centroids[c], cNorm);
        if (sim > bestSim) { bestSim = sim; bestIdx = c; }
      }
      finalAssignments[i] = bestIdx;
    }

    this.partitions = centroids.map(c => ({
      centroid: c,
      centroidNorm: computeNorm(c),
      entries: [],
    }));
    for (let i = 0; i < entries.length; i++) {
      this.partitions[finalAssignments[i]].entries.push(entries[i]);
    }

    this.ivfBuilt = true;
  }

  private touchResults(results: EmbeddingMatch[]): void {
    const now = Date.now();
    for (const r of results) this.accessOrder.set(r.memoryId, now);
  }

  search(queryEmbedding: readonly number[], topK: number): EmbeddingMatch[] {
    if (queryEmbedding.length === 0) return [];
    this.refreshCache();

    let queryNorm = 0;
    for (let i = 0; i < queryEmbedding.length; i++) queryNorm += queryEmbedding[i] * queryEmbedding[i];
    queryNorm = Math.sqrt(queryNorm);
    if (queryNorm === 0) return [];

    const k = Math.max(1, topK);

    let results: EmbeddingMatch[];
    if (this.vectorCache.size >= IVF_THRESHOLD) {
      if (!this.ivfBuilt) this.buildIVF();
      if (this.partitions.length > 0) {
        results = this.searchIVF(queryEmbedding, queryNorm, k);
      } else {
        results = this.searchBrute(queryEmbedding, queryNorm, k);
      }
    } else {
      results = this.searchBrute(queryEmbedding, queryNorm, k);
    }
    this.touchResults(results);
    return results;
  }

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

  private searchIVF(queryEmbedding: readonly number[], queryNorm: number, k: number): EmbeddingMatch[] {
    const nProbe = Math.min(DEFAULT_NPROBE, this.partitions.length);

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

  get cacheSize(): number {
    return this.vectorCache.size;
  }

  get partitionCount(): number {
    return this.partitions.length;
  }
}
