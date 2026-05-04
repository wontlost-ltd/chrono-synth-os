/**
 * 用量追踪
 * 记录租户资源消耗（模拟次数、LLM token 等），供计费和配额查询使用
 */

import type { SyncWriteUnitOfWork } from '@chrono/kernel';
import { usageQueryGet, usageQuerySummary, usageCmdRecord } from '@chrono/kernel';
import { asUow, type UowOrDb } from '../storage/uow-helpers.js';
import { registerCoreSelfExecutors } from '../storage/executors/index.js';
import { generatePrefixedId } from '../utils/id-generator.js';

export class UsageTracker {
  private readonly tx: SyncWriteUnitOfWork;

  constructor(uowOrDb: UowOrDb) {
    registerCoreSelfExecutors();
    this.tx = asUow(uowOrDb);
  }

  /** 记录一次资源使用 */
  record(tenantId: string, resource: string, quantity = 1): void {
    const id = generatePrefixedId('usage');
    const now = Date.now();
    this.tx.execute(usageCmdRecord({ id, tenantId, resource, quantity, now }));
  }

  /** 查询指定时间窗口内的资源消耗总量 */
  getUsage(tenantId: string, resource: string, sinceMs?: number): number {
    const since = sinceMs ?? (Date.now() - 30 * 24 * 60 * 60 * 1000);
    const row = this.tx.queryOne(usageQueryGet(tenantId, resource, since));
    return Number(row?.total ?? 0);
  }

  /** 查询所有资源的当前用量摘要 */
  getSummary(tenantId: string, sinceMs?: number): Record<string, number> {
    const since = sinceMs ?? (Date.now() - 30 * 24 * 60 * 60 * 1000);
    const rows = this.tx.queryMany(usageQuerySummary(tenantId, since));
    const result: Record<string, number> = {};
    for (const row of rows) {
      result[row.resource] = Number(row.total);
    }
    return result;
  }
}
