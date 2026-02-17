/**
 * P-OS v0.1 五层人格模型类型定义
 * L0 生存锚点 | L1 价值函数(已有) | L2 决策风格 | L3 认知模型 | L4 记忆(已有)
 */

import type { CoreValue, MemoryEdge, MemoryId, MemoryNode, ValueId } from './core-self.js';

/** 生存锚点类型 */
export type SurvivalAnchorKind = 'constraint' | 'threshold' | 'must_have';

/** L0 生存锚点 — 不可轻易修改的底线 */
export interface SurvivalAnchor {
  readonly id: string;
  readonly label: string;
  readonly kind: SurvivalAnchorKind;
  /** 约束值（如风险底线数值、道德禁区描述等） */
  readonly value: unknown;
  /** 严重程度 1-5，越高越难以被覆盖 */
  readonly severity: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** L2 决策风格 — 行为模式参数 */
export interface DecisionStyle {
  /** 风险偏好 0(极保守)-1(极激进) */
  readonly riskAppetite: number;
  /** 时间折扣因子：高=重视长期, 低=重视即时 */
  readonly timeHorizon: number;
  /** 探索/利用系数 0(纯利用)-1(纯探索) */
  readonly explorationBias: number;
  /** 损失厌恶系数 >=1，表示损失比同等收益更痛苦 */
  readonly lossAversion: number;
  /** 审慎程度：信息收集深度 1-5 */
  readonly deliberationDepth: number;
  /** 后悔敏感度 0-1 */
  readonly regretSensitivity: number;
  readonly updatedAt: number;
}

/** L3 认知模型 — 世界观与因果信念 */
export interface CognitiveModel {
  /** 因果信念：key=命题, value=置信度 0-1 */
  readonly beliefs: ReadonlyMap<string, number>;
  /** 认知偏误权重（确认偏误、可得性偏误等） */
  readonly biasWeights: ReadonlyMap<string, number>;
  /** 归因风格：internal(0)-external(1) */
  readonly attributionStyle: number;
  /** 成长心态 vs 固定心态 0-1 */
  readonly growthMindset: number;
  readonly updatedAt: number;
}

/** 完整人格状态（L0-L4） */
export interface PersonaOSState {
  readonly L0: readonly SurvivalAnchor[];
  readonly L1: ReadonlyMap<ValueId, CoreValue>;
  readonly L2: DecisionStyle;
  readonly L3: CognitiveModel;
  readonly L4: {
    readonly memories: ReadonlyMap<MemoryId, MemoryNode>;
    readonly edges: readonly MemoryEdge[];
    readonly narrative: string;
  };
}
