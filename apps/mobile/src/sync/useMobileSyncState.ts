import type { RuntimeSyncStateV1 } from '@chrono/contracts';
import { useEffect, useState } from 'react';

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

function stateForOnline(isOnline: boolean): RuntimeSyncStateV1 {
  return isOnline ? 'idle' : 'offline';
}

export function useMobileSyncState(): {
  state: RuntimeSyncStateV1;
  pendingCount: number;
  isOnline: boolean;
  setOnline(v: boolean): void;
} {
  const [isOnline, setOnline] = useState(true);
  const [state, setState] = useState<RuntimeSyncStateV1>('idle');
  const [pendingCount] = useState(0);

  useEffect(() => {
    setState(stateForOnline(isOnline));
  }, [isOnline]);

  useEffect(() => {
    const netInfo = loadNetInfo();
    if (!netInfo) return undefined;

    return netInfo.addEventListener(next => {
      const connected = next.isInternetReachable ?? next.isConnected ?? true;
      setOnline(connected);
    });
  }, []);

  return { state, pendingCount, isOnline, setOnline };
}
