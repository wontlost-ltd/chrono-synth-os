import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../../events/event-bus.js';
import { NodeEventPublisher } from '../../events/node-event-publisher.js';
import type { DomainEvent } from '@chrono/kernel';

function makeEvent(type: string): DomainEvent {
  return { type, tenantId: 'test', occurredAt: Date.now(), payload: { x: 1 } };
}

describe('NodeEventPublisher', () => {
  it('publish([]) does not throw', async () => {
    const bus = new EventBus();
    const pub = new NodeEventPublisher(bus);
    await assert.doesNotReject(() => pub.publish([]));
  });

  it('publish([event]) calls bus.emit with correct type', async () => {
    const bus = new EventBus();
    let received: unknown = null;
    bus.on('persona.drift_detected' as never, (payload: unknown) => { received = payload; });

    const pub = new NodeEventPublisher(bus);
    const event = makeEvent('persona.drift_detected');
    await pub.publish([event]);

    assert.deepEqual(received, event.payload);
  });

  it('publish multiple events emits each in order', async () => {
    const bus = new EventBus();
    const received: string[] = [];
    bus.on('task.accepted' as never, () => received.push('task.accepted'));
    bus.on('task.completed' as never, () => received.push('task.completed'));

    const pub = new NodeEventPublisher(bus);
    await pub.publish([makeEvent('task.accepted'), makeEvent('task.completed')]);

    assert.deepEqual(received, ['task.accepted', 'task.completed']);
  });
});
