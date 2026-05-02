/**
 * 纯函数同步状态推导器
 * 接收当前快照与事件，返回新快照（无 I/O 副作用）
 * 不合法的状态转换被静默忽略（返回原快照重新计算能力）
 */

import {
  RuntimeSyncEventSchema,
  SyncStatusSnapshotV1Schema,
  type RuntimeSyncEvent,
  type RuntimeSyncStateV1,
  type SyncCapabilitiesV1,
  type SyncStatusSnapshotV1,
} from '@chrono/contracts';

function resolveBaseState(syncEnabled: boolean, networkOnline: boolean): RuntimeSyncStateV1 {
  if (!syncEnabled) return 'disabled';
  return networkOnline ? 'idle' : 'offline';
}

function deriveCapabilities(
  state: RuntimeSyncStateV1,
  syncEnabled: boolean,
  networkOnline: boolean,
  conflictCount: number,
): SyncCapabilitiesV1 {
  return {
    canConfigure: state === 'unconfigured' || state === 'disabled',
    canStartSync: state === 'idle' && syncEnabled && networkOnline,
    canPause:
      (state === 'idle' || state === 'pulling' || state === 'merging' || state === 'pushing') &&
      syncEnabled,
    canResume: state === 'paused',
    canResolveConflict: state === 'conflicted' && conflictCount > 0,
    canRetry: state === 'error' && syncEnabled && networkOnline,
    canDisable: state !== 'unconfigured' && state !== 'disabled',
  };
}

function finalize(
  draft: Omit<SyncStatusSnapshotV1, 'capabilities'>,
): SyncStatusSnapshotV1 {
  const capabilities = deriveCapabilities(
    draft.state,
    draft.syncEnabled,
    draft.networkOnline,
    draft.conflictCount,
  );
  return SyncStatusSnapshotV1Schema.parse({ ...draft, capabilities });
}

/** `error` 包含在内：retry 通过 `sync.started` 从 error 状态触发（对应 capabilities.canRetry） */
const STARTABLE: ReadonlySet<RuntimeSyncStateV1> = new Set(['idle', 'error']);

const PAUSABLE: ReadonlySet<RuntimeSyncStateV1> = new Set([
  'idle',
  'pulling',
  'merging',
  'pushing',
]);

const FAILABLE: ReadonlySet<RuntimeSyncStateV1> = new Set([
  'pulling',
  'merging',
  'pushing',
  'conflicted',
]);

const PRESERVE_ON_OFFLINE: ReadonlySet<RuntimeSyncStateV1> = new Set([
  'unconfigured',
  'disabled',
  'paused',
  'conflicted',
  'error',
]);

export function deriveRuntimeSyncState(
  snapshot: SyncStatusSnapshotV1,
  event: RuntimeSyncEvent,
): SyncStatusSnapshotV1 {
  const current = SyncStatusSnapshotV1Schema.parse(snapshot);
  const ev = RuntimeSyncEventSchema.parse(event);

  switch (ev.type) {
    case 'sync.configured':
      return finalize({
        ...current,
        state: resolveBaseState(ev.enabled, current.networkOnline),
        syncEnabled: ev.enabled,
        pendingPullCount: 0,
        pendingPushCount: 0,
        conflictCount: 0,
        lastErrorCode: null,
        lastErrorMessage: null,
        activeRunId: null,
      });

    case 'sync.disabled':
      return finalize({
        ...current,
        state: 'disabled',
        syncEnabled: false,
        pendingPullCount: 0,
        pendingPushCount: 0,
        conflictCount: 0,
        activeRunId: null,
      });

    case 'sync.started':
      if (!current.syncEnabled || !current.networkOnline || !STARTABLE.has(current.state)) {
        return finalize(current);
      }
      return finalize({
        ...current,
        state: 'pulling',
        activeRunId: ev.runId,
        lastSyncStartedAt: ev.occurredAt,
        lastErrorCode: null,
        lastErrorMessage: null,
      });

    case 'sync.pull.completed':
      if (current.state !== 'pulling') return finalize(current);
      return finalize({
        ...current,
        state: 'merging',
        pendingPullCount: ev.pendingPullCount,
      });

    case 'sync.merge.completed': {
      if (current.state !== 'merging') return finalize(current);
      return finalize({
        ...current,
        state: 'pushing',
        pendingPullCount: 0,
        pendingPushCount: ev.pendingPushCount,
        lastSyncCompletedAt: current.lastSyncCompletedAt,
        activeRunId: current.activeRunId,
      });
    }

    case 'sync.push.completed':
      if (current.state !== 'pushing') return finalize(current);
      return finalize({
        ...current,
        state: resolveBaseState(current.syncEnabled, current.networkOnline),
        pendingPushCount: 0,
        conflictCount: 0,
        lastSyncCompletedAt: ev.occurredAt,
        lastErrorCode: null,
        lastErrorMessage: null,
        activeRunId: null,
      });

    case 'sync.conflict.detected':
      if (current.state !== 'merging' && current.state !== 'pushing') return finalize(current);
      return finalize({
        ...current,
        state: 'conflicted',
        conflictCount: ev.conflictCount,
      });

    case 'sync.conflict.resolved':
      if (current.state !== 'conflicted') return finalize(current);
      return finalize({
        ...current,
        state: resolveBaseState(current.syncEnabled, current.networkOnline),
        conflictCount: 0,
        activeRunId: null,
      });

    case 'sync.paused':
      if (!PAUSABLE.has(current.state) || !current.syncEnabled) return finalize(current);
      return finalize({ ...current, state: 'paused' });

    case 'sync.resumed':
      if (current.state !== 'paused') return finalize(current);
      return finalize({
        ...current,
        state: resolveBaseState(current.syncEnabled, current.networkOnline),
      });

    case 'sync.network.offline':
      return finalize({
        ...current,
        networkOnline: false,
        state: PRESERVE_ON_OFFLINE.has(current.state) ? current.state : 'offline',
      });

    case 'sync.network.online':
      return finalize({
        ...current,
        networkOnline: true,
        state: current.state === 'offline'
          ? resolveBaseState(current.syncEnabled, true)
          : current.state,
      });

    case 'sync.failed':
      if (!FAILABLE.has(current.state)) return finalize(current);
      return finalize({
        ...current,
        state: 'error',
        activeRunId: null,
        lastErrorCode: ev.errorCode,
        lastErrorMessage: ev.errorMessage ?? null,
      });

    case 'sync.reset':
      return finalize({
        schemaVersion: 1,
        state: 'unconfigured',
        syncEnabled: false,
        networkOnline: current.networkOnline,
        pendingPullCount: 0,
        pendingPushCount: 0,
        conflictCount: 0,
        lastSyncStartedAt: null,
        lastSyncCompletedAt: null,
        lastErrorCode: null,
        lastErrorMessage: null,
        activeRunId: null,
      });
  }
}
