/**
 * 系统事件类型定义
 * 所有层间通信通过事件总线完成
 */

import type { CoreValue, MemoryNode } from './core-self.js';
import type { PersonaVersion, PersonaStatus, SimulationResult } from './persona-version.js';
import type { Conflict, IntegrationProposal, ResourceAllocation } from './meta-regulation.js';
import type { SystemSnapshot } from './snapshot.js';

/** 系统事件映射：事件名 → 载荷类型 */
export interface SystemEventMap {
  /* 核心节律层事件 */
  'core:value-updated': { value: CoreValue };
  'core:memory-added': { memory: MemoryNode };
  'core:memory-accessed': { memoryId: string };
  'core:narrative-changed': { narrative: string; previousNarrative: string };

  /* 加速认知层事件 */
  'persona:created': { persona: PersonaVersion };
  'persona:status-changed': { personaId: string; oldStatus: PersonaStatus; newStatus: PersonaStatus };
  'persona:simulation-completed': { result: SimulationResult };

  /* 元调控层事件 */
  'meta:conflict-detected': { conflict: Conflict };
  'meta:conflict-resolved': { conflictId: string; resolution: string };
  'meta:resources-allocated': { allocations: readonly ResourceAllocation[] };
  'meta:integration-proposed': { proposal: IntegrationProposal };
  'meta:integration-decided': { proposalId: string; accepted: boolean };

  /* 系统级事件 */
  'system:snapshot-created': { snapshot: SystemSnapshot };
  'system:snapshot-restored': { snapshotId: string };
  'system:evolution-completed': { mergedVersionIds: readonly string[] };
  'system:started': { timestamp: number };
  'system:stopping': { timestamp: number };
}

/** 事件名称联合类型 */
export type SystemEventName = keyof SystemEventMap;
