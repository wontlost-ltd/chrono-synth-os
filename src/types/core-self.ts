/**
 * 核心自我（慢层）类型定义
 * 维护稳定的记忆、叙事和核心价值权重
 */

/** 价值维度唯一标识 */
export type ValueId = string;

/** 记忆节点唯一标识 */
export type MemoryId = string;

/** 核心价值项：带权重的价值维度 */
export interface CoreValue {
  readonly id: ValueId;
  readonly label: string;
  /** 0-1 之间的权重，表示该价值在自我中的重要程度 */
  weight: number;
  /** 最后更新时间戳 */
  updatedAt: number;
}

/** 记忆节点类型 */
export type MemoryKind = 'episodic' | 'semantic' | 'procedural';

/** 记忆节点 */
export interface MemoryNode {
  readonly id: MemoryId;
  readonly kind: MemoryKind;
  readonly content: string;
  /** 情感色调 -1（负面）到 1（正面） */
  valence: number;
  /** 重要性 0-1 */
  salience: number;
  readonly createdAt: number;
  lastAccessedAt: number;
}

/** 记忆边：两个记忆节点间的关联 */
export interface MemoryEdge {
  readonly source: MemoryId;
  readonly target: MemoryId;
  /** 关联强度 0-1 */
  strength: number;
  readonly relation: string;
}

/** 核心自我状态快照 */
export interface CoreSelfState {
  readonly values: ReadonlyMap<ValueId, CoreValue>;
  readonly memories: ReadonlyMap<MemoryId, MemoryNode>;
  readonly edges: readonly MemoryEdge[];
  /** 叙事摘要：当前自我认知的文本表示 */
  readonly narrative: string;
  readonly updatedAt: number;
}
