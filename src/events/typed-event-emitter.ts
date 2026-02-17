/**
 * 泛型类型安全事件发射器
 * 包装 node:events，提供编译时事件名和载荷检查
 */

import { EventEmitter } from 'node:events';

/**
 * 类型安全事件发射器
 * TMap: 事件名 → 载荷类型的映射
 */
export class TypedEventEmitter<TMap extends { [K in keyof TMap]: unknown }> {
  private readonly emitter = new EventEmitter();

  on<K extends keyof TMap & string>(
    event: K,
    listener: (payload: TMap[K]) => void,
  ): this {
    this.emitter.on(event, listener as (...args: unknown[]) => void);
    return this;
  }

  once<K extends keyof TMap & string>(
    event: K,
    listener: (payload: TMap[K]) => void,
  ): this {
    this.emitter.once(event, listener as (...args: unknown[]) => void);
    return this;
  }

  off<K extends keyof TMap & string>(
    event: K,
    listener: (payload: TMap[K]) => void,
  ): this {
    this.emitter.off(event, listener as (...args: unknown[]) => void);
    return this;
  }

  emit<K extends keyof TMap & string>(event: K, payload: TMap[K]): boolean {
    return this.emitter.emit(event, payload);
  }

  listenerCount<K extends keyof TMap & string>(event: K): number {
    return this.emitter.listenerCount(event);
  }

  removeAllListeners<K extends keyof TMap & string>(event?: K): this {
    this.emitter.removeAllListeners(event);
    return this;
  }
}
