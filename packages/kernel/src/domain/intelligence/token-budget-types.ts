/**
 * Token 预算计算 — 纯领域逻辑
 * 预算检查、阈值告警、用量摘要，零 node:* 依赖
 */

/** Token 预算配置 */
export interface TokenBudgetConfig {
  readonly monthlyTokenLimit: number;
  readonly dailyTokenLimit: number;
  readonly alertThreshold: number;
}

export const DEFAULT_TOKEN_BUDGET_CONFIG: TokenBudgetConfig = Object.freeze({
  monthlyTokenLimit: 1_000_000,
  dailyTokenLimit: 100_000,
  alertThreshold: 0.8,
});

/** 用量快照（由外部提供，不依赖 DB） */
export interface UsageSnapshot {
  readonly dailyUsed: number;
  readonly monthlyUsed: number;
}

/** 预算检查结果 */
export interface BudgetCheckResult {
  readonly allowed: boolean;
  readonly reason?: string;
}

/** 用量摘要 */
export interface UsageSummary {
  readonly daily: { readonly used: number; readonly limit: number; readonly percentage: number };
  readonly monthly: { readonly used: number; readonly limit: number; readonly percentage: number };
}

/** 使用率比值（纯函数） */
export function usageRatio(used: number, limit: number): number {
  if (limit <= 0) return used > 0 ? 1 : 0;
  return used / limit;
}

/** 预检查 token 预算是否充足（纯函数） */
export function checkBudget(
  config: TokenBudgetConfig,
  usage: UsageSnapshot,
  estimatedTokens: number,
): BudgetCheckResult {
  if (usage.dailyUsed + estimatedTokens > config.dailyTokenLimit) {
    return { allowed: false, reason: `日度 token 限额已达上限 (${config.dailyTokenLimit})` };
  }
  if (usage.monthlyUsed + estimatedTokens > config.monthlyTokenLimit) {
    return { allowed: false, reason: `月度 token 限额已达上限 (${config.monthlyTokenLimit})` };
  }
  return { allowed: true };
}

/** 检查是否已触发预警阈值（纯函数） */
export function checkAlert(
  config: TokenBudgetConfig,
  usage: UsageSnapshot,
): { dailyAlert: boolean; monthlyAlert: boolean } {
  return {
    dailyAlert: usageRatio(usage.dailyUsed, config.dailyTokenLimit) >= config.alertThreshold,
    monthlyAlert: usageRatio(usage.monthlyUsed, config.monthlyTokenLimit) >= config.alertThreshold,
  };
}

/** 生成用量摘要（纯函数） */
export function computeUsageSummary(
  config: TokenBudgetConfig,
  usage: UsageSnapshot,
): UsageSummary {
  return {
    daily: {
      used: usage.dailyUsed,
      limit: config.dailyTokenLimit,
      percentage: usageRatio(usage.dailyUsed, config.dailyTokenLimit),
    },
    monthly: {
      used: usage.monthlyUsed,
      limit: config.monthlyTokenLimit,
      percentage: usageRatio(usage.monthlyUsed, config.monthlyTokenLimit),
    },
  };
}
