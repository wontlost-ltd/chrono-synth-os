/**
 * 向量嵌入索引 SQL 执行器
 */

import { registerQuery, registerCommand } from '../legacy-sync-bridge.js';
import {
  EMB_CMD_UPSERT, IVF_CMD_UPSERT,
  EMB_QUERY_BY_MODEL, IVF_QUERY_BY_MODEL, IVF_QUERY_META_BY_MODEL,
} from '@chrono/kernel';
import type {
  EmbeddingRow, IvfCentroidsRow, IvfMetaRow,
  EmbUpsertParams, EmbByModelParams, IvfUpsertParams,
} from '@chrono/kernel';

export function registerEmbeddingExecutors(): void {
  registerCommand<EmbUpsertParams>(EMB_CMD_UPSERT, (db, p) => {
    const result = db.prepare<void>(
      `INSERT INTO memory_embeddings (memory_id, embedding_json, model, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(memory_id) DO UPDATE SET embedding_json=excluded.embedding_json, model=excluded.model, updated_at=excluded.updated_at`,
    ).run(p.memoryId, p.embeddingJson, p.model, p.updatedAt);
    return { rowsAffected: result.changes };
  });

  registerCommand<IvfUpsertParams>(IVF_CMD_UPSERT, (db, p) => {
    const result = db.prepare<void>(
      `INSERT INTO ivf_centroids (model, centroids_json, num_vectors, built_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(model) DO UPDATE SET centroids_json=excluded.centroids_json, num_vectors=excluded.num_vectors, built_at=excluded.built_at`,
    ).run(p.model, p.centroidsJson, p.numVectors, p.builtAt);
    return { rowsAffected: result.changes };
  });

  registerQuery<readonly EmbeddingRow[], EmbByModelParams>(EMB_QUERY_BY_MODEL, (db, p) => {
    return db.prepare<EmbeddingRow>(
      'SELECT memory_id, embedding_json FROM memory_embeddings WHERE model = ?',
    ).all(p.model);
  });

  registerQuery<IvfCentroidsRow | null, EmbByModelParams>(IVF_QUERY_BY_MODEL, (db, p) => {
    return db.prepare<IvfCentroidsRow>(
      'SELECT centroids_json FROM ivf_centroids WHERE model = ? ORDER BY built_at DESC LIMIT 1',
    ).get(p.model) ?? null;
  });

  registerQuery<IvfMetaRow | null, EmbByModelParams>(IVF_QUERY_META_BY_MODEL, (db, p) => {
    const row = db.prepare<{ num_vectors: number | bigint; built_at: number }>(
      'SELECT num_vectors, built_at FROM ivf_centroids WHERE model = ?',
    ).get(p.model);
    if (!row) return null;
    return { num_vectors: Number(row.num_vectors), built_at: row.built_at };
  });
}
