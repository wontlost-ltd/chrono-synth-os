/**
 * Dashboard aggregate endpoints (P2.7 — full).
 *
 * Returns precomputed dashboard payloads for the persona health and
 * tenant ops surfaces. Single round trip per dashboard so the frontend
 * doesn't fan out to 5+ queries.
 *
 * P2.7 ships five series in one response:
 *   - values:        radar (current + d7 + d30 from core_values_snapshot)
 *   - decisionTrend: 30d daily count of evolution_diff_report rows
 *   - memoryStack:   stacked bar of memory_nodes by kind, last 30d
 *   - toolMix:       pie of tool_invocations by tool_id, last 7d
 *   - driftTimeline: drift_analysis_log entries last 90d with alert level
 */

import type { FastifyInstance } from 'fastify';
import type { IDatabase } from '../../storage/database.js';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

interface ValueRadarPoint {
  label: string;
  current: number;
  d7?: number;
  d30?: number;
}

interface DecisionTrendPoint {
  ts: number;
  count: number;
}

interface MemoryStackPoint {
  ts: number;
  episodic: number;
  semantic: number;
  procedural: number;
}

interface ToolMixSlice {
  toolId: string;
  count: number;
}

interface DriftTimelinePoint {
  reportId: string;
  analyzedAt: number;
  overallDriftScore: number;
  alertLevel: 'ok' | 'warning' | 'critical';
}

interface PersonaHealthPayload {
  personaId: string;
  values: ValueRadarPoint[];
  decisionTrend: DecisionTrendPoint[];
  memoryStack: MemoryStackPoint[];
  toolMix: ToolMixSlice[];
  driftTimeline: DriftTimelinePoint[];
  generatedAt: number;
}

function startOfDayUtc(ts: number): number {
  return Math.floor(ts / MS_PER_DAY) * MS_PER_DAY;
}

function buildRadarSeries(
  db: IDatabase,
  tenantId: string,
  personaId: string,
  now: number,
): ValueRadarPoint[] {
  type CurrentRow = { label: string; weight: number };
  let currentRows: CurrentRow[] = [];
  try {
    currentRows = db
      .prepare<CurrentRow>(
        `SELECT label, weight
           FROM core_values
          WHERE tenant_id = ?
          ORDER BY label ASC`,
      )
      .all(tenantId) as CurrentRow[];
  } catch {
    return [];
  }

  type SnapshotRow = { values_json: string };
  function readSnapshotAtAge(daysAgo: number): Record<string, number> | null {
    const targetTs = now - daysAgo * MS_PER_DAY;
    try {
      const row = db
        .prepare<SnapshotRow>(
          `SELECT values_json
             FROM core_values_snapshot
            WHERE tenant_id = ? AND (persona_id IS NULL OR persona_id = ?)
              AND snapshot_at <= ?
            ORDER BY snapshot_at DESC
            LIMIT 1`,
        )
        .get(tenantId, personaId, targetTs) as SnapshotRow | undefined;
      if (!row) return null;
      const parsed = JSON.parse(row.values_json);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
      return parsed as Record<string, number>;
    } catch {
      return null;
    }
  }

  const d7 = readSnapshotAtAge(7);
  const d30 = readSnapshotAtAge(30);

  return currentRows
    .filter((r) => Number.isFinite(r.weight))
    .map((r) => {
      const point: ValueRadarPoint = {
        label: r.label,
        current: Math.max(0, Math.min(1, r.weight)),
      };
      const v7 = d7?.[r.label];
      const v30 = d30?.[r.label];
      if (typeof v7 === 'number' && Number.isFinite(v7)) point.d7 = Math.max(0, Math.min(1, v7));
      if (typeof v30 === 'number' && Number.isFinite(v30)) point.d30 = Math.max(0, Math.min(1, v30));
      return point;
    });
}

function buildDecisionTrend(db: IDatabase, _tenantId: string, now: number): DecisionTrendPoint[] {
  type Row = { day_bucket: number; cnt: number };
  const since = startOfDayUtc(now) - 30 * MS_PER_DAY;
  try {
    const rows = db
      .prepare<Row>(
        `SELECT (created_at / ${MS_PER_DAY}) * ${MS_PER_DAY} AS day_bucket,
                COUNT(*) AS cnt
           FROM evolution_diff_report
          WHERE created_at >= ?
          GROUP BY day_bucket
          ORDER BY day_bucket ASC`,
      )
      .all(since) as Row[];
    return rows.map((r) => ({ ts: r.day_bucket, count: r.cnt }));
  } catch {
    return [];
  }
}

function buildMemoryStack(
  db: IDatabase,
  _tenantId: string,
  _personaId: string,
  now: number,
): MemoryStackPoint[] {
  type Row = { day_bucket: number; kind: string; cnt: number };
  const since = startOfDayUtc(now) - 30 * MS_PER_DAY;
  let rows: Row[] = [];
  try {
    rows = db
      .prepare<Row>(
        `SELECT (created_at / ${MS_PER_DAY}) * ${MS_PER_DAY} AS day_bucket,
                kind,
                COUNT(*) AS cnt
           FROM memory_nodes
          WHERE created_at >= ?
          GROUP BY day_bucket, kind
          ORDER BY day_bucket ASC`,
      )
      .all(since) as Row[];
  } catch {
    return [];
  }

  const byDay = new Map<number, MemoryStackPoint>();
  for (const r of rows) {
    let entry = byDay.get(r.day_bucket);
    if (!entry) {
      entry = { ts: r.day_bucket, episodic: 0, semantic: 0, procedural: 0 };
      byDay.set(r.day_bucket, entry);
    }
    if (r.kind === 'episodic') entry.episodic = r.cnt;
    else if (r.kind === 'semantic') entry.semantic = r.cnt;
    else if (r.kind === 'procedural') entry.procedural = r.cnt;
  }
  return [...byDay.values()].sort((a, b) => a.ts - b.ts);
}

function buildToolMix(
  db: IDatabase,
  tenantId: string,
  personaId: string,
  now: number,
): ToolMixSlice[] {
  type Row = { tool_id: string; cnt: number };
  const since = now - 7 * MS_PER_DAY;
  try {
    const rows = db
      .prepare<Row>(
        `SELECT tool_id, COUNT(*) AS cnt
           FROM tool_invocations
          WHERE tenant_id = ?
            AND persona_id = ?
            AND status = 'success'
            AND invoked_at >= ?
          GROUP BY tool_id
          ORDER BY cnt DESC
          LIMIT 12`,
      )
      .all(tenantId, personaId, since) as Row[];
    return rows.map((r) => ({ toolId: r.tool_id, count: r.cnt }));
  } catch {
    return [];
  }
}

function buildDriftTimeline(db: IDatabase, tenantId: string, now: number): DriftTimelinePoint[] {
  type Row = {
    report_id: string;
    analyzed_at: number;
    overall_drift_score: number;
    alert_level: string;
  };
  const since = now - 90 * MS_PER_DAY;
  try {
    const rows = db
      .prepare<Row>(
        `SELECT report_id, analyzed_at, overall_drift_score, alert_level
           FROM drift_analysis_log
          WHERE tenant_id = ?
            AND analyzed_at >= ?
          ORDER BY analyzed_at ASC`,
      )
      .all(tenantId, since) as Row[];
    return rows
      .filter((r) => Number.isFinite(r.overall_drift_score))
      .map((r) => ({
        reportId: r.report_id,
        analyzedAt: r.analyzed_at,
        overallDriftScore: r.overall_drift_score,
        alertLevel: normalizeAlertLevel(r.alert_level),
      }));
  } catch {
    return [];
  }
}

function normalizeAlertLevel(raw: string): 'ok' | 'warning' | 'critical' {
  if (raw === 'warning' || raw === 'critical') return raw;
  return 'ok';
}

export function registerDashboardRoutes(app: FastifyInstance, db: IDatabase | undefined): void {
  app.get<{ Params: { personaId: string } }>(
    '/api/v1/admin/dashboards/persona/:personaId',
    async (request, reply) => {
      const { personaId } = request.params;
      const tenantId = request.tenantId ?? 'default';
      const now = Date.now();

      if (!db) {
        return reply.send({
          data: {
            personaId,
            values: [],
            decisionTrend: [],
            memoryStack: [],
            toolMix: [],
            driftTimeline: [],
            generatedAt: now,
          } satisfies PersonaHealthPayload,
        });
      }

      const payload: PersonaHealthPayload = {
        personaId,
        values: buildRadarSeries(db, tenantId, personaId, now),
        decisionTrend: buildDecisionTrend(db, tenantId, now),
        memoryStack: buildMemoryStack(db, tenantId, personaId, now),
        toolMix: buildToolMix(db, tenantId, personaId, now),
        driftTimeline: buildDriftTimeline(db, tenantId, now),
        generatedAt: now,
      };

      return reply.send({ data: payload });
    },
  );
}
