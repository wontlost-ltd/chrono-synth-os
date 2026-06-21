/**
 * 快照与演化记录 — 纯领域类型
 * 零 node:* 依赖
 */

import type { CoreSelfState } from '../core-self/persona-os-types.js';
import type { PersonaVersion } from './persona-version-types.js';
import type { Conflict } from './conflict-types.js';
import type { ResourceAllocation } from './resource-allocator.js';
import type { EvolutionDiffReport } from './evolution-logic.js';

/** 快照唯一标识 */
export type SnapshotId = string;

/** 系统完整状态快照 */
export interface SystemSnapshot {
  readonly id: SnapshotId;
  /**
   * coreSelf 所属的 persona（ADR-0056 K5）。指定时 coreSelf 是该 persona 内核的状态，
   * 回滚也恢复同一 persona（读写对称）。可选以向后兼容旧快照（缺失视为 'default'）。
   */
  readonly personaId?: string;
  readonly coreSelf: CoreSelfState;
  readonly personas: readonly PersonaVersion[];
  readonly activeConflicts: readonly Conflict[];
  readonly allocations: readonly ResourceAllocation[];
  readonly createdAt: number;
  readonly reason: 'scheduled' | 'manual' | 'pre_evolution' | 'shutdown';
}

/** 演化合并记录 */
export interface EvolutionRecord {
  readonly id: string;
  readonly beforeSnapshotId: SnapshotId;
  readonly afterSnapshotId: SnapshotId;
  readonly mergedVersionIds: readonly string[];
  readonly valueDelta: ReadonlyMap<string, number>;
  readonly diffReport?: EvolutionDiffReport;
  readonly evolvedAt: number;
}
