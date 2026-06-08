import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useSyncEngine, isSyncing, isOffline, hasConflicts, needsAttention } from './useSyncEngine';

const send = vi.fn();
const subscribe = vi.fn((_event: string, _cb: (payload: unknown) => void) => vi.fn());
let capturedStateChanged: ((payload: unknown) => void) | undefined;

vi.mock('@/hooks/useWebSocket', () => ({
  useWebSocket: () => ({
    subscribe,
    send,
    status: 'connected',
    lastEvent: null,
    connect: vi.fn(),
    disconnect: vi.fn(),
    wsError: null,
  }),
}));

// BroadcastChannel mock — lets tests simulate service worker network messages.
let lastBcInstance: { onmessage: ((e: MessageEvent<{ type: string }>) => void) | null; close: () => void } | null = null;
const bcClose = vi.fn();

vi.stubGlobal('BroadcastChannel', class {
  onmessage: ((e: MessageEvent<{ type: string }>) => void) | null = null;
  constructor(_name: string) {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    lastBcInstance = this;
  }
  close() { bcClose(); }
});

function dispatchSwMessage(data: { type: string }) {
  if (lastBcInstance?.onmessage) {
    lastBcInstance.onmessage(new MessageEvent('message', { data }));
  }
}

describe('useSyncEngine', () => {
  beforeEach(() => {
    send.mockClear();
    bcClose.mockClear();
    lastBcInstance = null;
    subscribe.mockReset();
    capturedStateChanged = undefined;
    subscribe.mockImplementation((event, cb) => {
      if (event === 'sync.state_changed') capturedStateChanged = cb;
      return vi.fn();
    });
  });

  it('starts in initial_sync state', () => {
    const { result } = renderHook(() => useSyncEngine());
    expect(result.current.state).toBe('initial_sync');
  });

  it('initializes all V2 snapshot fields to defaults', () => {
    const { result } = renderHook(() => useSyncEngine());
    expect(result.current.schemaVersion).toBe(2);
    expect(result.current.pendingPushCount).toBe(0);
    expect(result.current.pendingPullCount).toBe(0);
    expect(result.current.conflictCount).toBe(0);
    expect(result.current.lastSyncedLedgerVersion).toBeNull();
    expect(result.current.lastErrorCode).toBeNull();
    expect(result.current.activeRunId).toBeNull();
    expect(result.current.networkOnline).toBe(true);
    expect(result.current.authValid).toBe(true);
  });

  it('forceSync sends a force sync action', () => {
    const { result } = renderHook(() => useSyncEngine());
    act(() => { result.current.forceSync(); });
    expect(send).toHaveBeenCalledWith({ action: 'sync.force' });
  });

  it('merges sync.state_changed WebSocket payload into snapshot', () => {
    const { result } = renderHook(() => useSyncEngine());
    act(() => {
      capturedStateChanged?.({ state: 'syncing', pendingPushCount: 3, activeRunId: 'run-001' });
    });
    expect(result.current.state).toBe('syncing');
    expect(result.current.pendingPushCount).toBe(3);
    expect(result.current.activeRunId).toBe('run-001');
  });

  it('transitions to online_dirty when local changes arrive', () => {
    const { result } = renderHook(() => useSyncEngine());
    act(() => {
      capturedStateChanged?.({ state: 'online_dirty', pendingPushCount: 2 });
    });
    expect(result.current.state).toBe('online_dirty');
  });

  it('NETWORK_LOST from SW sets networkOnline=false and state=offline_queueing', () => {
    const { result } = renderHook(() => useSyncEngine());
    act(() => { dispatchSwMessage({ type: 'NETWORK_LOST' }); });
    expect(result.current.networkOnline).toBe(false);
    expect(result.current.state).toBe('offline_queueing');
  });

  it('NETWORK_LOST preserves offline_readonly state', () => {
    const { result } = renderHook(() => useSyncEngine());
    act(() => { capturedStateChanged?.({ state: 'offline_readonly' }); });
    act(() => { dispatchSwMessage({ type: 'NETWORK_LOST' }); });
    expect(result.current.state).toBe('offline_readonly');
  });

  it('NETWORK_RESTORED sets networkOnline=true and transitions to syncing from offline', () => {
    const { result } = renderHook(() => useSyncEngine());
    act(() => { dispatchSwMessage({ type: 'NETWORK_LOST' }); });
    act(() => { dispatchSwMessage({ type: 'NETWORK_RESTORED' }); });
    expect(result.current.networkOnline).toBe(true);
    expect(result.current.state).toBe('syncing');
  });

  it('NETWORK_RESTORED does not change state when not in offline states', () => {
    const { result } = renderHook(() => useSyncEngine());
    act(() => { capturedStateChanged?.({ state: 'online_synced' }); });
    act(() => { dispatchSwMessage({ type: 'NETWORK_RESTORED' }); });
    expect(result.current.state).toBe('online_synced');
  });

  it('closes BroadcastChannel on unmount', () => {
    const { unmount } = renderHook(() => useSyncEngine());
    unmount();
    expect(bcClose).toHaveBeenCalledOnce();
  });
});

describe('state predicates', () => {
  it('isSyncing', () => {
    expect(isSyncing('syncing')).toBe(true);
    expect(isSyncing('online_dirty')).toBe(false);
  });

  it('isOffline', () => {
    expect(isOffline('offline_queueing')).toBe(true);
    expect(isOffline('offline_readonly')).toBe(true);
    expect(isOffline('online_synced')).toBe(false);
  });

  it('hasConflicts', () => {
    expect(hasConflicts('conflict_inbox')).toBe(true);
    expect(hasConflicts('syncing')).toBe(false);
  });

  it('needsAttention', () => {
    expect(needsAttention('reauth_required')).toBe(true);
    expect(needsAttention('degraded_remote')).toBe(true);
    expect(needsAttention('recovery_required')).toBe(true);
    expect(needsAttention('online_synced')).toBe(false);
  });
});
