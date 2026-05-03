import {
  RuntimeSyncEventV2Schema,
  SyncStatusSnapshotV2Schema,
  type RuntimeSyncEventV2,
  type RuntimeSyncStateV1,
  type RuntimeSyncStateV2,
  type SyncStatusSnapshotV1,
  type SyncStatusSnapshotV2,
} from '@chrono/contracts';

const ONLINE_STATES: ReadonlySet<RuntimeSyncStateV2> = new Set([
  'online_synced',
  'online_dirty',
  'syncing',
  'conflict_inbox',
  'degraded_remote',
  'reauth_required',
]);

function finalize(draft: SyncStatusSnapshotV2): SyncStatusSnapshotV2 {
  return SyncStatusSnapshotV2Schema.parse(draft);
}

function mapV1State(v1: RuntimeSyncStateV1, pendingPushCount: number): RuntimeSyncStateV2 {
  switch (v1) {
    case 'idle': return 'online_synced';
    case 'pulling':
    case 'merging':
    case 'pushing': return 'syncing';
    case 'offline': return pendingPushCount > 0 ? 'offline_queueing' : 'offline_readonly';
    case 'conflicted': return 'conflict_inbox';
    case 'error': return 'degraded_remote';
    case 'unconfigured':
    case 'disabled':
    case 'paused': return 'initial_sync';
  }
}

export function mapV1ToV2Snapshot(v1: SyncStatusSnapshotV1): SyncStatusSnapshotV2 {
  return SyncStatusSnapshotV2Schema.parse({
    schemaVersion: 2,
    state: mapV1State(v1.state, v1.pendingPushCount),
    tenantId: 'legacy-tenant',
    runtimeId: 'legacy-runtime',
    networkOnline: v1.networkOnline,
    authValid: v1.state !== 'disabled' && v1.state !== 'unconfigured',
    remoteReachable: v1.networkOnline && v1.state !== 'error',
    localWritable: v1.state !== 'disabled' && v1.state !== 'unconfigured',
    pendingPushCount: v1.pendingPushCount,
    pendingPullCount: v1.pendingPullCount,
    conflictCount: v1.conflictCount,
    activeRunId: v1.activeRunId,
    lastSyncedLedgerVersion: null,
    localHighWatermark: 0,
    lastErrorCode: v1.lastErrorCode,
  });
}

export function deriveRuntimeSyncStateV2(
  snapshot: SyncStatusSnapshotV2,
  event: RuntimeSyncEventV2,
): SyncStatusSnapshotV2 {
  const current = SyncStatusSnapshotV2Schema.parse(snapshot);
  const ev = RuntimeSyncEventV2Schema.parse(event);

  switch (ev.type) {
    case 'sync.bootstrap.required':
      return finalize(current);

    case 'sync.bootstrap.completed':
      if (current.state !== 'initial_sync') return finalize(current);
      return finalize({
        ...current,
        state: 'online_synced',
        networkOnline: true,
        remoteReachable: true,
        pendingPullCount: 0,
        pendingPushCount: 0,
        conflictCount: 0,
        activeRunId: null,
        lastSyncedLedgerVersion: ev.ledgerVersion,
        localHighWatermark: Math.max(current.localHighWatermark, ev.ledgerVersion),
        lastErrorCode: null,
      });

    case 'sync.local.changed':
      if (current.state !== 'online_synced' || ev.pendingPushCount <= 0) return finalize(current);
      return finalize({
        ...current,
        state: 'online_dirty',
        pendingPushCount: ev.pendingPushCount,
      });

    case 'sync.started':
      if (current.state !== 'online_dirty' && current.state !== 'degraded_remote') {
        return finalize(current);
      }
      return finalize({
        ...current,
        state: 'syncing',
        activeRunId: ev.runId,
        networkOnline: true,
        remoteReachable: true,
        lastErrorCode: null,
      });

    case 'sync.completed':
      if (current.state !== 'syncing' || current.conflictCount > 0) return finalize(current);
      return finalize({
        ...current,
        state: 'online_synced',
        pendingPullCount: 0,
        pendingPushCount: 0,
        conflictCount: 0,
        activeRunId: null,
        lastSyncedLedgerVersion: ev.ledgerVersion,
        localHighWatermark: Math.max(current.localHighWatermark, ev.ledgerVersion),
        lastErrorCode: null,
      });

    case 'sync.network.offline': {
      if (!ONLINE_STATES.has(current.state) && current.state !== 'initial_sync') {
        return finalize(current);
      }
      const nextState = current.localWritable && ev.queueWrites
        ? 'offline_queueing'
        : 'offline_readonly';
      return finalize({
        ...current,
        state: nextState,
        networkOnline: false,
        remoteReachable: false,
        activeRunId: null,
      });
    }

    case 'sync.network.online':
      if (current.state === 'offline_queueing') {
        return finalize({
          ...current,
          state: current.pendingPushCount > 0 ? 'online_dirty' : 'online_synced',
          networkOnline: true,
          remoteReachable: true,
          lastErrorCode: null,
        });
      }
      if (current.state === 'offline_readonly') {
        return finalize({
          ...current,
          state: 'online_synced',
          networkOnline: true,
          remoteReachable: true,
          lastErrorCode: null,
        });
      }
      return finalize(current);

    case 'sync.conflict.detected':
      if (current.state !== 'syncing') return finalize(current);
      return finalize({
        ...current,
        state: 'conflict_inbox',
        conflictCount: ev.conflictCount,
      });

    case 'sync.conflict.resolved':
      if (current.state !== 'conflict_inbox' || ev.remainingBlockingCount !== 0) {
        return finalize(current);
      }
      return finalize({
        ...current,
        state: current.pendingPushCount > 0 ? 'online_dirty' : 'online_synced',
        conflictCount: 0,
        activeRunId: null,
      });

    case 'sync.auth.expired':
      if (current.state !== 'syncing') return finalize(current);
      return finalize({
        ...current,
        state: 'reauth_required',
        authValid: false,
        activeRunId: null,
      });

    case 'sync.auth.restored':
      if (current.state !== 'reauth_required') return finalize(current);
      return finalize({
        ...current,
        state: current.pendingPushCount > 0 ? 'online_dirty' : 'online_synced',
        authValid: true,
        lastErrorCode: null,
      });

    case 'sync.remote.degraded':
      if (current.state !== 'syncing') return finalize(current);
      return finalize({
        ...current,
        state: 'degraded_remote',
        remoteReachable: false,
        activeRunId: null,
        lastErrorCode: ev.errorCode,
      });

    case 'sync.recovery.required':
      if (current.state !== 'syncing') return finalize(current);
      return finalize({
        ...current,
        state: 'recovery_required',
        activeRunId: null,
        lastErrorCode: ev.errorCode,
      });

    case 'sync.reset':
      if (current.state !== 'recovery_required') return finalize(current);
      return finalize({
        ...current,
        state: 'initial_sync',
        pendingPullCount: 0,
        pendingPushCount: 0,
        conflictCount: 0,
        activeRunId: null,
        lastSyncedLedgerVersion: null,
        localHighWatermark: 0,
        lastErrorCode: null,
      });
  }
}
