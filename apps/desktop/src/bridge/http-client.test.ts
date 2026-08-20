import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/* clearCachedAccountPlan 动态 import 这个模块清 account.plan；mock 掉 setAppSetting 以验证清缓存行为。 */
vi.mock('./tauri-commands', () => ({
  setAppSetting: vi.fn(async () => undefined),
}));

/**
 * ⚠️ 必须 mock：`clearAccountScopedCaches()` 里有
 * `await import('@/companion/growth-data')`。不 mock 时 vitest 要在**用例执行
 * 中途**现场解析并转译它的整张依赖图，实测是**秒级**的（同目录的
 * `account-plan`/`sidecar-endpoint` 都只要个位数毫秒），逼近 5000ms 单用例超时
 * ——文件里第一个用例承担这份冷成本，机器一忙就报
 * `Test timed out in 5000ms`（**超时，不是断言失败**）。
 *
 * 成本主要来自 growth-data 静态 import 的 **`@chrono/contracts`**（整个 workspace
 * 包），实测它单独就占大头；不是 growth-data↔http-client 那个环。
 * 具体测量数字见提交说明，不写进源码以免随机器过时。
 *
 * mock 掉后这条链在测试里根本不会被加载；本文件只需验证「凭据变化会去调
 * 清理入口」这一协调行为，清理**本身**的副作用由 `growth-data.test.ts` 覆盖。
 *
 * 注意**原来并没有**针对 growth 缓存的断言 —— 直接 mock 会把「换凭据必须清
 * growth」这条要求变成零覆盖，故一并补上调用断言。
 */
vi.mock('@/companion/growth-data', () => ({
  clearCachedCompanionGrowth: vi.fn(async () => undefined),
}));

/* ADR-0061 S2：mock sidecar 端点桥，验 apiFetch 的本地 sidecar 优先 + 陈旧重试逻辑（Codex 复审补测试）。 */
const sidecarEp = vi.hoisted(() => ({
  endpoint: null as { baseUrl: string; handshakeToken: string; instanceNonce: string } | null,
  getCalls: 0,
  invalidateCalls: 0,
}));
vi.mock('./sidecar-endpoint', () => ({
  getSidecarEndpoint: vi.fn(async () => { sidecarEp.getCalls++; return sidecarEp.endpoint; }),
  invalidateSidecarEndpoint: vi.fn(() => { sidecarEp.invalidateCalls++; }),
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
import { clearCachedCompanionGrowth } from '@/companion/growth-data';
import { APP_SETTING_ACCOUNT_PLAN } from '@/plan/account-plan';

const STORAGE_BASE = 'chrono.api.baseUrl';
const STORAGE_TOKEN = 'chrono.api.token';

const setAppSettingMock = setAppSetting as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  sidecarEp.endpoint = null;
  sidecarEp.getCalls = 0;
  sidecarEp.invalidateCalls = 0;
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

  it('凭据变化也要清 companion growth 缓存（换账号不得串显旧用户成长）', async () => {
    /* growth 是用户画像数据，必须跟凭据生命周期一起清。
     * 这条断言在 mock 掉 growth-data 之前是缺失的——补上，避免为了消除
     * 慢导入而把这条要求变成零覆盖。 */
    await setApiCredentials({ token: 'jwt-another' });
    expect(clearCachedCompanionGrowth).toHaveBeenCalledTimes(1);
    /* plan 与 growth 都要清，缺一不可（两者都绑当前账号）。 */
    expect(setAppSettingMock).toHaveBeenCalledWith(APP_SETTING_ACCOUNT_PLAN, '');
  });


  it('值未变化 → 不清缓存（避免无谓写）', async () => {
    setApiBaseUrl('https://same.example.com');
    setApiToken('jwt-same');
    setAppSettingMock.mockClear();
    await setApiCredentials({ baseUrl: 'https://same.example.com', token: 'jwt-same' });
    expect(setAppSettingMock).not.toHaveBeenCalled();
    /* 用例名说的是「不清缓存」，那 growth 也必须没被清——否则名不副实。 */
    expect(clearCachedCompanionGrowth).not.toHaveBeenCalled();
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

  /* 审计 Critical 9：token 改存 OS 密钥库，**绝不落 localStorage 明文**。
   * 进程内保留内存缓存以维持同步 getApiToken() 语义（调用方零改造）。 */
  it('round-trips token in memory without writing plaintext to disk', () => {
    setApiToken('jwt-x');
    expect(getApiToken()).toBe('jwt-x');
    expect(localStorage.getItem(STORAGE_TOKEN)).toBeNull();
  });

  it('never leaves a plaintext token on disk even after repeated sets', () => {
    setApiToken('jwt-a');
    setApiToken('jwt-b');
    expect(getApiToken()).toBe('jwt-b');
    expect(localStorage.getItem(STORAGE_TOKEN)).toBeNull();
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

describe('apiFetch — ADR-0061 S2 本地 sidecar 优先 + 陈旧重试', () => {
  beforeEach(() => {
    setApiToken('jwt-x'); /* sidecar 模式仍需 JWT token */
    sidecarEp.endpoint = { baseUrl: 'http://127.0.0.1:50000', handshakeToken: 'hs-token-1', instanceNonce: 'n1' };
  });

  it('有 sidecar → 用其 base + 带 X-Chrono-Desktop-Session 握手头（红线 11）', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    await apiFetch('/api/v1/personas');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://127.0.0.1:50000/api/v1/personas');
    expect((init.headers as Record<string, string>)['x-chrono-desktop-session']).toBe('hs-token-1');
  });

  it('★握手失效 403（code=AUTH_MISSING_DESKTOP_SESSION）→ 失效缓存 + 重取端点 + 重试一次（拿新 token）★', async () => {
    /* 第一次握手失效 403（带专用 code），重取端点后返回新 token，第二次 200。 */
    let call = 0;
    const fetchMock = vi.fn().mockImplementation(async () => {
      call++;
      if (call === 1) return new Response(JSON.stringify({ code: 'AUTH_MISSING_DESKTOP_SESSION' }), { status: 403, headers: { 'content-type': 'application/json' } });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    /* 重取端点时给新 token（模拟 sidecar 重启）。 */
    const { getSidecarEndpoint } = await import('./sidecar-endpoint');
    (getSidecarEndpoint as unknown as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      sidecarEp.getCalls++;
      return sidecarEp.getCalls >= 2 ? { baseUrl: 'http://127.0.0.1:50001', handshakeToken: 'hs-token-2', instanceNonce: 'n2' } : sidecarEp.endpoint;
    });
    const r = await apiFetch<{ ok: boolean }>('/api/v1/personas');
    expect(r).toEqual({ ok: true });
    expect(sidecarEp.invalidateCalls).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    /* 第二次用新 token。 */
    expect((fetchMock.mock.calls[1]![1].headers as Record<string, string>)['x-chrono-desktop-session']).toBe('hs-token-2');
  });

  it('★普通业务/RBAC 403（非握手码）→ POST 不重试（防重复副作用/掩盖真拒绝）★', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: 'AUTH_INSUFFICIENT_ROLE' }), { status: 403, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(apiFetch('/api/v1/personas', { method: 'POST', body: {} })).rejects.toThrow(/HTTP 403/);
    expect(sidecarEp.invalidateCalls).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('★POST + 网络错(TypeError) → 本次不重试（非幂等），但失效缓存让下次重取活端点（crash-restart follow-up）★', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    vi.stubGlobal('fetch', fetchMock);
    await expect(apiFetch('/api/v1/personas', { method: 'POST', body: {} })).rejects.toBeInstanceOf(TypeError);
    /* 失效缓存（无副作用，仅清缓存）——防「崩溃重启后 POST 反复打死端口」；但**本次不补发重试**（不可自证未触达）。 */
    expect(sidecarEp.invalidateCalls).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('GET + 网络错(TypeError) → 重试一次（安全方法）', async () => {
    let call = 0;
    const fetchMock = vi.fn().mockImplementation(async () => {
      call++;
      if (call === 1) throw new TypeError('Failed to fetch');
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    await apiFetch('/api/v1/personas'); /* 默认 GET */
    expect(sidecarEp.invalidateCalls).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
