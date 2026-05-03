import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RuntimeSyncEventV2Schema } from '../src/sync/runtime-sync-events-v2.js';

describe('RuntimeSyncEventV2Schema', () => {
  const validEvents = [
    { type: 'sync.bootstrap.required', occurredAt: 1 },
    { type: 'sync.bootstrap.completed', ledgerVersion: 1, occurredAt: 1 },
    { type: 'sync.local.changed', pendingPushCount: 1, occurredAt: 1 },
    { type: 'sync.started', runId: 'run-001', occurredAt: 1 },
    { type: 'sync.completed', ledgerVersion: 1, occurredAt: 1 },
    { type: 'sync.network.offline', queueWrites: true, occurredAt: 1 },
    { type: 'sync.network.online', occurredAt: 1 },
    { type: 'sync.conflict.detected', conflictCount: 1, occurredAt: 1 },
    { type: 'sync.conflict.resolved', remainingBlockingCount: 0, occurredAt: 1 },
    { type: 'sync.auth.expired', occurredAt: 1 },
    { type: 'sync.auth.restored', occurredAt: 1 },
    { type: 'sync.remote.degraded', errorCode: 'timeout', occurredAt: 1 },
    { type: 'sync.recovery.required', errorCode: 'corrupt', occurredAt: 1 },
    { type: 'sync.reset', occurredAt: 1 },
  ] as const;

  for (const ev of validEvents) {
    it(`accepts ${ev.type}`, () => {
      assert.equal(RuntimeSyncEventV2Schema.safeParse(ev).success, true);
    });
  }

  it('rejects unknown event type', () => {
    assert.equal(
      RuntimeSyncEventV2Schema.safeParse({ type: 'sync.unknown', occurredAt: 1 }).success,
      false,
    );
  });

  it('rejects unknown fields (strict schema)', () => {
    assert.equal(
      RuntimeSyncEventV2Schema.safeParse({ type: 'sync.reset', occurredAt: 1, extra: true }).success,
      false,
    );
  });

  it('rejects negative timestamps', () => {
    assert.equal(
      RuntimeSyncEventV2Schema.safeParse({ type: 'sync.reset', occurredAt: -1 }).success,
      false,
    );
  });

  const payloadRequired = validEvents.filter(
    (ev) => !['sync.bootstrap.required', 'sync.network.online', 'sync.auth.expired', 'sync.auth.restored', 'sync.reset'].includes(ev.type),
  );

  for (const ev of payloadRequired) {
    it(`${ev.type} rejects missing payload fields`, () => {
      assert.equal(
        RuntimeSyncEventV2Schema.safeParse({ type: ev.type, occurredAt: 1 }).success,
        false,
        `${ev.type} should require payload fields`,
      );
    });
  }
});
