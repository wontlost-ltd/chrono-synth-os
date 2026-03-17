/**
 * 职业/财务子模型 — 纯领域逻辑
 * 收入增长、储蓄消耗、再就业衰减
 * 零 node:* 依赖
 */

import type { FinanceState } from './types.js';

export interface FinanceConfig {
  /** 基础收入年增长率 */
  readonly baseIncomeGrowth: number;
  /** 离职后再就业概率年衰减 */
  readonly reemploymentDecay: number;
  /** 年支出占收入比 */
  readonly savingsBurnRate: number;
}

export const DEFAULT_FINANCE_CONFIG: FinanceConfig = Object.freeze({
  baseIncomeGrowth: 0.03,
  reemploymentDecay: 0.15,
  savingsBurnRate: 0.7,
});

export interface FinanceInputs {
  readonly branchConditions: Record<string, unknown>;
  readonly stressTest: boolean;
  readonly year: number;
  /** 家庭额外支出（子女教育等） */
  readonly familyExpense: number;
}

/**
 * 计算下一年财务状态（纯函数）
 *
 * 支持初始条件覆盖：branchConditions 可包含:
 * - incomeOverride: 强制收入
 * - incomeMultiplier: 收入乘数（创业失败 = 0，成功 = 2.0 等）
 * - savingsImpact: 一次性储蓄影响（负数 = 投资支出）
 *
 * 压力测试覆盖：冻结收入增长
 */
export function nextFinanceState(
  prev: FinanceState,
  inputs: FinanceInputs,
  config: FinanceConfig,
): FinanceState {
  const { branchConditions, stressTest, familyExpense } = inputs;

  /* 收入计算 */
  let income: number;
  if (typeof branchConditions.incomeOverride === 'number') {
    income = branchConditions.incomeOverride;
  } else {
    const growthRate = stressTest ? 0 : config.baseIncomeGrowth;
    const multiplier = typeof branchConditions.incomeMultiplier === 'number'
      ? branchConditions.incomeMultiplier
      : 1;
    income = prev.income * (1 + growthRate) * multiplier;
  }

  /* 再就业衰减：收入为 0 时，恢复能力逐年下降 */
  if (income <= 0 && typeof branchConditions.unemployedYears === 'number') {
    const unemployedYears = branchConditions.unemployedYears as number;
    const reemployChance = Math.max(0, 1 - config.reemploymentDecay * unemployedYears);
    income = prev.income * reemployChance * 0.8;
  }

  income = Math.max(0, income);

  /* 年支出 = 收入 × 消耗率 + 家庭额外支出 */
  const annualExpense = income * config.savingsBurnRate + familyExpense;

  /* 储蓄 = 收入 - 支出 */
  const netSavings = income - annualExpense;

  /* 一次性储蓄影响（如创业投资） */
  const savingsImpact = typeof branchConditions.savingsImpact === 'number'
    ? branchConditions.savingsImpact
    : 0;

  const savings = prev.savings + netSavings + savingsImpact;

  /* 财富 = 储蓄（简化模型，不考虑投资回报） */
  const wealth = Math.max(0, savings);

  return { income, savings, wealth };
}
