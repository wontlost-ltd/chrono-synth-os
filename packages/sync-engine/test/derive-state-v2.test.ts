import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type {
  RuntimeSyncEventV2,
  RuntimeSyncStateV2,
  SyncStatusSnapshotV1,
  SyncStatusSnapshotV2,
} from '@chrono/contracts';
import { deriveRuntimeSyncStateV2, mapV1ToV2Snapshot } from '../src/derive-state-v2.js';

function fixture(overrides: Partial<SyncStatusSnapshotV2> = {}): SyncStatusSnapshotV2 {
  return {
    schemaVersion: 2,
    state: 'initial_sync',
    tenantId: 'tenant-001',
    runtimeId: 'runtime-001',
    networkOnline: true,
    authValid: true,
    remoteReachable: true,
    localWritable: true,
    pendingPushCount: 0,
    pendingPullCount: 0,
    conflictCount: 0,
    activeRunId: null,
    lastSyncedLedgerVersion: null,
    localHighWatermark: 0,
    lastErrorCode: null,
    ...overrides,
  };
}

describe('deriveRuntimeSyncStateV2', () => {
  const transitions: Array<{
    name: string;
    initial: SyncStatusSnapshotV2;
    event: RuntimeSyncEventV2;
    expected: RuntimeSyncStateV2;
  }> = [
    {
      name: 'initial_sync + bootstrap.completed -> online_synced',
      initial: fixture({ state: 'initial_sync' }),
      event: { type: 'sync.bootstrap.completed', ledgerVersion: 10, occurredAt: 1 },
      expected: 'online_synced',
    },
    {
      name: 'initial_sync + network.offline localWritable=true queueWrites=true -> offline_queueing',
      initial: fixture({ state: 'initial_sync', localWritable: true }),
      event: { type: 'sync.network.offline', queueWrites: true, occurredAt: 1 },
      expected: 'offline_queueing',
    },
    {
      name: 'initial_sync + network.offline localWritable=false -> offline_readonly',
      initial: fixture({ state: 'initial_sync', localWritable: false }),
      event: { type: 'sync.network.offline', queueWrites: true, occurredAt: 1 },
      expected: 'offline_readonly',
    },
    {
      name: 'online_synced + local.changed pending=2 -> online_dirty',
      initial: fixture({ state: 'online_synced' }),
      event: { type: 'sync.local.changed', pendingPushCount: 2, occurredAt: 1 },
      expected: 'online_dirty',
    },
    {
      name: 'online_dirty + sync.started -> syncing',
      initial: fixture({ state: 'online_dirty', pendingPushCount: 2 }),
      event: { type: 'sync.started', runId: 'run-001', occurredAt: 1 },
      expected: 'syncing',
    },
    {
      name: 'syncing + sync.completed no conflicts -> online_synced',
      initial: fixture({ state: 'syncing', activeRunId: 'run-001' }),
      event: { type: 'sync.completed', ledgerVersion: 11, occurredAt: 1 },
      expected: 'online_synced',
    },
    {
      name: 'syncing + conflict.detected -> conflict_inbox',
      initial: fixture({ state: 'syncing', activeRunId: 'run-001' }),
      event: { type: 'sync.conflict.detected', conflictCount: 1, occurredAt: 1 },
      expected: 'conflict_inbox',
    },
    {
      name: 'syncing + remote.degraded -> degraded_remote',
      initial: fixture({ state: 'syncing', activeRunId: 'run-001' }),
      event: { type: 'sync.remote.degraded', errorCode: 'timeout', occurredAt: 1 },
      expected: 'degraded_remote',
    },
    {
      name: 'syncing + auth.expired -> reauth_required',
      initial: fixture({ state: 'syncing', activeRunId: 'run-001' }),
      event: { type: 'sync.auth.expired', occurredAt: 1 },
      expected: 'reauth_required',
    },
    {
      name: 'syncing + recovery.required -> recovery_required',
      initial: fixture({ state: 'syncing', activeRunId: 'run-001' }),
      event: { type: 'sync.recovery.required', errorCode: 'corrupt', occurredAt: 1 },
      expected: 'recovery_required',
    },
    {
      name: 'offline_queueing + network.online pending=0 -> online_synced',
      initial: fixture({ state: 'offline_queueing', networkOnline: false, pendingPushCount: 0 }),
      event: { type: 'sync.network.online', occurredAt: 1 },
      expected: 'online_synced',
    },
    {
      name: 'offline_queueing + network.online pending>0 -> online_dirty',
      initial: fixture({ state: 'offline_queueing', networkOnline: false, pendingPushCount: 2 }),
      event: { type: 'sync.network.online', occurredAt: 1 },
      expected: 'online_dirty',
    },
    {
      name: 'offline_readonly + network.online -> online_synced',
      initial: fixture({ state: 'offline_readonly', networkOnline: false }),
      event: { type: 'sync.network.online', occurredAt: 1 },
      expected: 'online_synced',
    },
    {
      name: 'conflict_inbox + conflict.resolved remaining=0 pending=2 -> online_dirty',
      initial: fixture({ state: 'conflict_inbox', conflictCount: 1, pendingPushCount: 2 }),
      event: { type: 'sync.conflict.resolved', remainingBlockingCount: 0, occurredAt: 1 },
      expected: 'online_dirty',
    },
    {
      name: 'conflict_inbox + conflict.resolved remaining=0 pending=0 -> online_synced',
      initial: fixture({ state: 'conflict_inbox', conflictCount: 1, pendingPushCount: 0 }),
      event: { type: 'sync.conflict.resolved', remainingBlockingCount: 0, occurredAt: 1 },
      expected: 'online_synced',
    },
    {
      name: 'degraded_remote + sync.started -> syncing',
      initial: fixture({ state: 'degraded_remote', remoteReachable: false }),
      event: { type: 'sync.started', runId: 'run-002', occurredAt: 1 },
      expected: 'syncing',
    },
    {
      name: 'reauth_required + auth.restored pending=2 -> online_dirty',
      initial: fixture({ state: 'reauth_required', authValid: false, pendingPushCount: 2 }),
      event: { type: 'sync.auth.restored', occurredAt: 1 },
      expected: 'online_dirty',
    },
    {
      name: 'reauth_required + auth.restored pending=0 -> online_synced',
      initial: fixture({ state: 'reauth_required', authValid: false, pendingPushCount: 0 }),
      event: { type: 'sync.auth.restored', occurredAt: 1 },
      expected: 'online_synced',
    },
    {
      name: 'recovery_required + reset -> initial_sync',
      initial: fixture({ state: 'recovery_required', lastErrorCode: 'corrupt' }),
      event: { type: 'sync.reset', occurredAt: 1 },
      expected: 'initial_sync',
    },
  ];

  for (const tc of transitions) {
    it(tc.name, () => {
      const next = deriveRuntimeSyncStateV2(tc.initial, tc.event);
      assert.equal(next.state, tc.expected);
    });
  }

  it('network.offline from online_dirty -> offline_queueing (online state coverage)', () => {
    const initial = fixture({ state: 'online_dirty', pendingPushCount: 2, localWritable: true });
    const next = deriveRuntimeSyncStateV2(initial, { type: 'sync.network.offline', queueWrites: true, occurredAt: 1 });
    assert.equal(next.state, 'offline_queueing');
    assert.equal(next.networkOnline, false);
  });

  it('invalid: online_synced + sync.completed is no-op', () => {
    const initial = fixture({ state: 'online_synced' });
    const next = deriveRuntimeSyncStateV2(initial, { type: 'sync.completed', ledgerVersion: 5, occurredAt: 1 });
    assert.deepEqual(next, initial);
  });

  it('invalid: online_synced + sync.started is no-op', () => {
    const initial = fixture({ state: 'online_synced' });
    const next = deriveRuntimeSyncStateV2(initial, { type: 'sync.started', runId: 'bad', occurredAt: 1 });
    assert.deepEqual(next, initial);
  });

  it('invalid: conflict_inbox + conflict.resolved with remaining>0 is no-op', () => {
    const initial = fixture({ state: 'conflict_inbox', conflictCount: 2 });
    const next = deriveRuntimeSyncStateV2(initial, { type: 'sync.conflict.resolved', remainingBlockingCount: 1, occurredAt: 1 });
    assert.deepEqual(next, initial);
  });
});

describe('mapV1ToV2Snapshot', () => {
  function v1Fixture(overrides: Partial<SyncStatusSnapshotV1> = {}): SyncStatusSnapshotV1 {
    return {
      schemaVersion: 1,
      state: 'idle',
      capabilities: {
        canConfigure: false,
        canStartSync: true,
        canPause: true,
        canResume: false,
        canResolveConflict: false,
        canRetry: false,
        canDisable: true,
      },
      syncEnabled: true,
      networkOnline: true,
      pendingPullCount: 0,
      pendingPushCount: 0,
      conflictCount: 0,
      lastSyncStartedAt: null,
      lastSyncCompletedAt: null,
      lastErrorCode: null,
      lastErrorMessage: null,
      activeRunId: null,
      ...overrides,
    };
  }

  it('idle -> online_synced', () => {
    assert.equal(mapV1ToV2Snapshot(v1Fixture({ state: 'idle' })).state, 'online_synced');
  });

  it('pushing -> syncing', () => {
    const snap = mapV1ToV2Snapshot(v1Fixture({ state: 'pushing', activeRunId: 'run-001' }));
    assert.equal(snap.state, 'syncing');
    assert.equal(snap.activeRunId, 'run-001');
  });

  it('conflicted -> conflict_inbox', () => {
    const snap = mapV1ToV2Snapshot(v1Fixture({ state: 'conflicted', conflictCount: 2 }));
    assert.equal(snap.state, 'conflict_inbox');
    assert.equal(snap.conflictCount, 2);
  });

  it('offline with pending -> offline_queueing', () => {
    assert.equal(
      mapV1ToV2Snapshot(v1Fixture({ state: 'offline', networkOnline: false, pendingPushCount: 3 })).state,
      'offline_queueing',
    );
  });

  it('offline with no pending -> offline_readonly', () => {
    assert.equal(
      mapV1ToV2Snapshot(v1Fixture({ state: 'offline', networkOnline: false, pendingPushCount: 0 })).state,
      'offline_readonly',
    );
  });
});
