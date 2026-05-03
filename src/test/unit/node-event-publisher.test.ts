import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { NodeEventPublisher } from '../../events/node-event-publisher.js';
import type { DomainEvent } from '@chrono/kernel';

function makeEvent(type: string): DomainEvent {
  return { type, tenantId: 'test', occurredAt: Date.now(), payload: { x: 1 } };
}

describe('NodeEventPublisher', () => {
  it('publish([]) does not throw', async () => {
    const pub = new NodeEventPublisher();
    await assert.doesNotReject(() => pub.publish([]));
  });

  it('subscribe receives published event', async () => {
    const pub = new NodeEventPublisher();
    let received: DomainEvent | undefined;
    pub.subscribe('persona.drift_detected', (event) => { received = event; });

    const event = makeEvent('persona.drift_detected');
    await pub.publish([event]);

    assert.deepEqual(received, event);
  });

  it('publish multiple events dispatches each in order', async () => {
    const pub = new NodeEventPublisher();
    const received: string[] = [];
    pub.subscribe('task.accepted', () => received.push('task.accepted'));
    pub.subscribe('task.completed', () => received.push('task.completed'));

    await pub.publish([makeEvent('task.accepted'), makeEvent('task.completed')]);

    assert.deepEqual(received, ['task.accepted', 'task.completed']);
  });

  it('unsubscribe stops receiving events', async () => {
    const pub = new NodeEventPublisher();
    const received: string[] = [];
    const unsub = pub.subscribe('task.accepted', () => received.push('received'));

    await pub.publish([makeEvent('task.accepted')]);
    unsub();
    await pub.publish([makeEvent('task.accepted')]);

    assert.equal(received.length, 1);
  });
});
