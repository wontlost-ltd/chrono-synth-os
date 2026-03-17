/**
 * 核心自我（慢层）类型定义
 * 维护稳定的记忆、叙事和核心价值权重
 */

import type { SurvivalAnchor, DecisionStyle, CognitiveModel } from './personality-os.js';

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
  /** 时间折扣 0-1，0=只关注当下，1=无长期衰减 */
  timeDiscount: number;
  /** 情绪放大 0.5-2.0，>1 更易受情绪影响，<1 更理性 */
  emotionAmplifier: number;
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
  /** 访问次数 */
  accessCount: number;
  /** 当前衰减速率 λ */
  decayLambda: number;
  /** 上次衰减时间戳 */
  lastDecayedAt: number;
  /** 若为固化产物，指向原始 episodic 记忆 */
  consolidatedFrom: MemoryId | null;
}

/** 记忆边：两个记忆节点间的关联 */
export interface MemoryEdge {
  readonly source: MemoryId;
  readonly target: MemoryId;
  /** 关联强度 0-1 */
  strength: number;
  readonly relation: string;
}

/** 工作记忆槽位 */
export interface WorkingMemorySlot {
  readonly memoryId: MemoryId;
  score: number;
  enteredAt: number;
}

/** 扩散激活结果 */
export interface ActivationResult {
  readonly memoryId: MemoryId;
  readonly delta: number;
  readonly path: readonly MemoryId[];
}

/** 记忆固化结果 */
export interface ConsolidationResult {
  readonly originalId: MemoryId;
  readonly consolidatedId: MemoryId;
  readonly newKind: 'semantic';
}

/** 认知记忆配置 */
export interface MemoryCognitionConfig {
  readonly decay: {
    readonly baseLambda: number;
    readonly valenceWeight: number;
    readonly accessBoost: number;
    readonly kindFactors: Readonly<Record<string, number>>;
  };
  readonly activation: {
    readonly baseActivation: number;
    readonly damping: number;
    readonly maxDepth: number;
  };
  readonly workingMemory: {
    readonly capacity: number;
    readonly recencyDecay: number;
  };
  readonly consolidation: {
    readonly accessThreshold: number;
    readonly minSalience: number;
  };
  readonly eviction: {
    /** 低于此值在衰减时物理删除，0=禁用 */
    readonly salienceFloor: number;
    /** 容量上限，-1=无限 */
    readonly maxMemoryNodes: number;
    /** 达上限后淘汰至此比例 (0.8-0.99) */
    readonly capacityTargetRatio: number;
    /** 固化后删除原始 episodic */
    readonly deleteConsolidatedSources: boolean;
    /** 每批最大删除数 */
    readonly batchSize: number;
  };
}

/** 记忆淘汰结果 */
export interface EvictionResult {
  readonly memoryId: MemoryId;
  readonly reason: 'salience_floor' | 'capacity_overflow' | 'consolidation_cleanup';
  readonly salience: number;
}

/** 核心自我状态快照 */
export interface CoreSelfState {
  readonly values: ReadonlyMap<ValueId, CoreValue>;
  readonly memories: ReadonlyMap<MemoryId, MemoryNode>;
  readonly edges: readonly MemoryEdge[];
  /** 叙事摘要：当前自我认知的文本表示 */
  readonly narrative: string;
  /** P-OS v0.1 扩展层 */
  readonly survivalAnchors: readonly SurvivalAnchor[];
  readonly decisionStyle: DecisionStyle;
  readonly cognitiveModel: CognitiveModel;
  readonly updatedAt: number;
}
