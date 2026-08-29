/**
 * 运行时中性内存事件总线
 * 不依赖 node:events，可在 Node / Web Worker / Tauri / React Native 任意运行时使用
 */

import type { DomainEvent } from '../index.js';
import type { EventPublisher, EventSubscriber, Unsubscribe } from '../ports/host-adapters.js';

type AnyListener = (event: DomainEvent) => void;

/** 订阅方抛错时的回调（审计 #409）。不注入则异常被静默隔离。 */
export type EventListenerErrorHandler = (event: DomainEvent, err: unknown) => void;

export class MemoryEventBus implements EventPublisher, EventSubscriber {
  private readonly listeners = new Map<string, Set<AnyListener>>();
  private readonly onListenerError?: EventListenerErrorHandler;

  /**
   * @param onListenerError 订阅方抛错时的回调。kernel 是零依赖、运行时中性的，
   *   不能自己 `console.error`（Web Worker / RN 下未必存在），故由宿主注入。
   */
  constructor(onListenerError?: EventListenerErrorHandler) {
    this.onListenerError = onListenerError;
  }

  subscribe<T extends DomainEvent>(
    type: T['type'],
    listener: (event: T) => void,
  ): Unsubscribe {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    const anyListener = listener as AnyListener;
    set.add(anyListener);
    return () => { set!.delete(anyListener); };
  }

  /**
   * 投递事件。**逐监听器隔离异常**（审计 #409）。
   *
   * 此前双重 for 循环无 try/catch：首个抛错的 listener 直接冒泡出 publish，
   * 后续 listener 与**后续所有事件**均不投递。而 `node-unit-of-work.ts:108`
   * 的 `await publish(...)` 位于 **COMMIT 之后** —— 数据已落库，`write()`
   * 却向调用方抛错。
   *
   * 实测后果：某投影器遇脏行抛错 ⇒ 同批的 `wallet.credited` 投影器**从不执行**
   * （钱包投影静默丢失）、审计日志订阅方也不执行；同时路由返回 5xx，
   * 调用方以为写失败而**重试已提交的事务**。
   *
   * 两条设计决定：
   *   ① 隔离到**单个 listener** 粒度——一个订阅方坏掉不影响其它订阅方，也不影响后续事件；
   *   ② **不向上抛**——publish 发生在 COMMIT 之后，此时抛错只会误导调用方
   *      「写失败」进而重试已提交的事务，比丢一条投影更糟。异常交给
   *      `onListenerError` 回调（宿主负责记录/告警），投递本身继续。
   *
   * 同仓 `src/events/typed-event-emitter.ts:41` 对同一关切早已是这个形状；
   * kernel 这个可移植总线此前没跟上，属实现不一致。
   */
  async publish(events: readonly DomainEvent[]): Promise<void> {
    for (const event of events) {
      const set = this.listeners.get(event.type);
      if (!set) continue;
      /* 复制一份再遍历：listener 里若 subscribe/unsubscribe 会改动同一个 Set，
       * 直接迭代原 Set 在部分运行时下行为未定义。 */
      for (const listener of [...set]) {
        try {
          listener(event);
        } catch (err) {
          this.onListenerError?.(event, err);
        }
      }
    }
  }

  listenerCount(type: string): number {
    return this.listeners.get(type)?.size ?? 0;
  }

  clear(): void {
    this.listeners.clear();
  }
}
