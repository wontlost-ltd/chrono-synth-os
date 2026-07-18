/**
 * Token 预算管理器 — 薄适配器
 * 预算计算委托 kernel 纯函数，DB/Date 操作留在此层
 *
 * 双入口（租户分片 Phase 0，套用 CostTracker/QuotaManager 模式）：
 *   - fromResolver：未绑事务的长期服务（route 注册期）。per-tenant 经
 *     resolver.dbForTenant(tenantId) 选 db。
 *   - fromUnitOfWork：已进事务的调用链（测试 / 内存 db 单库语境）。所有操作固定用该事务，
 *     不重新解析 db（否则脱离事务）。
 * 因 IDatabase extends SyncWriteUnitOfWork，两模式内部统一到 SyncWriteUnitOfWork 接口，无适配层。
 *
 * TokenBudget 是纯读服务：checkBudget/checkAlert/getSummary 经 getUsage 读库；
 * recordUsage 只写内存 cache，不碰 source（红线：纯内存方法不伪路由）。
 */

import type { SyncWriteUnitOfWork } from '@chrono/kernel';
import {
  DEFAULT_TOKEN_BUDGET_CONFIG,
  checkBudget,
  checkAlert,
  computeUsageSummary,
  llmQueryPeriodTotal,
  type TokenBudgetConfig,
  type UsageSnapshot,
} from '@chrono/kernel';
import { registerCoreSelfExecutors } from '../storage/executors/index.js';
import type { TenantDbResolver } from '../storage/tenant-db-resolver.js';

export type { TokenBudgetConfig };

const MAX_CACHE_ENTRIES = 10_000;

interface UsageCache {
  dailyUsed: number;
  monthlyUsed: number;
  cacheDay: string;
  cacheMonth: string;
}

/** 内部 db 取源：resolver 模式按 tenantId 解析；UoW 模式固定 tx。 */
interface MeterSource {
  forTenant(tenantId: string): SyncWriteUnitOfWork;
}

export class TokenBudget {
  private readonly cache = new Map<string, UsageCache>();

  private constructor(
    private readonly config: TokenBudgetConfig,
    private readonly source: MeterSource,
  ) {
    registerCoreSelfExecutors();
  }

  /** resolver 模式：per-tenant→dbForTenant。用于 route 等未绑事务的长期服务。 */
  static fromResolver(config: Partial<TokenBudgetConfig> | undefined, resolver: TenantDbResolver): TokenBudget {
    return new TokenBudget(
      { ...DEFAULT_TOKEN_BUDGET_CONFIG, ...config },
      { forTenant: (t) => resolver.dbForTenant(t) },
    );
  }

  /** bound-UoW 模式：固定用该事务，不重新解析 db。 */
  static fromUnitOfWork(config: Partial<TokenBudgetConfig> | undefined, tx: SyncWriteUnitOfWork): TokenBudget {
    return new TokenBudget(
      { ...DEFAULT_TOKEN_BUDGET_CONFIG, ...config },
      { forTenant: () => tx },
    );
  }

  private getToday(): string {
    return new Date().toISOString().slice(0, 10);
  }

  private getMonth(): string {
    return new Date().toISOString().slice(0, 7);
  }

  private getUsage(tenantId: string): UsageSnapshot {
    const today = this.getToday();
    const month = this.getMonth();

    const cached = this.cache.get(tenantId);
    if (cached && cached.cacheDay === today && cached.cacheMonth === month) {
      return { dailyUsed: cached.dailyUsed, monthlyUsed: cached.monthlyUsed };
    }

    const tx = this.source.forTenant(tenantId);
    const dayStart = new Date(today + 'T00:00:00Z').getTime();
    const monthStart = new Date(month + '-01T00:00:00Z').getTime();

    const monthRow = tx.queryOne(llmQueryPeriodTotal({ tenantId, sinceMs: monthStart }));
    const monthlyUsed = monthRow?.total ?? 0;

    const dayRow = tx.queryOne(llmQueryPeriodTotal({ tenantId, sinceMs: dayStart }));
    const dailyUsed = dayRow?.total ?? 0;

    this.cache.set(tenantId, { dailyUsed, monthlyUsed, cacheDay: today, cacheMonth: month });
    if (this.cache.size > MAX_CACHE_ENTRIES) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey) this.cache.delete(oldestKey);
    }
    return { dailyUsed, monthlyUsed };
  }

  /** 预检查 token 预算是否充足 */
  checkBudget(tenantId: string, estimatedTokens: number): { allowed: boolean; reason?: string } {
    return checkBudget(this.config, this.getUsage(tenantId), estimatedTokens);
  }

  /** 记录实际 token 使用量（更新缓存） */
  recordUsage(tenantId: string, tokens: number): void {
    const today = this.getToday();
    const month = this.getMonth();
    const cached = this.cache.get(tenantId);
    if (cached && cached.cacheDay === today && cached.cacheMonth === month) {
      cached.dailyUsed += tokens;
      cached.monthlyUsed += tokens;
    } else {
      this.cache.delete(tenantId);
    }
  }

  /** 检查是否已触发预警阈值 */
  checkAlert(tenantId: string): { dailyAlert: boolean; monthlyAlert: boolean } {
    return checkAlert(this.config, this.getUsage(tenantId));
  }

  /** 获取租户用量摘要 */
  getSummary(tenantId: string): {
    daily: { used: number; limit: number; percentage: number };
    monthly: { used: number; limit: number; percentage: number };
  } {
    return computeUsageSummary(this.config, this.getUsage(tenantId));
  }
}
