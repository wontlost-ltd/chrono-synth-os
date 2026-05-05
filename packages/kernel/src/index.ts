/**
 * @chrono/kernel — 可移植内核公开接口
 * 零 node:* 依赖，可在 Node/Web Worker/Tauri/React Native 中运行
 */

import type { KernelEventType } from './events/domain-events.js';

/** 租户上下文 — 标识当前操作的租户与操作者 */
export interface TenantScope {
  readonly tenantId: string;
  readonly actorId?: string;
}

/** 领域事件基类型 — type 接受已知事件类型，同时允许扩展 */
export interface DomainEvent {
  readonly type: KernelEventType | (string & {});
  readonly tenantId: string;
  readonly occurredAt: number;
  readonly payload: Record<string, unknown>;
}

/** 旧版 ID 生成器（向后兼容，新代码请使用 KernelRandom） */
export interface KernelIdGenerator {
  next(prefix?: string): string;
}

export type { Query, Command, ExecResult } from './ports/query.js';
export type { ReadUnitOfWork, WriteUnitOfWork, UnitOfWorkFactory } from './ports/unit-of-work.js';
export type {
  KernelClock,
  KernelRandom,
  KernelCrypto,
  AppendResult,
  KernelEvent,
  KernelEventStore,
  KernelProjectionStore,
  KernelLogger,
  EventPublisher,
  EventSubscriber,
  Unsubscribe,
} from './ports/host-adapters.js';
export type { KeyHandle, KeyRotationResult, KeyResolver } from './ports/key-resolver.js';
export type { SyncReadUnitOfWork, SyncWriteUnitOfWork } from './ports/sync-unit-of-work.js';

export * from './domain/identity/index.js';
export * from './domain/persona/index.js';
export * from './domain/core-self/index.js';
export * from './events/index.js';
export * from './domain/errors.js';
export * from './domain/config-metadata.js';
export * from './domain/circuit-breaker.js';
export * from './domain/math.js';
export * from './domain/simulation/index.js';
export * from './domain/intelligence/index.js';
export * from './domain/queue/index.js';
export * from './domain/billing/index.js';
export * from './domain/observability/index.js';
export * from './domain/config/index.js';
export * from './domain/audit/index.js';
export * from './domain/multi-tenant/index.js';
export * from './domain/recovery/index.js';
export * from './domain/meta/index.js';
export * from './domain/enterprise/index.js';
export * from './domain/knowledge/index.js';
export * from './domain/server/index.js';
export * from './domain/conversation/index.js';
export * from './domain/agent/index.js';
