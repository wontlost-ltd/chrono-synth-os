/**
 * Token 预算管理器
 * 按租户配置月度/日度 LLM token 使用限额
 * 从 llm_usage 表读取实际用量（有 DB 时），内存缓存加速热路径
 */

import type { IDatabase } from '../storage/database.js';

export interface TokenBudgetConfig {
  readonly monthlyTokenLimit: number;
  readonly dailyTokenLimit: number;
  readonly alertThreshold: number;
}

const DEFAULT_CONFIG: TokenBudgetConfig = {
  monthlyTokenLimit: 1_000_000,
  dailyTokenLimit: 100_000,
  alertThreshold: 0.8,
};

const MAX_CACHE_ENTRIES = 10_000;

interface UsageCache {
  dailyUsed: number;
  monthlyUsed: number;
  cacheDay: string;
  cacheMonth: string;
}

export class TokenBudget {
  private readonly config: TokenBudgetConfig;
  private readonly db: IDatabase | null;
  private readonly cache = new Map<string, UsageCache>();

  constructor(config?: Partial<TokenBudgetConfig>, db?: IDatabase) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.db = db ?? null;
  }

  private getToday(): string {
    return new Date().toISOString().slice(0, 10);
  }

  private getMonth(): string {
    return new Date().toISOString().slice(0, 7);
  }

  private getUsage(tenantId: string): { dailyUsed: number; monthlyUsed: number } {
    const today = this.getToday();
    const month = this.getMonth();

    const cached = this.cache.get(tenantId);
    if (cached && cached.cacheDay === today && cached.cacheMonth === month) {
      return { dailyUsed: cached.dailyUsed, monthlyUsed: cached.monthlyUsed };
    }

    let dailyUsed = 0;
    let monthlyUsed = 0;

    if (this.db) {
      const dayStart = new Date(today + 'T00:00:00Z').getTime();
      const monthStart = new Date(month + '-01T00:00:00Z').getTime();

      const monthRow = this.db.prepare<{ total: number }>(
        'SELECT COALESCE(SUM(total_tokens), 0) AS total FROM llm_usage WHERE tenant_id = ? AND recorded_at >= ?',
      ).get(tenantId, monthStart);
      monthlyUsed = monthRow?.total ?? 0;

      const dayRow = this.db.prepare<{ total: number }>(
        'SELECT COALESCE(SUM(total_tokens), 0) AS total FROM llm_usage WHERE tenant_id = ? AND recorded_at >= ?',
      ).get(tenantId, dayStart);
      dailyUsed = dayRow?.total ?? 0;
    }

    this.cache.set(tenantId, { dailyUsed, monthlyUsed, cacheDay: today, cacheMonth: month });
    if (this.cache.size > MAX_CACHE_ENTRIES) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey) this.cache.delete(oldestKey);
    }
    return { dailyUsed, monthlyUsed };
  }

  private ratio(used: number, limit: number): number {
    if (limit <= 0) return used > 0 ? 1 : 0;
    return used / limit;
  }

  /** 预检查 token 预算是否充足 */
  checkBudget(tenantId: string, estimatedTokens: number): { allowed: boolean; reason?: string } {
    const usage = this.getUsage(tenantId);

    if (usage.dailyUsed + estimatedTokens > this.config.dailyTokenLimit) {
      return { allowed: false, reason: `日度 token 限额已达上限 (${this.config.dailyTokenLimit})` };
    }
    if (usage.monthlyUsed + estimatedTokens > this.config.monthlyTokenLimit) {
      return { allowed: false, reason: `月度 token 限额已达上限 (${this.config.monthlyTokenLimit})` };
    }

    return { allowed: true };
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
    const usage = this.getUsage(tenantId);
    return {
      dailyAlert: this.ratio(usage.dailyUsed, this.config.dailyTokenLimit) >= this.config.alertThreshold,
      monthlyAlert: this.ratio(usage.monthlyUsed, this.config.monthlyTokenLimit) >= this.config.alertThreshold,
    };
  }

  /** 获取租户用量摘要 */
  getSummary(tenantId: string): {
    daily: { used: number; limit: number; percentage: number };
    monthly: { used: number; limit: number; percentage: number };
  } {
    const usage = this.getUsage(tenantId);
    return {
      daily: {
        used: usage.dailyUsed,
        limit: this.config.dailyTokenLimit,
        percentage: this.ratio(usage.dailyUsed, this.config.dailyTokenLimit),
      },
      monthly: {
        used: usage.monthlyUsed,
        limit: this.config.monthlyTokenLimit,
        percentage: this.ratio(usage.monthlyUsed, this.config.monthlyTokenLimit),
      },
    };
  }
}
