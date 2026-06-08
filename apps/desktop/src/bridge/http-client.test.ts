import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ApiNotConfiguredError,
  apiFetch,
  getApiBaseUrl,
  getApiToken,
  setApiBaseUrl,
  setApiToken,
} from './http-client';

const STORAGE_BASE = 'chrono.api.baseUrl';
const STORAGE_TOKEN = 'chrono.api.token';

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

afterEach(() => {
  localStorage.clear();
});

describe('storage helpers', () => {
  it('round-trip baseUrl with trailing-slash trimmed', () => {
    setApiBaseUrl('https://api.example.com//');
    expect(getApiBaseUrl()).toBe('https://api.example.com');
    expect(localStorage.getItem(STORAGE_BASE)).toBe('https://api.example.com');
  });

  it('clears baseUrl when null', () => {
    setApiBaseUrl('https://x');
    setApiBaseUrl(null);
    expect(getApiBaseUrl()).toBeNull();
  });

  it('round-trips token', () => {
    setApiToken('jwt-x');
    expect(getApiToken()).toBe('jwt-x');
    expect(localStorage.getItem(STORAGE_TOKEN)).toBe('jwt-x');
  });

  it('clears token when null', () => {
    setApiToken('jwt-x');
    setApiToken(null);
    expect(getApiToken()).toBeNull();
  });
});

describe('apiFetch', () => {
  it('throws ApiNotConfiguredError when base or token missing', async () => {
    setApiBaseUrl('https://api.example.com');
    setApiToken(null);
    await expect(apiFetch('/foo')).rejects.toBeInstanceOf(ApiNotConfiguredError);

    setApiBaseUrl(null);
    setApiToken('t');
    await expect(apiFetch('/foo')).rejects.toBeInstanceOf(ApiNotConfiguredError);
  });

  it('sets bearer + content-type and resolves JSON', async () => {
    setApiBaseUrl('https://api.example.com');
    setApiToken('jwt-x');
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await apiFetch<{ ok: boolean }>('/api/v1/agent/oauth/google');
    expect(result).toEqual({ ok: true });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.example.com/api/v1/agent/oauth/google');
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer jwt-x');
    expect(headers['content-type']).toBe('application/json');
  });

  it('serializes body to JSON when provided', async () => {
    setApiBaseUrl('https://api.example.com');
    setApiToken('jwt-x');
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);

    await apiFetch('/api/v1/agent/confirmations/cct_xyz/approve', {
      method: 'POST',
      body: { arguments: { to: 'a@b.com' } },
    });
    const [, init] = fetchMock.mock.calls[0]!;
    expect(init.method).toBe('POST');
    expect(init.body).toBe(JSON.stringify({ arguments: { to: 'a@b.com' } }));
  });

  it('returns undefined for 204', async () => {
    setApiBaseUrl('https://api.example.com');
    setApiToken('jwt-x');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
    await expect(apiFetch('/x', { method: 'DELETE' })).resolves.toBeUndefined();
  });

  it('throws on non-ok with status + body fragment', async () => {
    setApiBaseUrl('https://api.example.com');
    setApiToken('jwt-x');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('persona not found', { status: 404 })),
    );
    await expect(apiFetch('/x')).rejects.toThrow(/HTTP 404/);
  });
});
