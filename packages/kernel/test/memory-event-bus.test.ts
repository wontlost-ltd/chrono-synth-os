import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryEventBus } from '../src/events/memory-event-bus.js';
import type { DomainEvent } from '../src/index.js';

function makeEvent(type: string): DomainEvent {
  return { type, tenantId: 'test', occurredAt: 1, payload: {} };
}

describe('MemoryEventBus', () => {
  it('dispatches to subscribed listener', async () => {
    const bus = new MemoryEventBus();
    let received: DomainEvent | undefined;
    bus.subscribe('task.accepted', (e) => { received = e; });

    const event = makeEvent('task.accepted');
    await bus.publish([event]);

    assert.deepEqual(received, event);
  });

  it('does not dispatch to listener for different type', async () => {
    const bus = new MemoryEventBus();
    let received = false;
    bus.subscribe('task.accepted', () => { received = true; });
    await bus.publish([makeEvent('task.completed')]);
    assert.equal(received, false);
  });

  it('unsubscribe stops receiving events', async () => {
    const bus = new MemoryEventBus();
    const received: number[] = [];
    const unsub = bus.subscribe('task.accepted', () => received.push(1));

    await bus.publish([makeEvent('task.accepted')]);
    unsub();
    await bus.publish([makeEvent('task.accepted')]);

    assert.equal(received.length, 1);
  });

  it('multiple listeners for same type all fire', async () => {
    const bus = new MemoryEventBus();
    const received: string[] = [];
    bus.subscribe('task.accepted', () => received.push('a'));
    bus.subscribe('task.accepted', () => received.push('b'));

    await bus.publish([makeEvent('task.accepted')]);

    assert.equal(received.length, 2);
  });

  it('publishes multiple events in order', async () => {
    const bus = new MemoryEventBus();
    const order: string[] = [];
    bus.subscribe('task.accepted', () => order.push('accepted'));
    bus.subscribe('task.completed', () => order.push('completed'));

    await bus.publish([makeEvent('task.accepted'), makeEvent('task.completed')]);

    assert.deepEqual(order, ['accepted', 'completed']);
  });

  it('listenerCount reflects current subscribers', () => {
    const bus = new MemoryEventBus();
    assert.equal(bus.listenerCount('task.accepted'), 0);
    const unsub = bus.subscribe('task.accepted', () => {});
    assert.equal(bus.listenerCount('task.accepted'), 1);
    unsub();
    assert.equal(bus.listenerCount('task.accepted'), 0);
  });

  it('clear() removes all listeners', async () => {
    const bus = new MemoryEventBus();
    let fired = false;
    bus.subscribe('task.accepted', () => { fired = true; });
    bus.clear();
    await bus.publish([makeEvent('task.accepted')]);
    assert.equal(fired, false);
  });
});
