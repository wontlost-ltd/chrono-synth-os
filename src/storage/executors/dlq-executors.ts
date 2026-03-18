/**
 * Platform DLQ SQL 执行器
 */

import { registerQuery, registerCommand } from '../legacy-sync-bridge.js';
import type {
  DlqEventRow, DlqRecordParams, DlqByTenantParams, DlqMarkReplayedParams,
} from '@chrono/kernel';
import {
  DLQ_QUERY_BY_TENANT, DLQ_QUERY_BACKLOG_PENDING, DLQ_QUERY_BACKLOG_REPLAYED,
  DLQ_QUERY_BY_ID, DLQ_CMD_RECORD, DLQ_CMD_MARK_REPLAYED,
} from '@chrono/kernel';

export function registerDlqExecutors(): void {
  /* ── Queries ── */

  registerQuery<readonly DlqEventRow[], DlqByTenantParams>(DLQ_QUERY_BY_TENANT, (db, p) => {
    return db.prepare<DlqEventRow>(
      `SELECT * FROM platform_dlq_events
       WHERE tenant_id = ?
       ORDER BY created_at DESC
       LIMIT ?`,
    ).all(p.tenantId, p.limit);
  });

  registerQuery<{ count: number } | null, void>(DLQ_QUERY_BACKLOG_PENDING, (db) => {
    return db.prepare<{ count: number }>(
      `SELECT COUNT(*) AS count FROM platform_dlq_events WHERE status = 'pending'`,
    ).get() ?? null;
  });

  registerQuery<{ count: number } | null, void>(DLQ_QUERY_BACKLOG_REPLAYED, (db) => {
    return db.prepare<{ count: number }>(
      `SELECT COUNT(*) AS count FROM platform_dlq_events WHERE status = 'replayed'`,
    ).get() ?? null;
  });

  registerQuery<DlqEventRow | null, string>(DLQ_QUERY_BY_ID, (db, id) => {
    return db.prepare<DlqEventRow>(
      `SELECT * FROM platform_dlq_events WHERE id = ? LIMIT 1`,
    ).get(id) ?? null;
  });

  /* ── Commands ── */

  registerCommand<DlqRecordParams>(DLQ_CMD_RECORD, (db, p) => {
    const result = db.prepare<void>(
      `INSERT INTO platform_dlq_events (
        id, tenant_id, source_component, source_topic, dlq_topic, event_type,
        partition_key, payload_json, error_message, status, created_at, replayed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, NULL)`,
    ).run(p.id, p.tenantId, p.sourceComponent, p.sourceTopic, p.dlqTopic,
      p.eventType, p.partitionKey, p.payloadJson, p.errorMessage, p.createdAt);
    return { rowsAffected: result.changes };
  });

  registerCommand<DlqMarkReplayedParams>(DLQ_CMD_MARK_REPLAYED, (db, p) => {
    const result = db.prepare<void>(
      `UPDATE platform_dlq_events SET status = 'replayed', replayed_at = ? WHERE id = ?`,
    ).run(p.now, p.id);
    return { rowsAffected: result.changes };
  });
}
