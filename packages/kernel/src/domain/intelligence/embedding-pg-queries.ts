/**
 * Postgres + pgvector specific Query/Command kinds for the embedding index.
 *
 * This module is the kernel-side declaration of pgvector-backed search and
 * upsert. It is parallel to embedding-queries.ts (which targets the legacy
 * embedding_json TEXT column shared by SQLite and Postgres). The plan is
 * to dual-write through both during the migration window
 * (.claude/plan/pgvector-integration-2026.md, stages 4-5) and then retire
 * embedding_json once production reads have stabilized on the vector path.
 *
 * The kernel only declares the protocol; the executor in
 * src/storage/executors/* serializes the vector to pgvector text format
 * ('[0.1,0.2,...]') and handles the actual SQL.
 */

import type { Query, Command } from '../../ports/query.js';

/* ── Command Kinds ── */

export const EMB_CMD_UPSERT_PG = 'embedding.upsertPg' as const;

/* ── Query Kinds ── */

export const EMB_QUERY_NEAREST_PG = 'embedding.nearestPg' as const;

/* ── 行类型 ── */

export interface EmbNearestPgRow {
  readonly memory_id: string;
  /** Cosine distance: 0 = identical, 1 = orthogonal, 2 = opposite. */
  readonly distance: number;
}

/* ── 参数类型 ── */

export interface EmbUpsertPgParams {
  readonly tenantId: string;
  readonly memoryId: string;
  readonly model: string;
  readonly dims: number;
  /** Plain JS number array; the executor serializes to pgvector format. */
  readonly vector: readonly number[];
  readonly updatedAt: number;
}

export interface EmbNearestPgParams {
  readonly tenantId: string;
  readonly model: string;
  readonly queryVector: readonly number[];
  readonly k: number;
  /** Optional ceiling on cosine distance; rows with distance > maxDistance are dropped. */
  readonly maxDistance?: number;
}

/* ── Command 工厂 ── */

export function embCmdUpsertPg(params: EmbUpsertPgParams): Command<EmbUpsertPgParams> {
  return { kind: EMB_CMD_UPSERT_PG, params };
}

/* ── Query 工厂 ── */

export function embQueryNearestPg(
  params: EmbNearestPgParams,
): Query<EmbNearestPgRow, EmbNearestPgParams> {
  return { kind: EMB_QUERY_NEAREST_PG, params };
}
