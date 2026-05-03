import type { DomainEvent, EventPublisher, EventSubscriber, Unsubscribe } from '@chrono/kernel';
import { MemoryEventBus } from '@chrono/kernel';

/**
 * Node 运行时事件发布适配器
 * 使用 kernel MemoryEventBus，不依赖 node:events，无 as any 类型转换
 */
export class NodeEventPublisher implements EventPublisher, EventSubscriber {
  private readonly bus = new MemoryEventBus();

  async publish(events: readonly DomainEvent[]): Promise<void> {
    await this.bus.publish(events);
  }

  subscribe<T extends DomainEvent>(
    type: T['type'],
    listener: (event: T) => void,
  ): Unsubscribe {
    return this.bus.subscribe(type, listener);
  }
}
