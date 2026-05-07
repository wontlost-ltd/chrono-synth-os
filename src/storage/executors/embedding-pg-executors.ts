/**
 * pgvector-specific SQL executors. Only invoked when the runtime sits on
 * Postgres with the `vector` extension installed and the application's
 * config.intelligence.useVectorExtension flag is on. SQLite deployments
 * pick InMemoryEmbeddingIndex and never reach this code.
 *
 * Wire format: pgvector accepts vectors as a text literal '[1.2,3.4,...]'
 * cast to vector. We build that string in JS to keep the SQL parameter list
 * a flat $1..$N — pgvector arrays are cast inline because pg-node's bind
 * protocol doesn't have a native vector binary form.
 */

import { registerQuery, registerCommand } from '../legacy-sync-bridge.js';
import {
  EMB_CMD_UPSERT_PG, EMB_QUERY_NEAREST_PG,
} from '@chrono/kernel';
import type {
  EmbUpsertPgParams, EmbNearestPgParams, EmbNearestPgRow,
} from '@chrono/kernel';

/* Serialize a JS number array into pgvector's textual form: '[1,2,3]'. */
function toPgVector(v: readonly number[]): string {
  return '[' + v.join(',') + ']';
}

export function registerEmbeddingPgExecutors(): void {
  registerCommand<EmbUpsertPgParams>(EMB_CMD_UPSERT_PG, (db, p) => {
    const vectorText = toPgVector(p.vector);

    /* Dual-write: keep embedding_json in step with the new vector column.
     * Stage 7 of the pgvector plan drops the JSON column once production
     * traffic stabilises on the vector path; until then the rollback
     * window relies on having both representations available. */
    const result = db.prepare<void>(
      `INSERT INTO memory_embeddings (
         memory_id, tenant_id, embedding_json, model, updated_at,
         embedding, embedding_model, embedding_dims
       )
       VALUES (?, ?, ?, ?, ?, ?::vector, ?, ?)
       ON CONFLICT (memory_id) DO UPDATE SET
         embedding_json   = excluded.embedding_json,
         model            = excluded.model,
         updated_at       = excluded.updated_at,
         embedding        = excluded.embedding,
         embedding_model  = excluded.embedding_model,
         embedding_dims   = excluded.embedding_dims`,
    ).run(
      p.memoryId,
      p.tenantId,
      JSON.stringify(p.vector),
      p.model,
      p.updatedAt,
      vectorText,
      p.model,
      p.dims,
    );
    return { rowsAffected: result.changes };
  });

  registerQuery<readonly EmbNearestPgRow[], EmbNearestPgParams>(EMB_QUERY_NEAREST_PG, (db, p) => {
    const queryText = toPgVector(p.queryVector);

    /* Cosine distance = 1 - cosine_similarity. pgvector's `<=>` operator
     * IS cosine distance directly; smaller means more similar. The HNSW
     * index on embedding USING hnsw (... vector_cosine_ops) is what makes
     * the ORDER BY on this operator scale to large tables. */
    const baseSql =
      `SELECT memory_id, (embedding <=> ?::vector) AS distance
       FROM memory_embeddings
       WHERE tenant_id = ?
         AND embedding_model = ?
         AND embedding IS NOT NULL`;

    if (p.maxDistance !== undefined) {
      return db.prepare<EmbNearestPgRow>(
        `${baseSql}
         AND (embedding <=> ?::vector) <= ?
         ORDER BY embedding <=> ?::vector
         LIMIT ?`,
      ).all(
        queryText,
        p.tenantId,
        p.model,
        queryText,
        p.maxDistance,
        queryText,
        p.k,
      );
    }

    return db.prepare<EmbNearestPgRow>(
      `${baseSql}
       ORDER BY embedding <=> ?::vector
       LIMIT ?`,
    ).all(
      queryText,
      p.tenantId,
      p.model,
      queryText,
      p.k,
    );
  });
}
