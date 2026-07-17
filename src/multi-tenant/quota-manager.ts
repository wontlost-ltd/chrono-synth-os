/**
 * 租户配额管理（双入口过渡契约，租户分片 Phase 0）。
 * 基于 quota_limits / quota_usage 表实现每租户资源限制，支持按数量消费。
 *
 * 两模式（语义诚实分离）：
 *   - resolver 模式（fromResolver）：未绑事务的长期服务（route 注册期）。per-tenant 经
 *     resolver.dbForTenant(tenantId) 选 db；cross-tenant（pruneUsageBefore）经 allShardDbs() fan-out。
 *   - bound-UoW 模式（fromUnitOfWork）：已进事务的调用链（billing/entitlement）。所有操作固定用该
 *     事务，不重新解析 db（否则脱离事务），pruneUsageBefore 单次 execute 不 fan-out。
 * 因 IDatabase extends SyncWriteUnitOfWork，两模式内部统一到 SyncWriteUnitOfWork 接口，无适配层。
 */
import type { SyncWriteUnitOfWork } from '@chrono/kernel';
import {
  quotaQueryLimit, quotaQueryUsage,
  quotaCmdSetLimit, quotaCmdClearLimit, quotaCmdConsume, quotaCmdRecordUsage, quotaCmdPruneUsage,
} from '@chrono/kernel';
import { registerCoreSelfExecutors } from '../storage/executors/index.js';
import type { TenantDbResolver } from '../storage/tenant-db-resolver.js';

/** 内部 db 取源：resolver 模式按 tenantId 解析；UoW 模式固定 tx。 */
interface QuotaSource {
  /** per-tenant 操作取 db。 */
  forTenant(tenantId: string): SyncWriteUnitOfWork;
  /** cross-tenant fan-out 的所有 db（UoW 模式返 [tx]）。 */
  allDbs(): SyncWriteUnitOfWork[];
}

export interface PruneResult {
  readonly totalDeleted: number;
  /** 任一 shard 本轮 removed >= batchSize（保守分页信号，是否继续下一批）。 */
  readonly mayHaveMore: boolean;
}

export class QuotaManager {
  private constructor(private readonly source: QuotaSource) {
    registerCoreSelfExecutors();
  }

  /** resolver 模式：per-tenant→dbForTenant，prune→allShardDbs fan-out。用于 route 等未绑事务的长期服务。 */
  static fromResolver(resolver: TenantDbResolver): QuotaManager {
    return new QuotaManager({
      forTenant: (tenantId) => resolver.dbForTenant(tenantId),
      allDbs: () => resolver.allShardDbs(),
    });
  }

  /** bound-UoW 模式：固定用该事务，不 fan-out。用于 billing/entitlement 等已绑事务的调用链。 */
  static fromUnitOfWork(tx: SyncWriteUnitOfWork): QuotaManager {
    return new QuotaManager({
      forTenant: () => tx,
      allDbs: () => [tx],
    });
  }

  setLimit(tenantId: string, resource: string, maxPerWindow: number, windowMs: number): void {
    this.source.forTenant(tenantId).execute(quotaCmdSetLimit({ tenantId, resource, maxPerWindow, windowMs }));
  }

  clearLimit(tenantId: string, resource: string): void {
    this.source.forTenant(tenantId).execute(quotaCmdClearLimit({ tenantId, resource }));
  }

  checkQuota(tenantId: string, resource: string, quantity = 1, now?: number): boolean {
    const tx = this.source.forTenant(tenantId);
    const limit = tx.queryOne(quotaQueryLimit(tenantId, resource));
    if (!limit) return true;
    const ts = now ?? Date.now();
    const windowStart = ts - (ts % limit.window_ms);
    const usage = tx.queryOne(quotaQueryUsage(tenantId, resource, windowStart));
    const used = usage?.used ?? 0;
    return (used + quantity) <= limit.max_per_window;
  }

  consumeQuota(tenantId: string, resource: string, quantity = 1, now?: number): boolean {
    const tx = this.source.forTenant(tenantId);
    const ts = now ?? Date.now();
    const limit = tx.queryOne(quotaQueryLimit(tenantId, resource));
    if (!limit) {
      this.recordUsage(tenantId, resource, quantity, ts);
      return true;
    }
    if (limit.max_per_window <= 0 || quantity > limit.max_per_window) return false;
    const windowStart = ts - (ts % limit.window_ms);
    const result = tx.execute(quotaCmdConsume({
      tenantId, resource, quantity, windowStart, maxPerWindow: limit.max_per_window,
    }));
    return result.rowsAffected > 0;
  }

  recordUsage(tenantId: string, resource: string, quantity = 1, now?: number): void {
    const tx = this.source.forTenant(tenantId);
    const ts = now ?? Date.now();
    const limit = tx.queryOne(quotaQueryLimit(tenantId, resource));
    const windowStart = limit ? ts - (ts % limit.window_ms) : ts;
    tx.execute(quotaCmdRecordUsage({ tenantId, resource, quantity, windowStart }));
  }

  /**
   * 清理旧窗口行（计量只读当前窗口，旧窗口是死重）。绝不删当前窗口。
   * resolver 模式：fan-out 到 allShardDbs()（唯一物理 db），fail-fast——某 shard 抛错立即整体抛出，
   * 后续 shard 本轮不执行；无跨-shard 原子性，靠 prune 幂等下周期重试收敛。
   * UoW 模式：allDbs() 返 [tx]，等价单次 execute。
   * @returns totalDeleted 本轮各 shard 实删之和；mayHaveMore=任一 shard removed>=batchSize。
   */
  pruneUsageBefore(now: number, cutoff: number, batchSize = 1000): PruneResult {
    let totalDeleted = 0;
    let mayHaveMore = false;
    for (const db of this.source.allDbs()) {
      const removed = db.execute(quotaCmdPruneUsage({ now, cutoff, batchSize })).rowsAffected;
      totalDeleted += removed;
      if (removed >= batchSize) mayHaveMore = true;
    }
    return { totalDeleted, mayHaveMore };
  }
}
