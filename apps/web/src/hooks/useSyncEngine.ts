import { useCallback, useEffect, useState } from 'react';
import type { RuntimeSyncStateV2, SyncStatusSnapshotV2 } from '@chrono/contracts';
import { useWebSocket } from '@/hooks/useWebSocket';

export type { RuntimeSyncStateV2 };

const INITIAL_SNAPSHOT: SyncStatusSnapshotV2 = {
  schemaVersion: 2,
  state: 'initial_sync',
  tenantId: '',
  runtimeId: '',
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
};

const SW_BROADCAST_CHANNEL = 'chrono-sync-state';

export function useSyncEngine(): SyncStatusSnapshotV2 & { forceSync(): void } {
  const [snapshot, setSnapshot] = useState<SyncStatusSnapshotV2>(INITIAL_SNAPSHOT);
  const { subscribe, send } = useWebSocket({ autoConnect: false });

  useEffect(() => {
    return subscribe('sync.state_changed', (payload: unknown) => {
      const patch = payload as Partial<SyncStatusSnapshotV2>;
      setSnapshot((prev) => ({ ...prev, ...patch }));
    });
  }, [subscribe]);

  // Listen to network status messages broadcast by the service worker.
  // NETWORK_LOST transitions online states to offline_queueing/offline_readonly;
  // NETWORK_RESTORED marks the connection back so the next WS reconnect can sync.
  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return;

    const channel = new BroadcastChannel(SW_BROADCAST_CHANNEL);

    channel.onmessage = (event: MessageEvent<{ type: string }>) => {
      const { type } = event.data;
      if (type === 'NETWORK_LOST') {
        setSnapshot((prev) => ({
          ...prev,
          networkOnline: false,
          state: prev.state === 'offline_readonly' ? 'offline_readonly' : 'offline_queueing',
        }));
      } else if (type === 'NETWORK_RESTORED') {
        setSnapshot((prev) => ({
          ...prev,
          networkOnline: true,
          state: prev.state === 'offline_queueing' || prev.state === 'offline_readonly'
            ? 'syncing'
            : prev.state,
        }));
      }
    };

    return () => channel.close();
  }, []);

  const forceSync = useCallback(() => {
    send({ action: 'sync.force' });
  }, [send]);

  return { ...snapshot, forceSync };
}

/** 便捷状态谓词 */
export function isSyncing(state: RuntimeSyncStateV2): boolean {
  return state === 'syncing';
}

export function isOffline(state: RuntimeSyncStateV2): boolean {
  return state === 'offline_queueing' || state === 'offline_readonly';
}

export function hasConflicts(state: RuntimeSyncStateV2): boolean {
  return state === 'conflict_inbox';
}

export function needsAttention(state: RuntimeSyncStateV2): boolean {
  return state === 'reauth_required' || state === 'degraded_remote' || state === 'recovery_required';
}
