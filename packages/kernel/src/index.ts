/**
 * @chrono/kernel — 可移植内核公开接口
 * 零 node:* 依赖，可在 Node/Web Worker/Tauri/React Native 中运行
 */

/** 租户上下文 — 标识当前操作的租户与操作者 */
export interface TenantScope {
  readonly tenantId: string;
  readonly actorId?: string;
}

/** 领域事件基类型 */
export interface DomainEvent {
  readonly type: string;
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
} from './ports/host-adapters.js';
export type { KeyHandle, KeyRotationResult, KeyResolver } from './ports/key-resolver.js';
