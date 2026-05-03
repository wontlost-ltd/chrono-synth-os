/**
 * 运行时中性内存事件总线
 * 不依赖 node:events，可在 Node / Web Worker / Tauri / React Native 任意运行时使用
 */

import type { DomainEvent } from '../index.js';
import type { EventPublisher, EventSubscriber, Unsubscribe } from '../ports/host-adapters.js';

type AnyListener = (event: DomainEvent) => void;

export class MemoryEventBus implements EventPublisher, EventSubscriber {
  private readonly listeners = new Map<string, Set<AnyListener>>();

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

  async publish(events: readonly DomainEvent[]): Promise<void> {
    for (const event of events) {
      const set = this.listeners.get(event.type);
      if (set) {
        for (const listener of set) {
          listener(event);
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
