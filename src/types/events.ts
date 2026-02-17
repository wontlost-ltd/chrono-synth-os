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

/** 系统事件映射：事件名 → 载荷类型 */
export interface SystemEventMap {
  /* 核心节律层事件 */
  'core:value-updated': { value: CoreValue };
  'core:memory-added': { memory: MemoryNode };
  'core:memory-accessed': { memoryId: string };
  'core:narrative-changed': { narrative: string; previousNarrative: string };
  'core:survival-updated': { anchor: SurvivalAnchor };
  'core:decision-style-updated': { style: DecisionStyle };
  'core:cognitive-model-updated': { model: CognitiveModel };
  'core:memory-decayed': { memoryId: string; oldSalience: number; newSalience: number };
  'core:memory-activated': { sourceId: string; results: readonly ActivationResult[] };
  'core:memory-consolidated': { result: ConsolidationResult };
  'core:working-memory-updated': { slots: readonly WorkingMemorySlot[] };

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

  /* 决策引擎事件 */
  'decision:simulation-progress': { caseId: string; runId: string; progress: number; stage: string };
  'decision:simulation-completed': { caseId: string; runId: string };
  'decision:simulation-failed': { caseId: string; runId: string; error: string };

  /* 引导事件 */
  'onboarding:session-started': { sessionId: string };
  'onboarding:step-completed': { sessionId: string; step: number };
  'onboarding:completed': { sessionId: string; snapshotId: string };

  /* 任务队列事件 */
  'task:completed': { taskId: string; result: unknown };
  'task:failed': { taskId: string; error: string };

  /* 人生模拟事件 */
  'life:simulation-progress': SimulationProgress;
  'life:path-completed': { simulationId: string; pathId: string };
  'life:simulation-completed': { simulationId: string };
  'life:simulation-failed': { simulationId: string; error: string };

  /* 系统级事件 */
  'system:snapshot-created': { snapshot: SystemSnapshot };
  'system:snapshot-restored': { snapshotId: string };
  'system:evolution-completed': { mergedVersionIds: readonly string[]; diffReport: EvolutionDiffReport };
  'system:patterns-extracted': { count: number };
  'system:started': { timestamp: number };
  'system:stopping': { timestamp: number };
}

/** 事件名称联合类型 */
export type SystemEventName = keyof SystemEventMap;
