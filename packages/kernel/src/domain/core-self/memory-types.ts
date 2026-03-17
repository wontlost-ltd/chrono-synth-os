/** 认知记忆图领域类型 */

/** 记忆节点唯一标识 */
export type MemoryId = string;

export type MemoryKind = 'episodic' | 'semantic' | 'procedural';

export interface MemoryNode {
  readonly id: MemoryId;
  readonly kind: MemoryKind;
  readonly content: string;
  valence: number;
  salience: number;
  readonly createdAt: number;
  lastAccessedAt: number;
  accessCount: number;
  decayLambda: number;
  lastDecayedAt: number;
  consolidatedFrom: MemoryId | null;
}

export interface MemoryEdge {
  readonly source: MemoryId;
  readonly target: MemoryId;
  strength: number;
  readonly relation: string;
}

export interface WorkingMemorySlot {
  readonly memoryId: MemoryId;
  score: number;
  enteredAt: number;
}

export interface ActivationResult {
  readonly memoryId: MemoryId;
  readonly delta: number;
  readonly path: readonly MemoryId[];
}

export interface ConsolidationResult {
  readonly originalId: MemoryId;
  readonly consolidatedId: MemoryId;
  readonly newKind: 'semantic';
}

export interface EvictionResult {
  readonly memoryId: MemoryId;
  readonly reason: 'salience_floor' | 'capacity_overflow' | 'consolidation_cleanup';
  readonly salience: number;
}

export interface MemoryCognitionConfig {
  readonly decay: {
    readonly baseLambda: number;
    readonly valenceWeight: number;
    readonly accessBoost: number;
    readonly kindFactors: Record<string, number>;
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
    readonly salienceFloor: number;
    readonly maxMemoryNodes: number;
    readonly capacityTargetRatio: number;
    readonly deleteConsolidatedSources: boolean;
    readonly batchSize: number;
  };
}

export const DEFAULT_COGNITION_CONFIG: MemoryCognitionConfig = {
  decay: {
    baseLambda: 0.0001,
    valenceWeight: 0.3,
    accessBoost: 0.5,
    kindFactors: { episodic: 1.0, semantic: 0.5, procedural: 0.3 },
  },
  activation: {
    baseActivation: 0.1,
    damping: 0.5,
    maxDepth: 2,
  },
  workingMemory: {
    capacity: 7,
    recencyDecay: 0.0001,
  },
  consolidation: {
    accessThreshold: 5,
    minSalience: 0.3,
  },
  eviction: {
    salienceFloor: 0.01,
    maxMemoryNodes: 10_000,
    capacityTargetRatio: 0.9,
    deleteConsolidatedSources: true,
    batchSize: 1000,
  },
};

/** 内容加解密端口 — 同步接口 */
export interface ContentEncryptor {
  encrypt(content: string): string;
  decrypt(content: string): string;
}

/** 不加密的默认实现 */
export const NOOP_ENCRYPTOR: ContentEncryptor = {
  encrypt: (c) => c,
  decrypt: (c) => c,
};

/** 深度合并认知配置 */
export function mergeMemoryConfig(
  base: MemoryCognitionConfig,
  override: Partial<MemoryCognitionConfig>,
): MemoryCognitionConfig {
  return {
    decay: { ...base.decay, ...override.decay, kindFactors: { ...base.decay.kindFactors, ...override.decay?.kindFactors } },
    activation: { ...base.activation, ...override.activation },
    workingMemory: { ...base.workingMemory, ...override.workingMemory },
    consolidation: { ...base.consolidation, ...override.consolidation },
    eviction: { ...base.eviction, ...override.eviction },
  };
}
