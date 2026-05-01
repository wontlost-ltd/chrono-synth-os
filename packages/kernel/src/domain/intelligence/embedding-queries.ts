/**
 * 向量嵌入索引 Query/Command kind 常量与参数类型
 */

import type { Query, Command } from '../../ports/query.js';

/* ── Command Kinds ── */

export const EMB_CMD_UPSERT = 'embedding.upsert' as const;
export const IVF_CMD_UPSERT = 'ivfCentroids.upsert' as const;

/* ── Query Kinds ── */

export const EMB_QUERY_BY_MODEL = 'embedding.byModel' as const;
export const IVF_QUERY_BY_MODEL = 'ivfCentroids.byModel' as const;
export const IVF_QUERY_META_BY_MODEL = 'ivfCentroids.metaByModel' as const;

/* ── 行类型 ── */

export interface EmbeddingRow {
  readonly memory_id: string;
  readonly embedding_json: string;
}

export interface IvfCentroidsRow {
  readonly centroids_json: string;
}

export interface IvfMetaRow {
  readonly num_vectors: number;
  readonly built_at: number;
}

/* ── 参数类型 ── */

export interface EmbUpsertParams {
  memoryId: string;
  embeddingJson: string;
  model: string;
  updatedAt: number;
}

export interface EmbByModelParams {
  model: string;
}

export interface IvfUpsertParams {
  model: string;
  centroidsJson: string;
  numVectors: number;
  builtAt: number;
}

/* ── Command 工厂 ── */

export function embCmdUpsert(params: EmbUpsertParams): Command<EmbUpsertParams> {
  return { kind: EMB_CMD_UPSERT, params };
}

export function ivfCmdUpsert(params: IvfUpsertParams): Command<IvfUpsertParams> {
  return { kind: IVF_CMD_UPSERT, params };
}

/* ── Query 工厂 ── */

export function embQueryByModel(params: EmbByModelParams): Query<readonly EmbeddingRow[], EmbByModelParams> {
  return { kind: EMB_QUERY_BY_MODEL, params };
}

export function ivfQueryByModel(params: EmbByModelParams): Query<IvfCentroidsRow | null, EmbByModelParams> {
  return { kind: IVF_QUERY_BY_MODEL, params };
}

export function ivfQueryMetaByModel(params: EmbByModelParams): Query<IvfMetaRow | null, EmbByModelParams> {
  return { kind: IVF_QUERY_META_BY_MODEL, params };
}
