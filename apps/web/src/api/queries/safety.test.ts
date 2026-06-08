import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';
import {
  useLatestDriftReport,
  useGenerateDriftReport,
  useSafetyStatus,
} from './safety';

const mockApiFetch = vi.fn();

/* vi.mock is hoisted — declare ApiError inside the factory so the mock
 * registers before the module under test imports it. */
vi.mock('../client', () => {
  class ApiError extends Error {
    constructor(public readonly status: number, message: string) {
      super(message);
      this.name = 'ApiError';
    }
  }
  return { apiFetch: (...args: unknown[]) => mockApiFetch(...args), ApiError };
});

/* Re-import the mocked ApiError for use in test setup */
const { ApiError } = await import('../client');
type ApiErrorCtor = new (status: number, message: string) => Error & { status: number };
const MockApiError = ApiError as unknown as ApiErrorCtor;

function createWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: qc }, children);
}

beforeEach(() => {
  mockApiFetch.mockReset();
});

describe('useLatestDriftReport', () => {
  it('returns the report when present', async () => {
    const report = { reportId: 'r_1', alertLevel: 'ok', overallDriftScore: 0.0 };
    mockApiFetch.mockResolvedValue(report);
    const { result } = renderHook(() => useLatestDriftReport(), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toMatchObject({ reportId: 'r_1', alertLevel: 'ok' });
  });

  it('returns null on 404 (no report yet) instead of erroring', async () => {
    mockApiFetch.mockRejectedValue(new MockApiError(404, 'Not Found'));
    const { result } = renderHook(() => useLatestDriftReport(), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toBeNull();
  });

  it('propagates non-404 errors', async () => {
    mockApiFetch.mockRejectedValue(new MockApiError(500, 'Internal Server Error'));
    const { result } = renderHook(() => useLatestDriftReport(), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect((result.current.error as unknown as { status: number }).status).toBe(500);
  });
});

describe('useGenerateDriftReport', () => {
  it('POSTs and returns the report', async () => {
    mockApiFetch.mockResolvedValue({
      reportId: 'r_2',
      alertLevel: 'critical',
      overallDriftScore: 0.42,
      valueDrifts: [],
      baselineSnapshotId: 'snap_baseline',
      analyzedAt: 1700000000000,
    });
    const { result } = renderHook(() => useGenerateDriftReport(), { wrapper: createWrapper() });
    const out = await result.current.mutateAsync();
    expect(out.alertLevel).toBe('critical');
    const [path, init] = mockApiFetch.mock.calls[0]!;
    expect(path).toBe('/api/v1/admin/safety/drift-report');
    expect(init.method).toBe('POST');
  });
});

describe('useSafetyStatus', () => {
  it('returns the status summary', async () => {
    mockApiFetch.mockResolvedValue({
      memoryConfidence: { totalCount: 100, unverifiedCount: 5, bySourceKind: { user_input: 95 } },
      personaDrift: { lastReport: null, recentAlerts: [] },
      safetyScore: 95,
    });
    const { result } = renderHook(() => useSafetyStatus(), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.safetyScore).toBe(95);
    expect(result.current.data?.memoryConfidence.totalCount).toBe(100);
    expect(result.current.data?.personaDrift?.recentAlerts).toEqual([]);
    expect(mockApiFetch).toHaveBeenCalledWith('/api/v1/admin/safety/status', expect.any(Object));
  });
});
