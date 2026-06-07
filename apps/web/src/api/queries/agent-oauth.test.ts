import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';
import {
  useUserOauthTokens,
  useStartGoogleAuthorize,
  useRevokeGoogleToken,
  GOOGLE_SCOPES,
} from './agent-oauth';

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

describe('GOOGLE_SCOPES', () => {
  it('is non-empty and contains canonical Google scope URLs', () => {
    expect(GOOGLE_SCOPES.length).toBeGreaterThan(0);
    for (const s of GOOGLE_SCOPES) {
      expect(s.value).toMatch(/^https:\/\/www\.googleapis\.com\/auth\//);
      expect(s.label).toBeTruthy();
    }
  });
});

describe('useUserOauthTokens', () => {
  it('unwraps data envelope', async () => {
    mockApiFetch.mockResolvedValue([{ id: 'uoauth_1', scope: 'foo' }]);
    const { result } = renderHook(() => useUserOauthTokens(), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual([{ id: 'uoauth_1', scope: 'foo' }]);
    expect(mockApiFetch).toHaveBeenCalledWith('/api/v1/agent/oauth/google', expect.any(Object));
  });
});

describe('useStartGoogleAuthorize', () => {
  it('returns the authorize URL the caller can navigate to', async () => {
    mockApiFetch.mockResolvedValue({ authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth?…' });
    const { result } = renderHook(() => useStartGoogleAuthorize(), { wrapper: createWrapper() });
    const out = await result.current.mutateAsync({
      scope: 'https://www.googleapis.com/auth/calendar',
      redirectAfter: '/dashboard',
    });
    expect(out.authorizeUrl).toContain('accounts.google.com');
    const [path, init] = mockApiFetch.mock.calls[0]!;
    expect(path).toBe('/api/v1/agent/oauth/google/authorize');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({
      scope: 'https://www.googleapis.com/auth/calendar',
      redirectAfter: '/dashboard',
    });
  });
});

describe('useRevokeGoogleToken', () => {
  it('DELETEs with default reason when none provided', async () => {
    mockApiFetch.mockResolvedValue(undefined);
    const { result } = renderHook(() => useRevokeGoogleToken(), { wrapper: createWrapper() });
    await result.current.mutateAsync({ id: 'uoauth_1' });
    const [path, init] = mockApiFetch.mock.calls[0]!;
    expect(path).toBe('/api/v1/agent/oauth/google/uoauth_1');
    expect(init.method).toBe('DELETE');
    expect(JSON.parse(init.body)).toEqual({ reason: 'user_initiated' });
  });

  it('DELETEs with custom reason when provided', async () => {
    mockApiFetch.mockResolvedValue(undefined);
    const { result } = renderHook(() => useRevokeGoogleToken(), { wrapper: createWrapper() });
    await result.current.mutateAsync({ id: 'uoauth_1', reason: 'compromised' });
    expect(JSON.parse(mockApiFetch.mock.calls[0]![1].body)).toEqual({ reason: 'compromised' });
  });
});
