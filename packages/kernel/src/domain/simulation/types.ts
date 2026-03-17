/**
 * 生命模拟状态类型 — 纯领域类型
 * 零 node:* 依赖
 */

export interface EmotionalState {
  readonly valence: number;     // -1..1
  readonly stress: number;      // 0..1
  readonly fulfillment: number; // 0..1
  readonly regret: number;      // 0..1
}

export interface FamilyState {
  readonly spouseSecurity: number;  // 0..1
  readonly childCost: number;       // 绝对值（年支出）
  readonly familyPressure: number;  // 0..1
}

export interface FinanceState {
  readonly income: number;
  readonly savings: number;
  readonly wealth: number;
}
