import type { EventPublisher, DomainEvent } from '@chrono/kernel';
import type { EventBus } from './event-bus.js';

export class NodeEventPublisher implements EventPublisher {
  constructor(private readonly bus: EventBus) {}

  async publish(events: readonly DomainEvent[]): Promise<void> {
    for (const event of events) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      this.bus.emit(event.type as any, event.payload as any);
    }
  }
}
