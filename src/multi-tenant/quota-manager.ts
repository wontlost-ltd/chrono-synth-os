/**
 * 租户配额管理
 * 基于 quota_limits / quota_usage 表实现每租户资源限制
 * 支持按数量消费（如 LLM token 按实际用量计量）
 */

import type { SyncWriteUnitOfWork } from '@chrono/kernel';
import {
  quotaQueryLimit, quotaQueryUsage,
  quotaCmdSetLimit, quotaCmdClearLimit, quotaCmdConsume, quotaCmdRecordUsage, quotaCmdPruneUsage,
} from '@chrono/kernel';
import { registerCoreSelfExecutors } from '../storage/executors/index.js';

export class QuotaManager {
  constructor(private readonly tx: SyncWriteUnitOfWork) {
    registerCoreSelfExecutors();
  }

  /** 设置租户某项资源的配额限制 */
  setLimit(tenantId: string, resource: string, maxPerWindow: number, windowMs: number): void {
    this.tx.execute(quotaCmdSetLimit({ tenantId, resource, maxPerWindow, windowMs }));
  }

  /** 清除租户某项资源的配额限制（用于无限计划） */
  clearLimit(tenantId: string, resource: string): void {
    this.tx.execute(quotaCmdClearLimit({ tenantId, resource }));
  }

  /** 检查租户是否还有配额（无限制返回 true） */
  checkQuota(tenantId: string, resource: string, quantity = 1, now?: number): boolean {
    const limit = this.tx.queryOne(quotaQueryLimit(tenantId, resource));
    if (!limit) return true;

    const ts = now ?? Date.now();
    const windowStart = ts - (ts % limit.window_ms);

    const usage = this.tx.queryOne(quotaQueryUsage(tenantId, resource, windowStart));
    const used = usage?.used ?? 0;
    return (used + quantity) <= limit.max_per_window;
  }

  /** 原子性检查并消费配额（支持按数量消费） */
  consumeQuota(tenantId: string, resource: string, quantity = 1, now?: number): boolean {
    const ts = now ?? Date.now();
    const limit = this.tx.queryOne(quotaQueryLimit(tenantId, resource));

    if (!limit) {
      this.recordUsage(tenantId, resource, quantity, ts);
      return true;
    }
    if (limit.max_per_window <= 0 || quantity > limit.max_per_window) return false;

    const windowStart = ts - (ts % limit.window_ms);
    const result = this.tx.execute(quotaCmdConsume({
      tenantId, resource, quantity, windowStart, maxPerWindow: limit.max_per_window,
    }));
    return result.rowsAffected > 0;
  }

  /** 记录资源使用（按数量） */
  recordUsage(tenantId: string, resource: string, quantity = 1, now?: number): void {
    const ts = now ?? Date.now();
    const limit = this.tx.queryOne(quotaQueryLimit(tenantId, resource));
    const windowStart = limit ? ts - (ts % limit.window_ms) : ts;

    this.tx.execute(quotaCmdRecordUsage({ tenantId, resource, quantity, windowStart }));
  }

  /**
   * 清理一批旧窗口行（计量只读当前窗口，旧窗口是死重）。**绝不删当前窗口**——按每个资源的
   * window_ms 算其当前窗口起点，只删 window_start 既早于 cutoff 又早于当前窗口的行（防当期用量被
   * 清零导致配额绕过）。
   * @param now 当前时刻（算各资源当前窗口用）。
   * @param cutoff 删除阈值：window_start < cutoff 才考虑删。
   * @returns 本批实删行数（< batchSize 表示已清完）。
   */
  pruneUsageBefore(now: number, cutoff: number, batchSize = 1000): number {
    return this.tx.execute(quotaCmdPruneUsage({ now, cutoff, batchSize })).rowsAffected;
  }
}
