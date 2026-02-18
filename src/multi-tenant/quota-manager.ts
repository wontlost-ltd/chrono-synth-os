/**
 * 租户配额管理
 * 基于 quota_limits / quota_usage 表实现每租户资源限制
 */

import type { IDatabase } from '../storage/database.js';

interface QuotaLimitRow {
  tenant_id: string;
  resource: string;
  max_per_window: number;
  window_ms: number;
}

interface QuotaUsageRow {
  tenant_id: string;
  resource: string;
  used: number;
  window_start: number;
}

export class QuotaManager {
  constructor(private readonly db: IDatabase) {}

  /** 设置租户某项资源的配额限制 */
  setLimit(tenantId: string, resource: string, maxPerWindow: number, windowMs: number): void {
    this.db.prepare<void>(
      `INSERT INTO quota_limits (tenant_id, resource, max_per_window, window_ms)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(tenant_id, resource) DO UPDATE SET max_per_window=excluded.max_per_window, window_ms=excluded.window_ms`,
    ).run(tenantId, resource, maxPerWindow, windowMs);
  }

  /** 清除租户某项资源的配额限制（用于无限计划） */
  clearLimit(tenantId: string, resource: string): void {
    this.db.prepare<void>(
      'DELETE FROM quota_limits WHERE tenant_id = ? AND resource = ?',
    ).run(tenantId, resource);
  }

  /** 检查租户是否还有配额（无限制返回 true） */
  checkQuota(tenantId: string, resource: string, now?: number): boolean {
    const limit = this.db.prepare<QuotaLimitRow>(
      'SELECT * FROM quota_limits WHERE tenant_id = ? AND resource = ?',
    ).get(tenantId, resource);
    if (!limit) return true; /* 无配额限制 */

    const ts = now ?? Date.now();
    const windowStart = ts - limit.window_ms;

    const usage = this.db.prepare<QuotaUsageRow>(
      'SELECT * FROM quota_usage WHERE tenant_id = ? AND resource = ? AND window_start >= ?',
    ).get(tenantId, resource, windowStart);

    return !usage || usage.used < limit.max_per_window;
  }

  /** 原子性检查并消费配额（check + record 合一，避免竞态） */
  consumeQuota(tenantId: string, resource: string, now?: number): boolean {
    if (!this.checkQuota(tenantId, resource, now)) return false;
    this.recordUsage(tenantId, resource, now);
    return true;
  }

  /** 记录一次资源使用 */
  recordUsage(tenantId: string, resource: string, now?: number): void {
    const ts = now ?? Date.now();
    const limit = this.db.prepare<QuotaLimitRow>(
      'SELECT * FROM quota_limits WHERE tenant_id = ? AND resource = ?',
    ).get(tenantId, resource);

    const windowStart = limit ? ts - (ts % limit.window_ms) : ts;

    this.db.prepare<void>(
      `INSERT INTO quota_usage (tenant_id, resource, used, window_start)
       VALUES (?, ?, 1, ?)
       ON CONFLICT(tenant_id, resource, window_start) DO UPDATE SET used = used + 1`,
    ).run(tenantId, resource, windowStart);
  }
}
