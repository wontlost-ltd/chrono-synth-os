/**
 * Factory for choosing the right EmbeddingIndex implementation.
 *
 * The decision: Postgres + pgvector when both
 *   (a) the runtime database is Postgres (driver = 'postgres'), AND
 *   (b) config.intelligence.useVectorExtension is true.
 * Otherwise the in-memory + JSON path is used (the legacy default).
 *
 * Tests usually want a specific implementation. Construct the impl class
 * directly (InMemoryEmbeddingIndex / PgvectorEmbeddingIndex) for those —
 * the factory exists for production wiring only.
 */

import type { AppConfig } from '../config/schema.js';
import type { IDatabase } from '../storage/database.js';
import type { Clock } from '../utils/clock.js';
import type { LLMProvider } from './llm-provider.js';
import type { EmbeddingIndex } from './embedding-index.js';
import { InMemoryEmbeddingIndex } from './embedding-index-memory.js';
import { PgvectorEmbeddingIndex } from './embedding-index-pgvector.js';

export interface CreateEmbeddingIndexOptions {
  /** Tenant scope; required for the pgvector path's WHERE filter. */
  tenantId: string;
  db: IDatabase;
  clock: Clock;
  llm: LLMProvider;
  config: AppConfig;
  /** Override the in-memory cache cap; ignored by the pgvector path. */
  maxCacheSize?: number;
}

export function createEmbeddingIndex(opts: CreateEmbeddingIndexOptions): EmbeddingIndex {
  const { tenantId, db, clock, llm, config, maxCacheSize } = opts;
  const usePg = config.db.driver === 'postgres'
    && config.intelligence.useVectorExtension === true;

  if (usePg) {
    return new PgvectorEmbeddingIndex(
      db,
      tenantId,
      clock,
      llm,
      config.intelligence.embeddingModel,
      config.intelligence.embeddingDims,
    );
  }

  return new InMemoryEmbeddingIndex(
    db,
    clock,
    llm,
    config.intelligence.embeddingModel,
    maxCacheSize,
  );
}
