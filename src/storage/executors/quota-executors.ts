/**
 * 配额管理 SQL 执行器 — 将内核 Query/Command kind 映射到 db.prepare 调用
 */

import { registerQuery, registerCommand } from '../legacy-sync-bridge.js';
import type {
  QuotaLimitRow, QuotaUsageRow,
  QuotaLimitLookupParams, QuotaUsageLookupParams,
  QuotaSetLimitParams, QuotaClearLimitParams,
  QuotaConsumeParams, QuotaRecordUsageParams, QuotaPruneUsageParams,
} from '@chrono/kernel';
import {
  QUOTA_QUERY_LIMIT, QUOTA_QUERY_USAGE,
  QUOTA_CMD_SET_LIMIT, QUOTA_CMD_CLEAR_LIMIT,
  QUOTA_CMD_CONSUME, QUOTA_CMD_RECORD_USAGE, QUOTA_CMD_PRUNE_USAGE,
} from '@chrono/kernel';

export function registerQuotaExecutors(): void {
  /* ── Queries ── */

  registerQuery<QuotaLimitRow | null, QuotaLimitLookupParams>(QUOTA_QUERY_LIMIT, (db, p) => {
    return db.prepare<QuotaLimitRow>(
      'SELECT * FROM quota_limits WHERE tenant_id = ? AND resource = ?',
    ).get(p.tenantId, p.resource) ?? null;
  });

  registerQuery<QuotaUsageRow | null, QuotaUsageLookupParams>(QUOTA_QUERY_USAGE, (db, p) => {
    return db.prepare<QuotaUsageRow>(
      'SELECT * FROM quota_usage WHERE tenant_id = ? AND resource = ? AND window_start = ?',
    ).get(p.tenantId, p.resource, p.windowStart) ?? null;
  });

  /* ── Commands ── */

  registerCommand<QuotaSetLimitParams>(QUOTA_CMD_SET_LIMIT, (db, p) => {
    const result = db.prepare<void>(
      `INSERT INTO quota_limits (tenant_id, resource, max_per_window, window_ms)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(tenant_id, resource) DO UPDATE SET max_per_window=excluded.max_per_window, window_ms=excluded.window_ms`,
    ).run(p.tenantId, p.resource, p.maxPerWindow, p.windowMs);
    return { rowsAffected: result.changes };
  });

  registerCommand<QuotaClearLimitParams>(QUOTA_CMD_CLEAR_LIMIT, (db, p) => {
    const result = db.prepare<void>(
      'DELETE FROM quota_limits WHERE tenant_id = ? AND resource = ?',
    ).run(p.tenantId, p.resource);
    return { rowsAffected: result.changes };
  });

  registerCommand<QuotaConsumeParams>(QUOTA_CMD_CONSUME, (db, p) => {
    const result = db.prepare<void>(
      `INSERT INTO quota_usage (tenant_id, resource, used, window_start)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(tenant_id, resource, window_start) DO UPDATE SET used = quota_usage.used + ? WHERE quota_usage.used + ? <= ?`,
    ).run(p.tenantId, p.resource, p.quantity, p.windowStart, p.quantity, p.quantity, p.maxPerWindow);
    return { rowsAffected: result.changes };
  });

  registerCommand<QuotaRecordUsageParams>(QUOTA_CMD_RECORD_USAGE, (db, p) => {
    const result = db.prepare<void>(
      `INSERT INTO quota_usage (tenant_id, resource, used, window_start)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(tenant_id, resource, window_start) DO UPDATE SET used = quota_usage.used + ?`,
    ).run(p.tenantId, p.resource, p.quantity, p.windowStart, p.quantity);
    return { rowsAffected: result.changes };
  });

  /* 清理已关闭的旧窗口行（window_start < cutoff）。consumeQuota/checkQuota 只读当前窗口，
   * 旧窗口行是纯死重——删了不影响计量。组合主键无单列 id，用行值元组 IN 子查询限批（SQLite
   * DELETE...LIMIT 标准发行版未启用；行值 IN 两库通用）。 */
  registerCommand<QuotaPruneUsageParams>(QUOTA_CMD_PRUNE_USAGE, (db, p) => {
    const result = db.prepare<void>(
      `DELETE FROM quota_usage
        WHERE (tenant_id, resource, window_start) IN (
          SELECT tenant_id, resource, window_start FROM quota_usage
           WHERE window_start < ?
           ORDER BY window_start ASC
           LIMIT ?
        )`,
    ).run(p.cutoff, p.batchSize);
    return { rowsAffected: result.changes };
  });
}
