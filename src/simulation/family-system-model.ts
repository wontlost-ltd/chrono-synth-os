/**
 * 家庭系统子模型
 * 纯函数模块：配偶安全感、子女成本、家庭压力
 */

import type { FamilyState } from '../types/life-simulation.js';
import { clamp01 } from '../utils/math.js';

export interface FamilySystemConfig {
  /** 配偶安全感权重（收入稳定对安全感的影响系数） */
  readonly spouseSecurityWeight: number;
  /** 家庭压力放大系数 */
  readonly familyPressureCoefficient: number;
  /** 子女教育成本曲线（按年递增的绝对值数组） */
  readonly childEducationCostCurve: readonly number[];
  /** 连续低收入年数触发恐慌的阈值 */
  readonly timeToPanicThreshold: number;
}

export const DEFAULT_FAMILY_CONFIG: FamilySystemConfig = {
  spouseSecurityWeight: 0.85,
  familyPressureCoefficient: 1.4,
  childEducationCostCurve: [50000, 55000, 60000, 65000, 70000, 75000, 80000, 90000, 100000, 110000],
  timeToPanicThreshold: 2,
};

export interface FamilyInputs {
  readonly year: number;
  readonly wealth: number;
  readonly income: number;
  readonly stress: number;
  /** 连续低收入年数（income < 上一年 income 的 70%） */
  readonly lowIncomeYears: number;
}

/**
 * 计算下一年家庭状态
 *
 * spouseSecurity = f(income 稳定性, wealth 安全垫, 恐慌阈值)
 * childCost = 教育成本曲线插值
 * familyPressure = (1 - spouseSecurity) × 压力系数
 */
export function computeFamilyState(
  prev: FamilyState,
  inputs: FamilyInputs,
  config: FamilySystemConfig,
): FamilyState {
  /* 收入安全指标：wealth 覆盖多少年支出 */
  const annualExpense = Math.max(inputs.income * 0.7, 1);
  const wealthCover = Math.min(inputs.wealth / annualExpense, 5) / 5; // 0..1, 5年为满分

  /* 恐慌衰减：连续低收入年数越多，安全感越低 */
  const panicFactor = inputs.lowIncomeYears >= config.timeToPanicThreshold
    ? 0.3
    : 1 - (inputs.lowIncomeYears / config.timeToPanicThreshold) * 0.7;

  /* 配偶安全感 = 财富覆盖 × 恐慌因子，带惯性（保留上一年 40%） */
  const rawSecurity = wealthCover * panicFactor * config.spouseSecurityWeight;
  const spouseSecurity = clamp01(prev.spouseSecurity * 0.4 + rawSecurity * 0.6);

  /* 子女成本：按年索引取值，超出曲线长度则取最后一个 */
  const curveIndex = Math.min(inputs.year - 1, config.childEducationCostCurve.length - 1);
  const childCost = config.childEducationCostCurve[curveIndex] ?? 0;

  /* 家庭压力 = (1 - 安全感) × 压力系数 + 外部压力影响 */
  const familyPressure = clamp01(
    (1 - spouseSecurity) * config.familyPressureCoefficient * 0.5 + inputs.stress * 0.3,
  );

  return { spouseSecurity, childCost, familyPressure };
}
