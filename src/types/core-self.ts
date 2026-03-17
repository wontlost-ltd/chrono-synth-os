/**
 * 核心自我类型定义 — 薄适配器，re-export kernel 领域类型
 */

export type { ValueId, CoreValue } from '@chrono/kernel';
export type {
  MemoryId,
  MemoryKind,
  MemoryNode,
  MemoryEdge,
  WorkingMemorySlot,
  ActivationResult,
  ConsolidationResult,
  MemoryCognitionConfig,
  EvictionResult,
} from '@chrono/kernel';
export type { CoreSelfState } from '@chrono/kernel';
