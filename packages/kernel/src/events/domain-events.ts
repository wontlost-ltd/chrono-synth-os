/**
 * 内核领域事件类型枚举
 * 定义所有跨运行时共享的事件类型标识
 */

/** 领域事件类型 */
export type KernelDomainEventType =
  | 'identity.user_created'
  | 'identity.avatar_installed'
  | 'identity.avatar_updated'
  | 'identity.avatar_deactivated'
  | 'persona.created'
  | 'persona.status_changed'
  | 'persona.drift_detected'
  | 'persona.projection_updated'
  | 'persona.transferred'
  | 'persona.deceased'
  | 'memory.node_added'
  | 'memory.node_decayed'
  | 'memory.consolidated'
  | 'memory.evicted'
  | 'task.published'
  | 'task.accepted'
  | 'task.completed'
  | 'task.disputed'
  | 'knowledge.ingested'
  | 'knowledge.updated'
  | 'policy.updated'
  | 'governance.case_opened'
  | 'governance.action_applied'
  | 'governance.case_resolved';

/** 可观测性事件类型 */
export type KernelObservabilityEventType =
  | 'runtime.completed'
  | 'task.outcome'
  | 'wallet.settlement_completed'
  | 'persona.growth_recorded';

/** 所有已知内核事件类型 */
export type KernelEventType =
  | KernelDomainEventType
  | KernelObservabilityEventType;
