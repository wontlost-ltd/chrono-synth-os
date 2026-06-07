import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';
import {
  useAutorunConfig,
  useUpdateAutorunConfig,
  useTriggerAutorun,
  useAutorunRuns,
  useReviewRun,
} from './autorun';

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

describe('useAutorunConfig', () => {
  it('fetches config with encoded avatarId', async () => {
    const cfg = { enabled: true, intervalMinutes: 60 };
    mockApiFetch.mockResolvedValue(cfg);
    const { result } = renderHook(() => useAutorunConfig('av/1'), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockApiFetch).toHaveBeenCalledWith(`/api/v1/avatars/${encodeURIComponent('av/1')}/autorun`, expect.any(Object));
  });

  it('is disabled when avatarId is empty', () => {
    const { result } = renderHook(() => useAutorunConfig(''), { wrapper: createWrapper() });
    expect(result.current.fetchStatus).toBe('idle');
  });
});

describe('useUpdateAutorunConfig', () => {
  it('sends PUT', async () => {
    const body = { enabled: true, intervalMinutes: 120, driftThreshold: 0.3, reviewRequired: false, knowledgeSourceIds: [] };
    mockApiFetch.mockResolvedValue(body);
    const { result } = renderHook(() => useUpdateAutorunConfig('av1'), { wrapper: createWrapper() });
    result.current.mutate(body);
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockApiFetch).toHaveBeenCalledWith(`/api/v1/avatars/${encodeURIComponent('av1')}/autorun`, {
      method: 'PUT',
      body: JSON.stringify(body),
    });
  });
});

describe('useTriggerAutorun', () => {
  it('sends POST with sourceIds', async () => {
    mockApiFetch.mockResolvedValue(undefined);
    const { result } = renderHook(() => useTriggerAutorun('av1'), { wrapper: createWrapper() });
    result.current.mutate(['s1', 's2']);
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockApiFetch).toHaveBeenCalledWith(`/api/v1/avatars/${encodeURIComponent('av1')}/autorun/trigger`, {
      method: 'POST',
      body: JSON.stringify({ sourceIds: ['s1', 's2'] }),
    });
  });

  it('sends POST with empty body when no sourceIds', async () => {
    mockApiFetch.mockResolvedValue(undefined);
    const { result } = renderHook(() => useTriggerAutorun('av1'), { wrapper: createWrapper() });
    result.current.mutate();
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockApiFetch).toHaveBeenCalledWith(`/api/v1/avatars/${encodeURIComponent('av1')}/autorun/trigger`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
  });
});

describe('useAutorunRuns', () => {
  it('fetches runs with encoded avatarId', async () => {
    const runs = [{ id: 'r1', status: 'completed' }];
    mockApiFetch.mockResolvedValue(runs);
    const { result } = renderHook(() => useAutorunRuns('av1'), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(runs);
    expect(mockApiFetch).toHaveBeenCalledWith(`/api/v1/avatars/${encodeURIComponent('av1')}/autorun/runs`, expect.any(Object));
  });
});

describe('useReviewRun', () => {
  it('sends POST review with encoded ids', async () => {
    mockApiFetch.mockResolvedValue(undefined);
    const body = { decisions: [{ path: '/a', action: 'accept' as const }], comment: 'ok' };
    const { result } = renderHook(() => useReviewRun('av/1', 'run/2'), { wrapper: createWrapper() });
    result.current.mutate(body);
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockApiFetch).toHaveBeenCalledWith(
      `/api/v1/avatars/${encodeURIComponent('av/1')}/autorun/runs/${encodeURIComponent('run/2')}/review`,
      { method: 'POST', body: JSON.stringify(body) },
    );
  });
});
