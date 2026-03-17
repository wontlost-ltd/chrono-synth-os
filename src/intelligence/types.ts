/**
 * 决策引擎类型定义 — 薄适配器，re-export kernel 领域类型
 */

export type {
  DecisionCase,
  DecisionResult,
  RankedOption,
  Explanation,
  EvidenceItem,
  Counterfactual,
  SimulationRollout,
  SimulationConfig,
} from '@chrono/kernel';
export { DEFAULT_ALTERNATIVES } from '@chrono/kernel';
