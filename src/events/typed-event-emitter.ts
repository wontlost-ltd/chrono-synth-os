/**
 * 泛型类型安全事件发射器
 * 包装 node:events，提供编译时事件名和载荷检查
 */

import { EventEmitter } from 'node:events';

/**
 * 类型安全事件发射器
 * TMap: 事件名 → 载荷类型的映射
 *
 * 异常隔离（铁律）：node EventEmitter 对普通事件的监听器抛出的异常会同步传播出
 * emit()，导致事件链中断或进程崩溃（仅 'error' 事件有特殊处理）。本类在注册时统一
 * 用 try-catch 包裹每个监听器，使任何单个订阅方的异常都被隔离、不影响其它订阅方，
 * 也不会冒泡出 emit()。异常交给可选的 onError 回调（默认 console.error）。
 *
 * 注册账本：用 `事件 → 注册项[]` 追踪 (原始 listener, 包裹后 guarded) 对，使 off()
 * 能按「事件 + 原始 listener」精确移除对应的包裹函数；同一 listener 跨事件/重复注册
 * 各自独立记账，互不干扰。
 */
export class TypedEventEmitter<TMap extends { [K in keyof TMap]: unknown }> {
  private readonly emitter = new EventEmitter();
  /** 事件 → 注册项列表（每次 on/once 各记一项，guarded 为实际挂到 emitter 的函数） */
  private readonly registry = new Map<string, Array<{ listener: (payload: unknown) => void; guarded: (...args: unknown[]) => void }>>();
  private readonly onError: (event: string, err: unknown) => void;

  constructor(onError?: (event: string, err: unknown) => void) {
    this.onError = onError ?? ((event, err) => {
      // eslint-disable-next-line no-console
      console.error(`[TypedEventEmitter] 监听器在事件 "${event}" 抛出异常，已隔离：`, err);
    });
    /* 防止 node 在无 'error' 监听器时把 error 事件升级为 uncaught 抛出 */
    this.emitter.on('error', (err) => this.onError('error', err));
  }

  /** 构造一个隔离异常的包裹函数（每次注册都新建，闭包捕获正确的 event） */
  private makeGuarded<K extends keyof TMap & string>(
    event: K,
    listener: (payload: TMap[K]) => void,
  ): (...args: unknown[]) => void {
    return (...args: unknown[]): void => {
      try {
        (listener as (payload: unknown) => void)(args[0]);
      } catch (err) {
        this.onError(event, err);
      }
    };
  }

  on<K extends keyof TMap & string>(
    event: K,
    listener: (payload: TMap[K]) => void,
  ): this {
    const guarded = this.makeGuarded(event, listener);
    const entries = this.registry.get(event) ?? [];
    entries.push({ listener: listener as (payload: unknown) => void, guarded });
    this.registry.set(event, entries);
    this.emitter.on(event, guarded);
    return this;
  }

  once<K extends keyof TMap & string>(
    event: K,
    listener: (payload: TMap[K]) => void,
  ): this {
    /* once 包裹在触发后须自动从账本移除，保持 listenerCount 与账本一致 */
    const wrappedOnce = (...args: unknown[]): void => {
      this.removeEntry(event, guarded);
      try {
        (listener as (payload: unknown) => void)(args[0]);
      } catch (err) {
        this.onError(event, err);
      }
    };
    const guarded = wrappedOnce;
    const entries = this.registry.get(event) ?? [];
    entries.push({ listener: listener as (payload: unknown) => void, guarded });
    this.registry.set(event, entries);
    this.emitter.once(event, guarded);
    return this;
  }

  off<K extends keyof TMap & string>(
    event: K,
    listener: (payload: TMap[K]) => void,
  ): this {
    const entries = this.registry.get(event);
    if (entries) {
      /* 移除该事件下匹配此原始 listener 的最早一项（与 node off 单次移除语义一致） */
      const idx = entries.findIndex((e) => e.listener === (listener as (payload: unknown) => void));
      if (idx >= 0) {
        const [removed] = entries.splice(idx, 1);
        this.emitter.off(event, removed!.guarded);
        if (entries.length === 0) this.registry.delete(event);
        return this;
      }
    }
    /* 兜底：账本无记录时按原 listener 直接尝试移除（容错，通常不命中） */
    this.emitter.off(event, listener as (...args: unknown[]) => void);
    return this;
  }

  /** 从账本中按 guarded 移除单项（once 触发后内部调用） */
  private removeEntry(event: string, guarded: (...args: unknown[]) => void): void {
    const entries = this.registry.get(event);
    if (!entries) return;
    const idx = entries.findIndex((e) => e.guarded === guarded);
    if (idx >= 0) {
      entries.splice(idx, 1);
      if (entries.length === 0) this.registry.delete(event);
    }
  }

  emit<K extends keyof TMap & string>(event: K, payload: TMap[K]): boolean {
    return this.emitter.emit(event, payload);
  }

  listenerCount<K extends keyof TMap & string>(event: K): number {
    return this.emitter.listenerCount(event);
  }

  removeAllListeners<K extends keyof TMap & string>(event?: K): this {
    if (event === undefined) {
      this.registry.clear();
    } else {
      this.registry.delete(event);
    }
    this.emitter.removeAllListeners(event);
    return this;
  }
}
