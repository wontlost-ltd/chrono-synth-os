import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';
import { useSimulationShares, useShareSimulation, useRevokeShare } from './sharing';

const mockApiFetch = vi.fn();
vi.mock('../client', () => ({ apiFetch: (...args: unknown[]) => mockApiFetch(...args) }));

function createWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: qc }, children);
}

beforeEach(() => {
  mockApiFetch.mockReset();
});

describe('useSimulationShares', () => {
  it('fetches shares with encoded simId', async () => {
    const shares = [{ id: 's1', targetUserId: 'u1', permission: 'view' }];
    mockApiFetch.mockResolvedValue(shares);
    const { result } = renderHook(() => useSimulationShares('sim/1'), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockApiFetch).toHaveBeenCalledWith(`/api/v1/simulations/${encodeURIComponent('sim/1')}/shares`, expect.any(Object));
  });

  it('is disabled when simId is empty', () => {
    const { result } = renderHook(() => useSimulationShares(''), { wrapper: createWrapper() });
    expect(result.current.fetchStatus).toBe('idle');
  });
});

describe('useShareSimulation', () => {
  it('sends POST with encoded simId', async () => {
    const body = { userId: 'u1', permission: 'edit' as const };
    mockApiFetch.mockResolvedValue({ id: 's1', ...body });
    const { result } = renderHook(() => useShareSimulation('sim1'), { wrapper: createWrapper() });
    result.current.mutate(body);
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockApiFetch).toHaveBeenCalledWith(`/api/v1/simulations/${encodeURIComponent('sim1')}/shares`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  });
});

describe('useRevokeShare', () => {
  it('sends DELETE with encoded ids', async () => {
    mockApiFetch.mockResolvedValue(undefined);
    const { result } = renderHook(() => useRevokeShare('sim/1'), { wrapper: createWrapper() });
    result.current.mutate('share/2');
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockApiFetch).toHaveBeenCalledWith(
      `/api/v1/simulations/${encodeURIComponent('sim/1')}/shares/${encodeURIComponent('share/2')}`,
      { method: 'DELETE' },
    );
  });
});
