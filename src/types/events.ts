/**
 * 系统事件类型定义
 * 所有层间通信通过事件总线完成
 */

import type { CoreValue, MemoryNode, ActivationResult, ConsolidationResult, WorkingMemorySlot } from './core-self.js';
import type { SurvivalAnchor, DecisionStyle, CognitiveModel } from './personality-os.js';
import type { PersonaVersion, PersonaStatus, SimulationResult } from './persona-version.js';
import type { Conflict, IntegrationProposal, ResourceAllocation } from './meta-regulation.js';
import type { SystemSnapshot, EvolutionDiffReport } from './snapshot.js';
import type { SimulationProgress } from './life-simulation.js';

/** 为事件载荷附加可选 tenantId，用于 WebSocket 租户隔离过滤 */
type TenantTagged<T> = T & { tenantId?: string };

/** 系统事件映射：事件名 → 载荷类型 */
export interface SystemEventMap {
  /* 核心节律层事件 */
  'core:value-updated': TenantTagged<{ value: CoreValue }>;
  'core:memory-added': TenantTagged<{ memory: MemoryNode }>;
  'core:memory-accessed': TenantTagged<{ memoryId: string }>;
  'core:narrative-changed': TenantTagged<{ narrative: string; previousNarrative: string }>;
  'core:survival-updated': TenantTagged<{ anchor: SurvivalAnchor }>;
  'core:decision-style-updated': TenantTagged<{ style: DecisionStyle }>;
  'core:cognitive-model-updated': TenantTagged<{ model: CognitiveModel }>;
  'core:memory-decayed': TenantTagged<{ memoryId: string; oldSalience: number; newSalience: number }>;
  'core:memory-activated': TenantTagged<{ sourceId: string; results: readonly ActivationResult[] }>;
  'core:memory-consolidated': TenantTagged<{ result: ConsolidationResult }>;
  'core:working-memory-updated': TenantTagged<{ slots: readonly WorkingMemorySlot[] }>;

  /* 加速认知层事件 */
  'persona:created': TenantTagged<{ persona: PersonaVersion }>;
  'persona:status-changed': TenantTagged<{ personaId: string; oldStatus: PersonaStatus; newStatus: PersonaStatus }>;
  'persona:simulation-completed': TenantTagged<{ result: SimulationResult }>;

  /* 元调控层事件 */
  'meta:conflict-detected': TenantTagged<{ conflict: Conflict }>;
  'meta:conflict-resolved': TenantTagged<{ conflictId: string; resolution: string }>;
  'meta:resources-allocated': TenantTagged<{ allocations: readonly ResourceAllocation[] }>;
  'meta:integration-proposed': TenantTagged<{ proposal: IntegrationProposal }>;
  'meta:integration-decided': TenantTagged<{ proposalId: string; accepted: boolean }>;

  /* 决策引擎事件 */
  'decision:simulation-progress': TenantTagged<{ caseId: string; runId: string; progress: number; stage: string }>;
  'decision:simulation-completed': TenantTagged<{ caseId: string; runId: string }>;
  'decision:simulation-failed': TenantTagged<{ caseId: string; runId: string; error: string }>;

  /* 引导事件 */
  'onboarding:session-started': TenantTagged<{ sessionId: string }>;
  'onboarding:step-completed': TenantTagged<{ sessionId: string; step: number }>;
  'onboarding:completed': TenantTagged<{ sessionId: string; snapshotId: string }>;

  /* 任务队列事件 */
  'task:completed': TenantTagged<{ taskId: string; result: unknown }>;
  'task:failed': TenantTagged<{ taskId: string; error: string }>;

  /* 人生模拟事件 */
  'life:simulation-progress': TenantTagged<SimulationProgress>;
  'life:path-completed': TenantTagged<{ simulationId: string; pathId: string }>;
  'life:simulation-completed': TenantTagged<{ simulationId: string }>;
  'life:simulation-failed': TenantTagged<{ simulationId: string; error: string }>;

  /* 系统级事件 */
  'system:snapshot-created': TenantTagged<{ snapshot: SystemSnapshot }>;
  'system:snapshot-restored': TenantTagged<{ snapshotId: string }>;
  'system:evolution-completed': TenantTagged<{ mergedVersionIds: readonly string[]; diffReport: EvolutionDiffReport }>;
  'system:patterns-extracted': TenantTagged<{ count: number }>;
  'system:started': TenantTagged<{ timestamp: number }>;
  'system:stopping': TenantTagged<{ timestamp: number }>;
}

/** 事件名称联合类型 */
export type SystemEventName = keyof SystemEventMap;
