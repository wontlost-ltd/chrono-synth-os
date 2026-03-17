/**
 * P-OS 五层人格模型聚合类型 — 纯领域类型
 * 零 node:* 依赖
 */

import type { ValueId, CoreValue } from './value-types.js';
import type { MemoryId, MemoryNode, MemoryEdge } from './memory-types.js';
import type { SurvivalAnchor } from './anchor-types.js';
import type { DecisionStyle } from './decision-style-types.js';
import type { CognitiveModel } from './cognitive-model-types.js';

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

/** 核心自我状态快照 */
export interface CoreSelfState {
  readonly values: ReadonlyMap<ValueId, CoreValue>;
  readonly memories: ReadonlyMap<MemoryId, MemoryNode>;
  readonly edges: readonly MemoryEdge[];
  readonly narrative: string;
  readonly survivalAnchors: readonly SurvivalAnchor[];
  readonly decisionStyle: DecisionStyle;
  readonly cognitiveModel: CognitiveModel;
  readonly updatedAt: number;
}
