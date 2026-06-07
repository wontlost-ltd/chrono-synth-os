import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';
import {
  usePendingConfirmations,
  useApproveConfirmation,
  useRejectConfirmation,
} from './agent-confirmations';

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

describe('usePendingConfirmations', () => {
  it('passes the limit query string', async () => {
    mockApiFetch.mockResolvedValue({ data: [] });
    const { result } = renderHook(() => usePendingConfirmations(50), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockApiFetch).toHaveBeenCalledWith(
      '/api/v1/agent/confirmations/pending?limit=50',
      expect.any(Object),
    );
  });

  it('uses default limit 20 when omitted', async () => {
    mockApiFetch.mockResolvedValue({ data: [] });
    const { result } = renderHook(() => usePendingConfirmations(), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockApiFetch.mock.calls[0]![0]).toContain('limit=20');
  });
});

describe('useApproveConfirmation', () => {
  it('POSTs arguments + sessionId when provided', async () => {
    mockApiFetch.mockResolvedValue({ data: { ok: true } });
    const { result } = renderHook(() => useApproveConfirmation(), { wrapper: createWrapper() });
    await result.current.mutateAsync({
      tokenId: 'cct_xyz',
      arguments: { to: 'a@b.com', subject: 'hi' },
      sessionId: 'sess_1',
    });
    const [path, init] = mockApiFetch.mock.calls[0]!;
    expect(path).toBe('/api/v1/agent/confirmations/cct_xyz/approve');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body);
    expect(body.arguments).toEqual({ to: 'a@b.com', subject: 'hi' });
    expect(body.sessionId).toBe('sess_1');
  });

  it('omits sessionId when not provided', async () => {
    mockApiFetch.mockResolvedValue({ data: {} });
    const { result } = renderHook(() => useApproveConfirmation(), { wrapper: createWrapper() });
    await result.current.mutateAsync({ tokenId: 'cct_xyz', arguments: { x: 1 } });
    const body = JSON.parse(mockApiFetch.mock.calls[0]![1].body);
    expect(body.sessionId).toBeUndefined();
    expect(body.arguments).toEqual({ x: 1 });
  });
});

describe('useRejectConfirmation', () => {
  it('POSTs default reason', async () => {
    mockApiFetch.mockResolvedValue({ data: { rejected: true } });
    const { result } = renderHook(() => useRejectConfirmation(), { wrapper: createWrapper() });
    await result.current.mutateAsync({ tokenId: 'cct_xyz' });
    const [path, init] = mockApiFetch.mock.calls[0]!;
    expect(path).toBe('/api/v1/agent/confirmations/cct_xyz/reject');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ reason: 'user_rejected' });
  });

  it('POSTs custom reason', async () => {
    mockApiFetch.mockResolvedValue({ data: { rejected: true } });
    const { result } = renderHook(() => useRejectConfirmation(), { wrapper: createWrapper() });
    await result.current.mutateAsync({ tokenId: 'cct_xyz', reason: 'wrong tool' });
    expect(JSON.parse(mockApiFetch.mock.calls[0]![1].body)).toEqual({ reason: 'wrong tool' });
  });
});
