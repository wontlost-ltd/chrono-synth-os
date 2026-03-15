/**
 * 运行时宿主适配器契约
 * 统一 Node/Web Worker/Tauri/React Native 必须实现的能力接口
 */

import type { DomainEvent } from '../index.js';

/** 时钟适配器 — 同步获取当前时间戳 */
export interface KernelClock {
  now(): number;
}

/** 随机数适配器 — 生成唯一标识 */
export interface KernelRandom {
  uuid(prefix?: string): string;
}

/** 加密适配器 — 全 async 以支持 Web Crypto API 等异步实现 */
export interface KernelCrypto {
  hash(input: string): Promise<string>;
  encrypt(plaintext: string, keyRef: string): Promise<string>;
  decrypt(ciphertext: string): Promise<string>;
}

/** 事件追加结果 */
export interface AppendResult {
  readonly newVersion: number;
}

/** 内核事件 */
export interface KernelEvent {
  readonly type: string;
  readonly payload: Record<string, unknown>;
  readonly occurredAt: number;
}

/** 事件存储适配器 — 基于流的事件溯源 */
export interface KernelEventStore {
  append(streamId: string, events: KernelEvent[], expectedVersion?: number): Promise<AppendResult>;
  load(streamId: string, sinceVersion?: number): Promise<KernelEvent[]>;
}

/** 投影存储适配器 — 读模型持久化 */
export interface KernelProjectionStore {
  read<T>(projection: string, id: string): Promise<T | null>;
  write<T>(projection: string, id: string, value: T, version: number): Promise<void>;
}

/** 日志适配器 — 结构化日志与审计 */
export interface KernelLogger {
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  audit(event: string, fields: Record<string, unknown>): void;
}

/** 领域事件发布器 — 替代 EventEmitter，支持跨运行时 */
export interface EventPublisher {
  publish(events: readonly DomainEvent[]): Promise<void>;
}
