/**
 * Postgres + pgvector implementation of EmbeddingIndex.
 *
 * Pushes both the upsert and the nearest-neighbour search into Postgres
 * via the kernel's pgvector query types. Storage is the
 * memory_embeddings.embedding column (vector(1536)) introduced in v071.
 *
 * Compared to InMemoryEmbeddingIndex:
 *   - No per-process state (no LRU cache, no IVF rebuild). The HNSW index
 *     lives on disk in Postgres and is shared by every replica.
 *   - cacheSize / partitionCount return 0 — instances are stateless and
 *     they don't track row counts locally.
 *   - Failure modes shift: an empty/short result set may indicate an
 *     unindexed tenant rather than "nothing similar". Callers should
 *     not assume topK results are always returned.
 */

import type { SyncWriteUnitOfWork } from '@chrono/kernel';
import { embCmdUpsertPg, embQueryNearestPg } from '@chrono/kernel';
import type { IDatabase } from '../storage/database.js';
import { registerCoreSelfExecutors } from '../storage/executors/index.js';
import type { Clock } from '../utils/clock.js';
import type { LLMProvider } from './llm-provider.js';
import type { EmbeddingIndex, EmbeddingMatch } from './embedding-index.js';

export class PgvectorEmbeddingIndex implements EmbeddingIndex {
  private readonly tx: SyncWriteUnitOfWork;

  constructor(
    db: IDatabase,
    private readonly tenantId: string,
    private readonly clock: Clock,
    private readonly llm: LLMProvider,
    private readonly model: string,
    private readonly dims: number,
  ) {
    registerCoreSelfExecutors();
    this.tx = db;
  }

  async indexMemory(memoryId: string, text: string): Promise<boolean> {
    const embeddings = await this.llm.embed([text]);
    const vector = embeddings[0];
    if (!vector || vector.length === 0) return false;
    if (vector.length !== this.dims) return false;

    this.tx.execute(embCmdUpsertPg({
      tenantId: this.tenantId,
      memoryId,
      model: this.model,
      dims: this.dims,
      vector,
      updatedAt: this.clock.now(),
    }));
    return true;
  }

  search(queryEmbedding: readonly number[], topK: number): EmbeddingMatch[] {
    if (queryEmbedding.length === 0) return [];
    if (queryEmbedding.length !== this.dims) return [];

    const k = Math.max(1, topK);
    const rows = this.tx.queryMany(embQueryNearestPg({
      tenantId: this.tenantId,
      model: this.model,
      queryVector: queryEmbedding,
      k,
    }));

    /* pgvector's <=> returns cosine distance (0 = identical, 2 = opposite).
     * EmbeddingMatch.score follows the in-memory convention of cosine
     * similarity in [-1, 1], so we invert: similarity = 1 - distance. */
    return rows.map(r => ({
      memoryId: r.memory_id,
      score: 1 - r.distance,
    }));
  }

  /** Always 0 — pgvector keeps the index in Postgres, not in this process. */
  get cacheSize(): number {
    return 0;
  }

  /** Always 0 — partitions are an InMemoryEmbeddingIndex (IVF) concept. */
  get partitionCount(): number {
    return 0;
  }
}
