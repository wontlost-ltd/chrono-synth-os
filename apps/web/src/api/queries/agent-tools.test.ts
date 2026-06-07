import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';
import {
  useToolPermissions,
  useToolPermissionsByPersona,
  useGrantToolPermission,
  useRevokeToolPermission,
  useAgencyAuthorizationsByPersona,
  useCreateAgencyAuthorization,
  useSuspendAgencyAuthorization,
  useResumeAgencyAuthorization,
  useRevokeAgencyAuthorization,
  useToolInvocations,
} from './agent-tools';

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

describe('useToolPermissions', () => {
  it('unwraps the data envelope', async () => {
    mockApiFetch.mockResolvedValue([{ id: 'tperm_1', toolId: 'web_search' }]);
    const { result } = renderHook(() => useToolPermissions(), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual([{ id: 'tperm_1', toolId: 'web_search' }]);
    expect(mockApiFetch).toHaveBeenCalledWith('/api/v1/admin/tool-permissions', expect.any(Object));
  });

  it('does not fire when disabled', () => {
    renderHook(() => useToolPermissions(false), { wrapper: createWrapper() });
    expect(mockApiFetch).not.toHaveBeenCalled();
  });
});

describe('useToolPermissionsByPersona', () => {
  it('targets the per-persona endpoint', async () => {
    mockApiFetch.mockResolvedValue([]);
    const { result } = renderHook(() => useToolPermissionsByPersona('p1'), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockApiFetch).toHaveBeenCalledWith('/api/v1/admin/personas/p1/tool-permissions', expect.any(Object));
  });

  it('skips when personaId is null', () => {
    renderHook(() => useToolPermissionsByPersona(null), { wrapper: createWrapper() });
    expect(mockApiFetch).not.toHaveBeenCalled();
  });
});

describe('useGrantToolPermission', () => {
  it('POSTs the input and unwraps the result', async () => {
    mockApiFetch.mockResolvedValue({ id: 'tperm_1', revocationKey: 'rk_xyz' });
    const { result } = renderHook(() => useGrantToolPermission(), { wrapper: createWrapper() });
    const out = await result.current.mutateAsync({
      personaId: 'p1', toolId: 'web_search', scope: 'execute',
    });
    expect(out).toEqual({ id: 'tperm_1', revocationKey: 'rk_xyz' });
    const [path, init] = mockApiFetch.mock.calls[0]!;
    expect(path).toBe('/api/v1/admin/tool-permissions');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ personaId: 'p1', toolId: 'web_search', scope: 'execute' });
  });
});

describe('useRevokeToolPermission', () => {
  it('DELETEs with reason in body', async () => {
    mockApiFetch.mockResolvedValue(undefined);
    const { result } = renderHook(() => useRevokeToolPermission(), { wrapper: createWrapper() });
    await result.current.mutateAsync({ id: 'tperm_1', reason: 'no longer needed' });
    const [path, init] = mockApiFetch.mock.calls[0]!;
    expect(path).toBe('/api/v1/admin/tool-permissions/tperm_1');
    expect(init.method).toBe('DELETE');
    expect(JSON.parse(init.body)).toEqual({ reason: 'no longer needed' });
  });
});

describe('useAgencyAuthorizationsByPersona', () => {
  it('encodes personaId in the query string', async () => {
    mockApiFetch.mockResolvedValue([]);
    const { result } = renderHook(
      () => useAgencyAuthorizationsByPersona('persona/with slash'),
      { wrapper: createWrapper() },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockApiFetch).toHaveBeenCalledWith(
      '/api/v1/admin/agency-authorizations?personaId=persona%2Fwith%20slash',
      expect.any(Object),
    );
  });
});

describe('useCreateAgencyAuthorization', () => {
  it('POSTs and unwraps the data envelope', async () => {
    mockApiFetch.mockResolvedValue({ id: 'aa_1', revocationKey: 'rk_aa' });
    const { result } = renderHook(() => useCreateAgencyAuthorization(), { wrapper: createWrapper() });
    const out = await result.current.mutateAsync({
      personaId: 'p1',
      principalUserId: 'u1',
      scope: 'communication',
      scopeDescription: 'Send weekly updates on behalf of the user',
    });
    expect(out).toEqual({ id: 'aa_1', revocationKey: 'rk_aa' });
    expect(mockApiFetch.mock.calls[0]![0]).toBe('/api/v1/admin/agency-authorizations');
    expect(mockApiFetch.mock.calls[0]![1].method).toBe('POST');
  });
});

describe('useSuspendAgencyAuthorization / useResumeAgencyAuthorization', () => {
  it('hits the suspend endpoint', async () => {
    mockApiFetch.mockResolvedValue(undefined);
    const { result } = renderHook(() => useSuspendAgencyAuthorization(), { wrapper: createWrapper() });
    await result.current.mutateAsync('aa_1');
    expect(mockApiFetch).toHaveBeenCalledWith(
      '/api/v1/admin/agency-authorizations/aa_1/suspend',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('hits the resume endpoint', async () => {
    mockApiFetch.mockResolvedValue(undefined);
    const { result } = renderHook(() => useResumeAgencyAuthorization(), { wrapper: createWrapper() });
    await result.current.mutateAsync('aa_1');
    expect(mockApiFetch).toHaveBeenCalledWith(
      '/api/v1/admin/agency-authorizations/aa_1/resume',
      expect.objectContaining({ method: 'POST' }),
    );
  });
});

describe('useRevokeAgencyAuthorization', () => {
  it('DELETEs with reason', async () => {
    mockApiFetch.mockResolvedValue(undefined);
    const { result } = renderHook(() => useRevokeAgencyAuthorization(), { wrapper: createWrapper() });
    await result.current.mutateAsync({ id: 'aa_1', reason: 'principal left' });
    const [path, init] = mockApiFetch.mock.calls[0]!;
    expect(path).toBe('/api/v1/admin/agency-authorizations/aa_1');
    expect(init.method).toBe('DELETE');
    expect(JSON.parse(init.body)).toEqual({ reason: 'principal left' });
  });
});

describe('useToolInvocations', () => {
  it('builds query string with limit', async () => {
    mockApiFetch.mockResolvedValue([]);
    const { result } = renderHook(() => useToolInvocations('p1', 100), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockApiFetch).toHaveBeenCalledWith(
      '/api/v1/admin/personas/p1/tool-invocations?limit=100',
      expect.any(Object),
    );
  });

  it('skips when personaId is null', () => {
    renderHook(() => useToolInvocations(null), { wrapper: createWrapper() });
    expect(mockApiFetch).not.toHaveBeenCalled();
  });
});
