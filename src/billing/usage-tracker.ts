/**
 * 用量追踪
 * 记录租户资源消耗（模拟次数、LLM token 等），供计费和配额查询使用
 */

import { randomUUID } from 'node:crypto';
import type { IDatabase } from '../storage/database.js';

export class UsageTracker {
  constructor(private readonly db: IDatabase) {}

  /** 记录一次资源使用 */
  record(tenantId: string, resource: string, quantity = 1): void {
    const id = `usage_${randomUUID()}`;
    const now = Date.now();
    this.db.prepare<void>(
      'INSERT INTO usage_records (id, tenant_id, resource, quantity, recorded_at) VALUES (?, ?, ?, ?, ?)',
    ).run(id, tenantId, resource, quantity, now);
  }

  /** 查询指定时间窗口内的资源消耗总量 */
  getUsage(tenantId: string, resource: string, sinceMs?: number): number {
    const since = sinceMs ?? (Date.now() - 30 * 24 * 60 * 60 * 1000); /* 默认 30 天 */
    const row = this.db.prepare<{ total: number }>(
      'SELECT COALESCE(SUM(quantity), 0) AS total FROM usage_records WHERE tenant_id = ? AND resource = ? AND recorded_at >= ?',
    ).get(tenantId, resource, since);
    return row?.total ?? 0;
  }

  /** 查询所有资源的当前用量摘要 */
  getSummary(tenantId: string, sinceMs?: number): Record<string, number> {
    const since = sinceMs ?? (Date.now() - 30 * 24 * 60 * 60 * 1000);
    const rows = this.db.prepare<{ resource: string; total: number }>(
      'SELECT resource, COALESCE(SUM(quantity), 0) AS total FROM usage_records WHERE tenant_id = ? AND recorded_at >= ? GROUP BY resource',
    ).all(tenantId, since);
    const result: Record<string, number> = {};
    for (const row of rows) {
      result[row.resource] = row.total;
    }
    return result;
  }
}
