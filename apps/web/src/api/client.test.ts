import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ApiError, apiFetch } from './client';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

vi.mock('../config', () => ({ API_BASE_URL: 'http://test-api' }));
vi.mock('../store/session', () => ({
  getSession: () => ({ apiKey: 'test-key', tenantId: 'test-tenant', mode: 'demo', accessToken: '', user: null }),
  setSession: vi.fn(),
  clearSession: vi.fn(),
}));

beforeEach(() => {
  mockFetch.mockReset();
});

function jsonResponse(data: unknown, status = 200, headers: Record<string, string> = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name: string) => {
        if (name === 'content-type') return 'application/json';
        return headers[name] ?? null;
      },
    },
    text: () => Promise.resolve(JSON.stringify({ data })),
  };
}

describe('apiFetch', () => {
  it('sends correct headers for GET', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ id: 1 }));
    await apiFetch('/test');
    const [, init] = mockFetch.mock.calls[0]!;
    expect(init.headers['X-API-Key']).toBe('test-key');
    expect(init.headers['X-Tenant-Id']).toBe('test-tenant');
    expect(init.headers['Content-Type']).toBeUndefined();
  });

  it('adds Content-Type for POST', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ ok: true }));
    await apiFetch('/test', { method: 'POST', body: '{}' });
    const [, init] = mockFetch.mock.calls[0]!;
    expect(init.headers['Content-Type']).toBe('application/json');
  });

  it('unwraps { data } envelope', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ name: 'test' }));
    const result = await apiFetch<{ name: string }>('/test');
    expect(result).toEqual({ name: 'test' });
  });

  it('preserves multi-field envelopes (data + pagination + summary) intact', async () => {
    /* Regression: previously apiFetch unconditionally returned json.data,
     * dropping pagination/summary siblings. EnterpriseConsole + similar
     * pages need the whole envelope. */
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: {
        get: (k: string) => (k === 'content-type' ? 'application/json' : null),
      },
      text: () => Promise.resolve(JSON.stringify({
        data: [{ id: 1 }, { id: 2 }],
        pagination: { page: 1, pageSize: 20, total: 2 },
        summary: { total: 2, active: 2 },
      })),
    });
    type Resp = { data: Array<{ id: number }>; pagination: { total: number }; summary: { total: number } };
    const result = await apiFetch<Resp>('/multi');
    expect(result.data).toHaveLength(2);
    expect(result.pagination.total).toBe(2);
    expect(result.summary.total).toBe(2);
  });

  it('throws ApiError on non-ok response', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 404,
      text: () => Promise.resolve('Not Found'),
    });
    await expect(apiFetch('/missing')).rejects.toThrow(ApiError);
    try {
      await apiFetch('/missing');
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      expect((e as ApiError).status).toBe(404);
    }
  });

  it('returns undefined for 204 No Content', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 204,
      headers: { get: () => null },
      text: () => Promise.resolve(''),
    });
    const result = await apiFetch('/empty');
    expect(result).toBeUndefined();
  });

  it('returns undefined for non-JSON content type', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: {
        get: (name: string) => {
          if (name === 'content-length') return '5';
          if (name === 'content-type') return 'text/plain';
          return null;
        },
      },
      text: () => Promise.resolve('hello'),
    });
    const result = await apiFetch('/text');
    expect(result).toBeUndefined();
  });

  it('handles empty body gracefully', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: {
        get: (name: string) => {
          if (name === 'content-type') return 'application/json';
          return null;
        },
      },
      text: () => Promise.resolve(''),
    });
    const result = await apiFetch('/empty-json');
    expect(result).toBeUndefined();
  });

  it('handles whitespace-only body', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: {
        get: (name: string) => {
          if (name === 'content-type') return 'application/json';
          return null;
        },
      },
      text: () => Promise.resolve('   \n  '),
    });
    const result = await apiFetch('/whitespace');
    expect(result).toBeUndefined();
  });

  it('throws ApiError on invalid JSON body', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: {
        get: (name: string) => {
          if (name === 'content-type') return 'application/json';
          return null;
        },
      },
      text: () => Promise.resolve('{invalid json}'),
    });
    await expect(apiFetch('/bad-json')).rejects.toThrow(ApiError);
  });

  it('sanitizes error messages containing SQL keywords', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.resolve('SELECT * FROM users WHERE 1=1'),
    });
    try {
      await apiFetch('/sql-leak');
    } catch (e) {
      expect((e as ApiError).message).not.toContain('SELECT');
      expect((e as ApiError).message).toContain('500');
    }
  });

  it('extracts message from JSON error responses', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 409,
      text: () => Promise.resolve(JSON.stringify({
        error: 'StateError',
        code: 'STATE_INVALID_TRANSITION',
        message: 'Stripe 计费未启用，本地开发环境无需配置',
      })),
    });
    try {
      await apiFetch('/billing/checkout');
    } catch (e) {
      expect((e as ApiError).message).toBe('API 409: Stripe 计费未启用，本地开发环境无需配置');
    }
  });

  it('prepends API_BASE_URL to path', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ ok: true }));
    await apiFetch('/api/v1/test');
    const [url] = mockFetch.mock.calls[0]!;
    expect(url).toBe('http://test-api/api/v1/test');
  });
});

describe('ApiError', () => {
  it('has name, status, and message', () => {
    const err = new ApiError(422, 'Validation failed');
    expect(err.name).toBe('ApiError');
    expect(err.status).toBe(422);
    expect(err.message).toBe('Validation failed');
    expect(err).toBeInstanceOf(Error);
    /* 默认字段保留为 null，保持向后兼容 */
    expect(err.code).toBeNull();
    expect(err.messageId).toBeNull();
    expect(err.fields).toBeNull();
  });

  it('exposes code, messageId, and fields when backend returns them', () => {
    const err = new ApiError(409, 'API 409: conflict', 'STATE_INVALID_TRANSITION', 'state.transition.blocked', { entityId: 'p_42' });
    expect(err.code).toBe('STATE_INVALID_TRANSITION');
    expect(err.messageId).toBe('state.transition.blocked');
    expect(err.fields).toEqual({ entityId: 'p_42' });
  });
});

describe('apiFetch — extended error contract', () => {
  it('extracts code + messageId from JSON error body', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 429,
      text: () => Promise.resolve(JSON.stringify({
        error: 'RateLimitError',
        code: 'RATE_LIMIT_EXCEEDED',
        message: 'Quota exceeded for tenant',
        messageId: 'quota.exceeded',
      })),
    });
    try {
      await apiFetch('/api/v2/version');
    } catch (e) {
      const err = e as ApiError;
      expect(err.status).toBe(429);
      expect(err.code).toBe('RATE_LIMIT_EXCEEDED');
      expect(err.messageId).toBe('quota.exceeded');
    }
  });

  it('keeps code/messageId null when body is not JSON', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 502,
      text: () => Promise.resolve('upstream gateway error'),
    });
    try {
      await apiFetch('/foo');
    } catch (e) {
      const err = e as ApiError;
      expect(err.code).toBeNull();
      expect(err.messageId).toBeNull();
    }
  });

  it('tolerates non-string `message` in the error body (no TypeError)', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 400,
      text: () => Promise.resolve(JSON.stringify({
        error: 'ValidationError',
        code: 'VALIDATION_FAILED',
        message: { x: 1, y: 'unexpected shape' },
      })),
    });
    try {
      await apiFetch('/api/v1/auth/register', { method: 'POST', body: '{}' });
      throw new Error('expected ApiError');
    } catch (e) {
      const err = e as ApiError;
      expect(err).toBeInstanceOf(ApiError);
      expect(err.status).toBe(400);
      /* code 仍然要保留 — 是机器可读的稳定字段 */
      expect(err.code).toBe('VALIDATION_FAILED');
      /* message 应回退到通用 "API request failed" 而不是抛 TypeError */
      expect(err.message).toBe('API request failed (400)');
    }
  });

  it('tolerates null message in the error body', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.resolve(JSON.stringify({ code: 'INTERNAL', message: null })),
    });
    try {
      await apiFetch('/foo');
      throw new Error('expected ApiError');
    } catch (e) {
      const err = e as ApiError;
      expect(err.code).toBe('INTERNAL');
      expect(err.message).toBe('API request failed (500)');
    }
  });

  it('exposes ValidationError fields untouched', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 400,
      text: () => Promise.resolve(JSON.stringify({
        error: 'ValidationError',
        code: 'VALIDATION_FAILED',
        message: 'Invalid input',
        fields: { email: 'must be valid', password: 'too short' },
      })),
    });
    try {
      await apiFetch('/api/v1/auth/register', { method: 'POST', body: '{}' });
    } catch (e) {
      const err = e as ApiError;
      expect(err.code).toBe('VALIDATION_FAILED');
      expect(err.fields).toEqual({ email: 'must be valid', password: 'too short' });
    }
  });
});
