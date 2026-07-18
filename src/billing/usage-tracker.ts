/**
 * 用量追踪
 * 记录租户资源消耗（模拟次数、LLM token 等），供计费和配额查询使用
 *
 * 双入口（租户分片 Phase 0，套用 CostTracker/TokenBudget/QuotaManager 模式）：
 *   - fromResolver：未绑事务的长期服务（route 注册期）。per-tenant 经
 *     resolver.dbForTenant(tenantId) 选 db。UsageTracker 无 cross-tenant 方法，故无 fan-out。
 *   - fromUnitOfWork：已进事务的调用链（测试 / 内存 db 单库语境，或 billing-route-facade
 *     等已绑事务的调用方）。所有操作固定用该事务，不重新解析 db（否则脱离事务）。
 * 因 IDatabase extends SyncWriteUnitOfWork，两模式内部统一到 SyncWriteUnitOfWork 接口，无适配层。
 */

import type { SyncWriteUnitOfWork } from '@chrono/kernel';
import { usageQueryGet, usageQuerySummary, usageCmdRecord } from '@chrono/kernel';
import { registerCoreSelfExecutors } from '../storage/executors/index.js';
import { generatePrefixedId } from '../utils/id-generator.js';
import type { TenantDbResolver } from '../storage/tenant-db-resolver.js';

/** 内部 db 取源：resolver 模式按 tenantId 解析；UoW 模式固定 tx。 */
interface MeterSource {
  forTenant(tenantId: string): SyncWriteUnitOfWork;
}

export class UsageTracker {
  private constructor(private readonly source: MeterSource) {
    registerCoreSelfExecutors();
  }

  /** resolver 模式：per-tenant→dbForTenant。用于 route 等未绑事务的长期服务。 */
  static fromResolver(resolver: TenantDbResolver): UsageTracker {
    return new UsageTracker({ forTenant: (t) => resolver.dbForTenant(t) });
  }

  /** bound-UoW 模式：固定用该事务，不重新解析 db。 */
  static fromUnitOfWork(tx: SyncWriteUnitOfWork): UsageTracker {
    return new UsageTracker({ forTenant: () => tx });
  }

  /** 记录一次资源使用 */
  record(tenantId: string, resource: string, quantity = 1): void {
    const id = generatePrefixedId('usage');
    const now = Date.now();
    this.source.forTenant(tenantId).execute(usageCmdRecord({ id, tenantId, resource, quantity, now }));
  }

  /** 查询指定时间窗口内的资源消耗总量 */
  getUsage(tenantId: string, resource: string, sinceMs?: number): number {
    const since = sinceMs ?? (Date.now() - 30 * 24 * 60 * 60 * 1000);
    const row = this.source.forTenant(tenantId).queryOne(usageQueryGet(tenantId, resource, since));
    return Number(row?.total ?? 0);
  }

  /** 查询所有资源的当前用量摘要 */
  getSummary(tenantId: string, sinceMs?: number): Record<string, number> {
    const since = sinceMs ?? (Date.now() - 30 * 24 * 60 * 60 * 1000);
    const rows = this.source.forTenant(tenantId).queryMany(usageQuerySummary(tenantId, since));
    const result: Record<string, number> = {};
    for (const row of rows) {
      result[row.resource] = Number(row.total);
    }
    return result;
  }
}
