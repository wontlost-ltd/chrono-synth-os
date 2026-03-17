/**
 * 生命模拟引擎类型 — 纯领域类型
 * 零 node:* 依赖
 */

import type { EmotionalState, FamilyState } from './types.js';
import type { CoreValue } from '../core-self/value-types.js';
import type { DecisionStyle } from '../core-self/decision-style-types.js';
import type { CognitiveModel } from '../core-self/cognitive-model-types.js';
import type { SurvivalAnchor } from '../core-self/anchor-types.js';

/** 模拟引擎所需的人格状态（仅 L0-L3，不含 L4 记忆图） */
export interface SimulationPersonaState {
  readonly L0: readonly SurvivalAnchor[];
  readonly L1: ReadonlyMap<string, CoreValue>;
  readonly L2: DecisionStyle;
  readonly L3: CognitiveModel;
}

/** 年度状态快照 */
export interface YearState {
  readonly year: number;
  readonly wealth: number;
  readonly emotionalState: EmotionalState;
  readonly familyState: FamilyState;
  readonly healthIndex: number;
  readonly overallScore: number;
  readonly valueWeights: Record<string, number>;
}

/** 路径内分支定义 */
export interface LifePathBranch {
  readonly label: string;
  readonly probability: number;
  readonly conditions: Record<string, unknown>;
}

/** 路径定义 */
export interface LifePath {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly initialConditions: Record<string, unknown>;
  readonly branches: readonly LifePathBranch[];
}

/** 压力测试配置 */
export interface StressTestConfig {
  readonly enabled: boolean;
  readonly incomeFreezeYears: number;
  readonly marketDownturnFactor: number;
  readonly healthShock: number;
}

/** 模拟配置 */
export interface LifeSimulationConfig {
  readonly horizonYears: number;
  readonly paths: readonly LifePath[];
  readonly stressTestConfig?: StressTestConfig;
  readonly age?: number;
}

/** 分支结果 */
export interface BranchResult {
  readonly label: string;
  readonly probability: number;
  readonly timeline: readonly YearState[];
  readonly compositeScore: number;
}

/** 回顾式评估 */
export interface RetrospectiveScore {
  readonly summary: string;
  readonly confidence: number;
  readonly regretByPath: Record<string, number>;
}

/** 路径结果 */
export interface LifePathResult {
  readonly pathId: string;
  readonly label: string;
  readonly timeline: readonly YearState[];
  readonly branches: readonly BranchResult[];
  readonly compositeScore: number;
  readonly regretProbability: number;
}

/** 模拟结果 */
export interface LifeSimulationResult {
  readonly simulationId: string;
  readonly paths: readonly LifePathResult[];
  readonly retrospective: RetrospectiveScore;
  readonly recommendedPathId: string;
  readonly completedAt: number;
}

/** 模拟进度 */
export interface SimulationProgress {
  readonly simulationId: string;
  readonly pathId: string;
  readonly year: number;
  readonly percent: number;
  readonly stage: string;
}
