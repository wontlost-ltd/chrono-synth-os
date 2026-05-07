/**
 * 用量追踪 SQL 执行器
 */

import { registerQuery, registerCommand } from '../legacy-sync-bridge.js';
import type { UsageGetParams, UsageSummaryParams, UsageRecordParams } from '@chrono/kernel';
import {
  USAGE_QUERY_GET, USAGE_QUERY_SUMMARY, USAGE_CMD_RECORD,
} from '@chrono/kernel';

export function registerUsageExecutors(): void {
  /* ── Queries ── */

  registerQuery<{ total: number } | null, UsageGetParams>(USAGE_QUERY_GET, (db, p) => {
    return db.prepare<{ total: number }>(
      'SELECT COALESCE(SUM(quantity), 0) AS total FROM usage_records WHERE tenant_id = ? AND resource = ? AND recorded_at >= ?',
    ).get(p.tenantId, p.resource, p.since) ?? null;
  });

  registerQuery<Array<{ resource: string; total: number }>, UsageSummaryParams>(USAGE_QUERY_SUMMARY, (db, p) => {
    return db.prepare<{ resource: string; total: number }>(
      'SELECT resource, COALESCE(SUM(quantity), 0) AS total FROM usage_records WHERE tenant_id = ? AND recorded_at >= ? GROUP BY resource',
    ).all(p.tenantId, p.since);
  });

  /* ── Commands ── */

  registerCommand<UsageRecordParams>(USAGE_CMD_RECORD, (db, p) => {
    const result = db.prepare<void>(
      'INSERT INTO usage_records (id, tenant_id, resource, quantity, recorded_at) VALUES (?, ?, ?, ?, ?)',
    ).run(p.id, p.tenantId, p.resource, p.quantity, p.now);
    return { rowsAffected: result.changes };
  });
}
