import { useCallback, useEffect, useRef, useState } from 'react';
import type { RuntimeSyncStateV2 } from '@chrono/contracts';
import { runSync } from './backgroundSync';

type NetInfoState = {
  isConnected: boolean | null;
  isInternetReachable?: boolean | null;
};

type NetInfoSubscription = () => void;

type NetInfoModule = {
  addEventListener(listener: (state: NetInfoState) => void): NetInfoSubscription;
};

type RuntimeRequire = (id: string) => unknown;

function loadNetInfo(): NetInfoModule | null {
  const runtimeRequire = (globalThis as { require?: RuntimeRequire }).require;
  if (!runtimeRequire) return null;

  try {
    const mod = runtimeRequire('@react-native-community/netinfo') as
      | NetInfoModule
      | { default?: NetInfoModule };
    return 'addEventListener' in mod ? mod : (mod.default ?? null);
  } catch {
    return null;
  }
}

function deriveState(
  networkOnline: boolean,
  pendingPushCount: number,
  conflictCount: number,
): RuntimeSyncStateV2 {
  if (!networkOnline) return 'offline_queueing';
  if (conflictCount > 0) return 'conflict_inbox';
  if (pendingPushCount > 0) return 'online_dirty';
  return 'online_synced';
}

export interface MobileSyncState {
  state: RuntimeSyncStateV2;
  networkOnline: boolean;
  pendingPushCount: number;
  conflictCount: number;
  lastErrorCode: string | null;
  isOnline: boolean;
  setOnline(v: boolean): void;
  triggerSync(): void;
}

export function useMobileSyncState(): MobileSyncState {
  const [isOnline, setOnline] = useState(true);
  const [pendingPushCount] = useState(0);
  const [conflictCount] = useState(0);
  const [lastErrorCode, setLastErrorCode] = useState<string | null>(null);
  const [isSyncing, setIsSyncing] = useState(false);
  const initialized = useRef(false);
  const prevOnline = useRef(true);

  const [state, setState] = useState<RuntimeSyncStateV2>('initial_sync');

  useEffect(() => {
    if (!initialized.current) {
      initialized.current = true;
      const derived = deriveState(isOnline, pendingPushCount, conflictCount);
      setState(derived === 'online_synced' ? 'initial_sync' : derived);
      return;
    }
    if (isSyncing) {
      setState('syncing');
      return;
    }
    setState(deriveState(isOnline, pendingPushCount, conflictCount));
  }, [conflictCount, isOnline, isSyncing, pendingPushCount]);

  // Disconnect recovery: trigger sync when connection is restored
  useEffect(() => {
    const wasOffline = !prevOnline.current;
    prevOnline.current = isOnline;
    if (wasOffline && isOnline) {
      triggerSync();
    }
    // triggerSync defined below; safe because this effect only runs on isOnline changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOnline]);

  useEffect(() => {
    const netInfo = loadNetInfo();
    if (!netInfo) return undefined;

    return netInfo.addEventListener((next) => {
      setOnline(next.isInternetReachable ?? next.isConnected ?? true);
    });
  }, []);

  const triggerSync = useCallback(() => {
    if (!isOnline) return;
    setIsSyncing(true);
    setLastErrorCode(null);

    runSync()
      .then(() => {
        setLastErrorCode(null);
      })
      .catch((err: unknown) => {
        const code = err instanceof Error ? err.message.slice(0, 80) : 'sync_failed';
        setLastErrorCode(code);
      })
      .finally(() => {
        setIsSyncing(false);
      });
  }, [isOnline]);

  return {
    state,
    networkOnline: isOnline,
    pendingPushCount,
    conflictCount,
    lastErrorCode,
    isOnline,
    setOnline,
    triggerSync,
  };
}
