import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';
import { useAvatars, useAvatar, useCreateAvatar, useUpdateAvatar, useDeleteAvatar } from './avatars';

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

describe('useAvatars', () => {
  it('fetches avatars list', async () => {
    const data = [{ id: '1', label: 'A' }];
    mockApiFetch.mockResolvedValue(data);
    const { result } = renderHook(() => useAvatars(), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(data);
    expect(mockApiFetch).toHaveBeenCalledWith('/api/v1/avatars', expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });
});

describe('useAvatar', () => {
  it('fetches single avatar with encoded id', async () => {
    const avatar = { id: 'a/b', label: 'X' };
    mockApiFetch.mockResolvedValue(avatar);
    const { result } = renderHook(() => useAvatar('a/b'), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockApiFetch).toHaveBeenCalledWith(`/api/v1/avatars/${encodeURIComponent('a/b')}`, expect.any(Object));
  });

  it('does not fetch when id is empty', () => {
    mockApiFetch.mockResolvedValue(null);
    const { result } = renderHook(() => useAvatar(''), { wrapper: createWrapper() });
    expect(result.current.fetchStatus).toBe('idle');
    expect(mockApiFetch).not.toHaveBeenCalled();
  });
});

describe('useCreateAvatar', () => {
  it('sends POST with body', async () => {
    const created = { id: '1', label: 'New' };
    mockApiFetch.mockResolvedValue(created);
    const { result } = renderHook(() => useCreateAvatar(), { wrapper: createWrapper() });
    result.current.mutate({ label: 'New', kind: 'work' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockApiFetch).toHaveBeenCalledWith('/api/v1/avatars', {
      method: 'POST',
      body: JSON.stringify({ label: 'New', kind: 'work' }),
    });
  });
});

describe('useUpdateAvatar', () => {
  it('sends PUT with encoded id', async () => {
    mockApiFetch.mockResolvedValue({ id: 'x', label: 'Updated' });
    const { result } = renderHook(() => useUpdateAvatar('x'), { wrapper: createWrapper() });
    result.current.mutate({ label: 'Updated' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockApiFetch).toHaveBeenCalledWith(`/api/v1/avatars/${encodeURIComponent('x')}`, {
      method: 'PUT',
      body: JSON.stringify({ label: 'Updated' }),
    });
  });
});

describe('useDeleteAvatar', () => {
  it('sends DELETE with encoded id', async () => {
    mockApiFetch.mockResolvedValue(undefined);
    const { result } = renderHook(() => useDeleteAvatar(), { wrapper: createWrapper() });
    result.current.mutate('del-id');
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockApiFetch).toHaveBeenCalledWith(`/api/v1/avatars/${encodeURIComponent('del-id')}`, { method: 'DELETE' });
  });
});
