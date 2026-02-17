/**
 * 元调控层类型定义
 * 解决版本冲突、分配资源、集成变更
 */

import type { PersonaVersionId } from './persona-version.js';
import type { ValueId } from './core-self.js';

/** 冲突类型 */
export type ConflictKind = 'value_divergence' | 'resource_contention' | 'narrative_inconsistency';

/** 冲突严重程度 */
export type ConflictSeverity = 'low' | 'medium' | 'high' | 'critical';

/** 冲突记录 */
export interface Conflict {
  readonly id: string;
  readonly kind: ConflictKind;
  readonly severity: ConflictSeverity;
  /** 涉及的人格版本 */
  readonly involvedVersions: readonly PersonaVersionId[];
  /** 涉及的价值维度 */
  readonly affectedValues: readonly ValueId[];
  readonly description: string;
  readonly detectedAt: number;
  resolvedAt?: number;
  resolution?: string;
}

/** 资源分配策略 */
export type AllocationStrategy = 'equal' | 'fitness_weighted' | 'priority_based';

/** 资源分配记录 */
export interface ResourceAllocation {
  readonly versionId: PersonaVersionId;
  /** 分配比例 0-1 */
  readonly quota: number;
  readonly strategy: AllocationStrategy;
  readonly allocatedAt: number;
}

/** 集成提案：将快层实验结果合并到慢层 */
export interface IntegrationProposal {
  readonly id: string;
  readonly sourceVersionId: PersonaVersionId;
  /** 建议的价值权重调整 */
  readonly valueChanges: ReadonlyMap<ValueId, number>;
  /** 建议的叙事更新 */
  readonly narrativeUpdate?: string;
  /** 集成置信度 0-1 */
  readonly confidence: number;
  readonly proposedAt: number;
  accepted?: boolean;
  decidedAt?: number;
}
