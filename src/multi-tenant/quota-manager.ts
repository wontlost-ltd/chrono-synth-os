/**
 * 租户配额管理
 * 基于 quota_limits / quota_usage 表实现每租户资源限制
 * 支持按数量消费（如 LLM token 按实际用量计量）
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
  checkQuota(tenantId: string, resource: string, quantity = 1, now?: number): boolean {
    const limit = this.db.prepare<QuotaLimitRow>(
      'SELECT * FROM quota_limits WHERE tenant_id = ? AND resource = ?',
    ).get(tenantId, resource);
    if (!limit) return true;

    const ts = now ?? Date.now();
    const windowStart = ts - limit.window_ms;

    const usage = this.db.prepare<QuotaUsageRow>(
      'SELECT * FROM quota_usage WHERE tenant_id = ? AND resource = ? AND window_start >= ?',
    ).get(tenantId, resource, windowStart);

    const used = usage?.used ?? 0;
    return (used + quantity) <= limit.max_per_window;
  }

  /** 原子性检查并消费配额（支持按数量消费） */
  consumeQuota(tenantId: string, resource: string, quantity = 1, now?: number): boolean {
    const ts = now ?? Date.now();
    const limit = this.db.prepare<QuotaLimitRow>(
      'SELECT * FROM quota_limits WHERE tenant_id = ? AND resource = ?',
    ).get(tenantId, resource);

    if (!limit) {
      this.recordUsage(tenantId, resource, quantity, ts);
      return true;
    }
    if (limit.max_per_window <= 0 || quantity > limit.max_per_window) return false;

    const windowStart = ts - (ts % limit.window_ms);
    const result = this.db.prepare<void>(
      `INSERT INTO quota_usage (tenant_id, resource, used, window_start)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(tenant_id, resource, window_start) DO UPDATE SET used = quota_usage.used + ? WHERE quota_usage.used + ? <= ?`,
    ).run(tenantId, resource, quantity, windowStart, quantity, quantity, limit.max_per_window);
    return result.changes > 0;
  }

  /** 记录资源使用（按数量） */
  recordUsage(tenantId: string, resource: string, quantity = 1, now?: number): void {
    const ts = now ?? Date.now();
    const limit = this.db.prepare<QuotaLimitRow>(
      'SELECT * FROM quota_limits WHERE tenant_id = ? AND resource = ?',
    ).get(tenantId, resource);

    const windowStart = limit ? ts - (ts % limit.window_ms) : ts;

    this.db.prepare<void>(
      `INSERT INTO quota_usage (tenant_id, resource, used, window_start)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(tenant_id, resource, window_start) DO UPDATE SET used = quota_usage.used + ?`,
    ).run(tenantId, resource, quantity, windowStart, quantity);
  }
}
