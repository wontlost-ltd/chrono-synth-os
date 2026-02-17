/**
 * 快照与恢复类型定义
 * 处理系统关机/断电后的状态恢复
 */

import type { CoreSelfState } from './core-self.js';
import type { PersonaVersion } from './persona-version.js';
import type { Conflict, ResourceAllocation } from './meta-regulation.js';

/** 快照唯一标识 */
export type SnapshotId = string;

/** 系统完整状态快照 */
export interface SystemSnapshot {
  readonly id: SnapshotId;
  readonly coreSelf: CoreSelfState;
  readonly personas: readonly PersonaVersion[];
  readonly activeConflicts: readonly Conflict[];
  readonly allocations: readonly ResourceAllocation[];
  readonly createdAt: number;
  /** 快照触发原因 */
  readonly reason: 'scheduled' | 'manual' | 'pre_evolution' | 'shutdown';
}

/** 演化合并记录 */
export interface EvolutionRecord {
  readonly id: string;
  /** 演化前快照 */
  readonly beforeSnapshotId: SnapshotId;
  /** 演化后快照 */
  readonly afterSnapshotId: SnapshotId;
  /** 合并的人格版本 */
  readonly mergedVersionIds: readonly string[];
  /** 价值权重变化摘要 */
  readonly valueDelta: ReadonlyMap<string, number>;
  readonly evolvedAt: number;
}
