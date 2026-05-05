/**
 * Dashboard aggregate endpoints (P2.7 scaffold).
 *
 * Returns precomputed dashboard payloads for the persona health and
 * tenant ops surfaces. Single round trip per dashboard so the frontend
 * doesn't fan out to 5+ queries. Aggregation is server-side because:
 *
 *   1. The radar chart needs core_values snapshots from t0 / t-7d /
 *      t-30d; computing those on the client would mean pulling raw
 *      snapshots and replaying drift offline.
 *   2. Tool-mix pie aggregates tool_invocations by tool_id with COUNT;
 *      that's a SQL job, not a frontend-friendly task.
 *
 * Current scope is a stub: returns the shape the frontend
 * (chrono-synth-web/src/features/dashboards/*) expects, populated
 * with empty data when DB isn't available. Real aggregation lands in
 * a follow-up PR alongside the other charts (decision-trend,
 * memory-stack, drift-timeline, tools-pie).
 */

import type { FastifyInstance } from 'fastify';
import type { IDatabase } from '../../storage/database.js';

interface ValueRadarPoint {
  label: string;
  current: number;
  d7?: number;
  d30?: number;
}

interface PersonaHealthPayload {
  personaId: string;
  /** Empty when persona not found or no data; frontend renders the
   *  empty state. We don't 404 because the dashboard route may be
   *  shared by an admin viewing a persona they don't own. */
  values: ValueRadarPoint[];
  /** Generated-at timestamp (epoch ms) for cache eviction. */
  generatedAt: number;
}

export function registerDashboardRoutes(app: FastifyInstance, db: IDatabase | undefined): void {
  /* GET /api/v1/admin/dashboards/persona/:personaId
   * Per-persona health payload. Tenant-scoped via request.tenantId. */
  app.get<{ Params: { personaId: string } }>(
    '/api/v1/admin/dashboards/persona/:personaId',
    async (request, reply) => {
      const { personaId } = request.params;
      const tenantId = request.tenantId ?? 'default';

      if (!db) {
        return reply.send({
          data: {
            personaId,
            values: [],
            generatedAt: Date.now(),
          } satisfies PersonaHealthPayload,
        });
      }

      /* core_values is tall (one row per value, columns: id, label,
       * weight, updated_at). The tenant_id column was added by v007
       * (multi-tenant). We pull today's full graph with a single
       * indexed scan; historical d7 / d30 snapshots will come from
       * a future snapshot table indexed by (tenant_id, persona_id,
       * snapshot_at). For now the frontend renders only the `current`
       * series. */
      type Row = { label: string; weight: number };
      let rows: Row[] = [];
      try {
        rows = db
          .prepare<Row>(
            `SELECT label, weight
               FROM core_values
              WHERE tenant_id = ?
              ORDER BY label ASC`,
          )
          .all(tenantId) as Row[];
      } catch {
        /* Schema drift / driver mismatch — return empty values, the
         * frontend renders the empty state. Bad data shouldn't crash
         * the dashboard. The `personaId` parameter is captured for
         * future per-persona sharding once persona_id is added. */
        void personaId;
      }

      const values: ValueRadarPoint[] = rows
        .filter((r) => typeof r.weight === 'number' && Number.isFinite(r.weight))
        .map((r) => ({
          label: r.label,
          current: Math.max(0, Math.min(1, r.weight)),
          /* Historical snapshots not yet implemented */
          d7: undefined,
          d30: undefined,
        }));

      return reply.send({
        data: { personaId, values, generatedAt: Date.now() } satisfies PersonaHealthPayload,
      });
    },
  );
}
