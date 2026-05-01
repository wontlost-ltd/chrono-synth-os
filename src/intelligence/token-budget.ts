/**
 * Token 预算管理器 — 薄适配器
 * 预算计算委托 kernel 纯函数，DB/Date 操作留在此层
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
import type { IDatabase } from '../storage/database.js';
import { directUnitOfWork } from '../storage/direct-uow-adapter.js';
import { registerCoreSelfExecutors } from '../storage/executors/index.js';

export type { TokenBudgetConfig };

const MAX_CACHE_ENTRIES = 10_000;

interface UsageCache {
  dailyUsed: number;
  monthlyUsed: number;
  cacheDay: string;
  cacheMonth: string;
}

export class TokenBudget {
  private readonly config: TokenBudgetConfig;
  private readonly tx: SyncWriteUnitOfWork | null;
  private readonly cache = new Map<string, UsageCache>();

  constructor(config?: Partial<TokenBudgetConfig>, db?: IDatabase) {
    this.config = { ...DEFAULT_TOKEN_BUDGET_CONFIG, ...config };
    if (db) {
      registerCoreSelfExecutors();
      this.tx = directUnitOfWork(db);
    } else {
      this.tx = null;
    }
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

    let dailyUsed = 0;
    let monthlyUsed = 0;

    if (this.tx) {
      const dayStart = new Date(today + 'T00:00:00Z').getTime();
      const monthStart = new Date(month + '-01T00:00:00Z').getTime();

      const monthRow = this.tx.queryOne(llmQueryPeriodTotal({ tenantId, sinceMs: monthStart }));
      monthlyUsed = monthRow?.total ?? 0;

      const dayRow = this.tx.queryOne(llmQueryPeriodTotal({ tenantId, sinceMs: dayStart }));
      dailyUsed = dayRow?.total ?? 0;
    }

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
