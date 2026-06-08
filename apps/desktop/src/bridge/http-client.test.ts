import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/* clearCachedAccountPlan 动态 import 这个模块清 account.plan；mock 掉 setAppSetting 以验证清缓存行为。 */
vi.mock('./tauri-commands', () => ({
  setAppSetting: vi.fn(async () => undefined),
}));

import {
  ApiNotConfiguredError,
  apiFetch,
  getApiBaseUrl,
  getApiToken,
  setApiBaseUrl,
  setApiToken,
  setApiCredentials,
} from './http-client';
import { setAppSetting } from './tauri-commands';
import { APP_SETTING_ACCOUNT_PLAN } from '@/plan/account-plan';

const STORAGE_BASE = 'chrono.api.baseUrl';
const STORAGE_TOKEN = 'chrono.api.token';

const setAppSettingMock = setAppSetting as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
});

afterEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
});

describe('setApiCredentials — 事务式凭据更新 + plan 缓存作废（Codex PR-A 复审 Major）', () => {
  it('baseUrl 变化 → 写 localStorage 并 await 清 account.plan', async () => {
    await setApiCredentials({ baseUrl: 'https://a.example.com//' });
    expect(getApiBaseUrl()).toBe('https://a.example.com'); // 尾斜杠已 trim
    expect(setAppSettingMock).toHaveBeenCalledWith(APP_SETTING_ACCOUNT_PLAN, '');
  });

  it('token 变化 → 清 account.plan', async () => {
    await setApiCredentials({ token: 'jwt-new' });
    expect(getApiToken()).toBe('jwt-new');
    expect(setAppSettingMock).toHaveBeenCalledWith(APP_SETTING_ACCOUNT_PLAN, '');
  });

  it('值未变化 → 不清缓存（避免无谓写）', async () => {
    setApiBaseUrl('https://same.example.com');
    setApiToken('jwt-same');
    setAppSettingMock.mockClear();
    await setApiCredentials({ baseUrl: 'https://same.example.com', token: 'jwt-same' });
    expect(setAppSettingMock).not.toHaveBeenCalled();
  });

  it('清除凭据（null）也算变化 → 清缓存', async () => {
    setApiToken('jwt-x');
    setAppSettingMock.mockClear();
    await setApiCredentials({ token: null });
    expect(getApiToken()).toBeNull();
    expect(setAppSettingMock).toHaveBeenCalledWith(APP_SETTING_ACCOUNT_PLAN, '');
  });

  it('清缓存失败被吞掉，不让凭据更新流程抛', async () => {
    setAppSettingMock.mockRejectedValueOnce(new Error('db locked'));
    await expect(setApiCredentials({ token: 'jwt-y' })).resolves.toBeUndefined();
    expect(getApiToken()).toBe('jwt-y');
  });

  it('同步 setApiBaseUrl/setApiToken 不再自行清缓存（清缓存只属事务式 API）', () => {
    setApiBaseUrl('https://b.example.com');
    setApiToken('jwt-z');
    expect(setAppSettingMock).not.toHaveBeenCalled();
  });
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
