import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { RuntimeSyncEvent, RuntimeSyncStateV1, SyncStatusSnapshotV1 } from '@chrono/contracts';
import { createSyncStatusSnapshotFixture } from '@chrono/kernel-testkit';
import { deriveRuntimeSyncState } from '../src/derive-state.js';

function runSequence(
  initial: SyncStatusSnapshotV1,
  events: readonly RuntimeSyncEvent[],
): SyncStatusSnapshotV1 {
  return events.reduce(deriveRuntimeSyncState, initial);
}

describe('deriveRuntimeSyncState', () => {
  const cases: Array<{
    name: string;
    expected: RuntimeSyncStateV1;
    initial: SyncStatusSnapshotV1;
    events: RuntimeSyncEvent[];
  }> = [
    {
      name: 'unconfigured',
      expected: 'unconfigured',
      initial: createSyncStatusSnapshotFixture({ state: 'idle', syncEnabled: true }),
      events: [{ type: 'sync.reset', occurredAt: 1 }],
    },
    {
      name: 'disabled',
      expected: 'disabled',
      initial: createSyncStatusSnapshotFixture(),
      events: [{ type: 'sync.configured', enabled: false, occurredAt: 1 }],
    },
    {
      name: 'idle',
      expected: 'idle',
      initial: createSyncStatusSnapshotFixture(),
      events: [{ type: 'sync.configured', enabled: true, occurredAt: 1 }],
    },
    {
      name: 'pulling',
      expected: 'pulling',
      initial: createSyncStatusSnapshotFixture(),
      events: [
        { type: 'sync.configured', enabled: true, occurredAt: 1 },
        { type: 'sync.started', runId: 'run_pull', occurredAt: 2 },
      ],
    },
    {
      name: 'merging',
      expected: 'merging',
      initial: createSyncStatusSnapshotFixture(),
      events: [
        { type: 'sync.configured', enabled: true, occurredAt: 1 },
        { type: 'sync.started', runId: 'run_merge', occurredAt: 2 },
        { type: 'sync.pull.completed', pendingPullCount: 3, occurredAt: 3 },
      ],
    },
    {
      name: 'pushing',
      expected: 'pushing',
      initial: createSyncStatusSnapshotFixture(),
      events: [
        { type: 'sync.configured', enabled: true, occurredAt: 1 },
        { type: 'sync.started', runId: 'run_push', occurredAt: 2 },
        { type: 'sync.pull.completed', pendingPullCount: 2, occurredAt: 3 },
        { type: 'sync.merge.completed', pendingPushCount: 4, occurredAt: 4 },
      ],
    },
    {
      name: 'paused',
      expected: 'paused',
      initial: createSyncStatusSnapshotFixture({ state: 'idle', syncEnabled: true }),
      events: [{ type: 'sync.paused', occurredAt: 1 }],
    },
    {
      name: 'offline',
      expected: 'offline',
      initial: createSyncStatusSnapshotFixture({ state: 'idle', syncEnabled: true }),
      events: [{ type: 'sync.network.offline', occurredAt: 1 }],
    },
    {
      name: 'conflicted',
      expected: 'conflicted',
      initial: createSyncStatusSnapshotFixture({ state: 'merging', syncEnabled: true }),
      events: [{ type: 'sync.conflict.detected', conflictCount: 2, occurredAt: 1 }],
    },
    {
      name: 'error',
      expected: 'error',
      initial: createSyncStatusSnapshotFixture({ state: 'pushing', syncEnabled: true }),
      events: [
        { type: 'sync.failed', errorCode: 'push_timeout', errorMessage: 'push timed out', occurredAt: 1 },
      ],
    },
  ];

  for (const testCase of cases) {
    it(`derives ${testCase.name}`, () => {
      const next = runSequence(testCase.initial, testCase.events);
      assert.equal(next.state, testCase.expected);
    });
  }

  it('resumes a paused snapshot back to idle when the network is online', () => {
    const initial = createSyncStatusSnapshotFixture({
      state: 'paused',
      syncEnabled: true,
      networkOnline: true,
    });
    const next = deriveRuntimeSyncState(initial, { type: 'sync.resumed', occurredAt: 10 });
    assert.equal(next.state, 'idle');
    assert.equal(next.capabilities.canStartSync, true);
  });

  it('clears conflict counters when a conflict is resolved', () => {
    const initial = createSyncStatusSnapshotFixture({
      state: 'conflicted',
      syncEnabled: true,
      conflictCount: 3,
    });
    const next = deriveRuntimeSyncState(initial, { type: 'sync.conflict.resolved', occurredAt: 20 });
    assert.equal(next.state, 'idle');
    assert.equal(next.conflictCount, 0);
    assert.equal(next.capabilities.canResolveConflict, false);
  });

  it('ignores out-of-order completion events from unconfigured', () => {
    const initial = createSyncStatusSnapshotFixture();
    const next = runSequence(initial, [
      { type: 'sync.pull.completed', pendingPullCount: 2, occurredAt: 1 },
      { type: 'sync.merge.completed', pendingPushCount: 1, occurredAt: 2 },
      { type: 'sync.push.completed', occurredAt: 3 },
    ]);
    assert.equal(next.state, 'unconfigured');
    assert.equal(next.pendingPullCount, 0);
    assert.equal(next.pendingPushCount, 0);
  });

  it('ignores pause when sync is not enabled', () => {
    const initial = createSyncStatusSnapshotFixture();
    const next = deriveRuntimeSyncState(initial, { type: 'sync.paused', occurredAt: 1 });
    assert.equal(next.state, 'unconfigured');
  });

  it('ignores resume unless the snapshot is paused', () => {
    const initial = createSyncStatusSnapshotFixture({
      state: 'conflicted',
      syncEnabled: true,
      conflictCount: 3,
    });
    const next = deriveRuntimeSyncState(initial, { type: 'sync.resumed', occurredAt: 40 });
    assert.equal(next.state, 'conflicted');
    assert.equal(next.conflictCount, 3);
  });

  it('ignores sync.started from conflicted state', () => {
    const initial = createSyncStatusSnapshotFixture({
      state: 'conflicted',
      syncEnabled: true,
      conflictCount: 2,
    });
    const next = deriveRuntimeSyncState(initial, {
      type: 'sync.started',
      runId: 'stale_run',
      occurredAt: 50,
    });
    assert.equal(next.state, 'conflicted');
    assert.equal(next.activeRunId, null);
  });

  it('ignores sync.failed from idle state', () => {
    const initial = createSyncStatusSnapshotFixture({
      state: 'idle',
      syncEnabled: true,
    });
    const next = deriveRuntimeSyncState(initial, {
      type: 'sync.failed',
      errorCode: 'stale',
      occurredAt: 60,
    });
    assert.equal(next.state, 'idle');
    assert.equal(next.lastErrorCode, null);
  });
});
