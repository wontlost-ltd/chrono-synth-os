import { describe, it, expect, vi } from 'vitest';

const getSyncStateMock = vi.fn();
vi.mock('@/bridge/tauri-commands', () => ({
  getSyncState: () => getSyncStateMock(),
}));

import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useSyncState } from './useSyncState';

function makeWrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchInterval: false } },
  });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

describe('useSyncState', () => {
  it('returns sync state from the bridge', async () => {
    getSyncStateMock.mockResolvedValueOnce({
      state: 'online_synced',
      conflict_count: 0,
      pending_push_count: 0,
      last_sync_at: 1735689600000,
    });
    const { result } = renderHook(() => useSyncState(), { wrapper: makeWrapper() });
    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(result.current.data?.state).toBe('online_synced');
  });

  it('surfaces error when the bridge throws', async () => {
    getSyncStateMock.mockRejectedValueOnce(new Error('bridge unavailable'));
    const { result } = renderHook(() => useSyncState(), { wrapper: makeWrapper() });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toEqual(new Error('bridge unavailable'));
  });
});
