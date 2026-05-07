/**
 * Factory for choosing the right EmbeddingIndex implementation.
 *
 * The decision (Postgres-driver branch only — SQLite always uses InMemory):
 *   1. If tenantId is in config.intelligence.vectorExtensionTenants, use
 *      PgvectorEmbeddingIndex regardless of the global flag. This is the
 *      per-tenant ramp lever: explicit opt-in, controlled rollout.
 *   2. Else, use PgvectorEmbeddingIndex iff the global
 *      config.intelligence.useVectorExtension flag is true.
 *   3. Else, fall back to InMemoryEmbeddingIndex.
 *
 * The allowlist takes precedence so an empty global flag + a list of pilot
 * tenants is the natural way to gate-test pgvector before flipping the
 * default for the whole fleet.
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
  const onPostgres = config.db.driver === 'postgres';
  const tenantOptedIn = config.intelligence.vectorExtensionTenants.includes(tenantId);
  const globalFlag = config.intelligence.useVectorExtension === true;
  const usePg = onPostgres && (tenantOptedIn || globalFlag);

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
