import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/* 只 mock sidecar-endpoint + tauri-commands + http-client 的 token getter/setter；**不 mock fetch 逻辑**——
 * bootstrapLocalSession 用真实 fetch（Codex S5 复审：上版 mock apiFetch 掩盖了「apiFetch 前置要求 token」致命）。 */
const sc = vi.hoisted(() => ({ endpoint: null as { baseUrl: string; handshakeToken: string; instanceNonce: string } | null }));
vi.mock('./sidecar-endpoint', () => ({ getSidecarEndpoint: vi.fn(async () => sc.endpoint) }));

const tok = vi.hoisted(() => ({ value: null as string | null }));
vi.mock('./http-client', () => ({
  getApiToken: vi.fn(() => tok.value),
  setApiToken: vi.fn((t: string | null) => { tok.value = t; }),
}));

const store = vi.hoisted(() => ({ map: new Map<string, string>() }));
const markLocal = vi.hoisted(() => ({ fn: vi.fn(async () => {}) }));
vi.mock('./tauri-commands', () => ({
  getAppSetting: vi.fn(async (k: string) => store.map.get(k) ?? null),
  setAppSetting: vi.fn(async (k: string, v: string) => { store.map.set(k, v); }),
  /* settleLocalSync 动态 import 本模块调 markSyncLocal——必须导出，否则被 try/catch 吞掉、新行为无覆盖。 */
  markSyncLocal: markLocal.fn,
}));

import { bootstrapLocalSession, settleLocalSync } from './bootstrap-local';

const SIDE = { baseUrl: 'http://127.0.0.1:5000', handshakeToken: 'hs-tok', instanceNonce: 'n' };
function jsonRes(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

beforeEach(() => {
  sc.endpoint = null;
  tok.value = null;
  store.map.clear();
  markLocal.fn.mockClear();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});
afterEach(() => vi.unstubAllGlobals());

describe('bootstrapLocalSession（ADR-0061 S5 单机自动 provision）', () => {
  it('无本地 sidecar（远端模式）→ false，不动凭据，且不标 local（远端态不污染）', async () => {
    sc.endpoint = null;
    vi.stubGlobal('fetch', vi.fn());
    expect(await bootstrapLocalSession()).toBe(false);
    expect(tok.value).toBeNull();
    expect(markLocal.fn).not.toHaveBeenCalled();
  });

  it('★首启（无 token 无密码）→ 真实 fetch register 拿 token（不受 apiFetch token 前置约束）★', async () => {
    sc.endpoint = SIDE;
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
      if (String(url).endsWith('/register')) return jsonRes(201, { data: { accessToken: 'new-jwt' } });
      return jsonRes(400, {});
    });
    vi.stubGlobal('fetch', fetchMock);
    expect(await bootstrapLocalSession()).toBe(true);
    expect(tok.value).toBe('new-jwt');
    /* 单机成功路径落 local 同步态（修「永久 syncing」）。 */
    expect(markLocal.fn).toHaveBeenCalledTimes(1);
    /* 密码持久 + register 请求真发出（带握手头）。 */
    expect(store.map.get('chrono.local.adminPassword')).toBeTruthy();
    const call = fetchMock.mock.calls.find((c) => String(c[0]).endsWith('/register'))!;
    expect((call[1] as RequestInit).headers).toMatchObject({ 'x-chrono-desktop-session': 'hs-tok' });
    /* auth 请求不带 authorization（免 token）。 */
    expect(((call[1] as RequestInit).headers as Record<string, string>).authorization).toBeUndefined();
  });

  it('已有 token 且仍有效（/companion/me 200）→ 幂等 true，不重新 login', async () => {
    sc.endpoint = SIDE;
    tok.value = 'valid-jwt';
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).endsWith('/companion/me')) return jsonRes(200, { data: {} });
      throw new Error('不应调 auth');
    });
    vi.stubGlobal('fetch', fetchMock);
    expect(await bootstrapLocalSession()).toBe(true);
    expect(tok.value).toBe('valid-jwt');
    /* 幂等 true 路径也落 local（重启后既有有效 token 仍要标本地态）。 */
    expect(markLocal.fn).toHaveBeenCalledTimes(1);
  });

  it('★已有 token 但过期（/companion/me 401）→ 清 token + 用持久密码重新 login★', async () => {
    sc.endpoint = SIDE;
    tok.value = 'stale-jwt';
    store.map.set('chrono.local.adminPassword', 'existing-pw');
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).endsWith('/companion/me')) return jsonRes(401, { code: 'AUTH_EXPIRED' });
      if (String(url).endsWith('/login')) return jsonRes(200, { data: { accessToken: 'fresh-jwt' } });
      return jsonRes(400, {});
    });
    vi.stubGlobal('fetch', fetchMock);
    expect(await bootstrapLocalSession()).toBe(true);
    expect(tok.value).toBe('fresh-jwt'); /* 过期 token 被换成新的 */
  });

  it('老用户（有密码无 token）→ 优先 login', async () => {
    sc.endpoint = SIDE;
    store.map.set('chrono.local.adminPassword', 'existing-pw');
    const order: string[] = [];
    const fetchMock = vi.fn(async (url: string) => {
      const u = String(url);
      if (u.endsWith('/login')) { order.push('login'); return jsonRes(200, { data: { accessToken: 'login-jwt' } }); }
      order.push('other'); return jsonRes(400, {});
    });
    vi.stubGlobal('fetch', fetchMock);
    expect(await bootstrapLocalSession()).toBe(true);
    expect(tok.value).toBe('login-jwt');
    expect(order[0]).toBe('login'); /* 老用户优先 login */
  });

  it('provision 全失败 → false（不静默假成功），不标 local', async () => {
    sc.endpoint = SIDE;
    vi.stubGlobal('fetch', vi.fn(async () => jsonRes(500, {})));
    expect(await bootstrapLocalSession()).toBe(false);
    expect(tok.value).toBeNull();
    expect(markLocal.fn).not.toHaveBeenCalled();
  });

  it('markSyncLocal 失败不致命（settleLocalSync 吞异常，仍返回成功）', async () => {
    sc.endpoint = SIDE;
    markLocal.fn.mockRejectedValueOnce(new Error('command not registered'));
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).endsWith('/register')) return jsonRes(201, { data: { accessToken: 'jwt' } });
      return jsonRes(400, {});
    });
    vi.stubGlobal('fetch', fetchMock);
    expect(await bootstrapLocalSession()).toBe(true); /* 标 local 失败不影响会话就绪 */
    expect(tok.value).toBe('jwt');
    expect(markLocal.fn).toHaveBeenCalledTimes(1);
  });
});

describe('settleLocalSync（每次启动标 local——修 onboarded 老用户永久 Syncing）', () => {
  it('有本地 sidecar → 调 markSyncLocal（不依赖 provision / onboarding）', async () => {
    sc.endpoint = SIDE;
    await settleLocalSync();
    expect(markLocal.fn).toHaveBeenCalledTimes(1);
  });

  it('无本地 sidecar（远端模式）→ 轮询超时后跳过，不标 local', async () => {
    sc.endpoint = null;
    /* 用假定时器把 ~10s 轮询推进到超时，避免真等。 */
    vi.useFakeTimers();
    try {
      const p = settleLocalSync();
      await vi.runAllTimersAsync();
      await p;
    } finally {
      vi.useRealTimers();
    }
    expect(markLocal.fn).not.toHaveBeenCalled();
  });

  it('markSyncLocal 抛错被吞（失败不致命，下次启动再标）', async () => {
    sc.endpoint = SIDE;
    markLocal.fn.mockRejectedValueOnce(new Error('db locked'));
    await expect(settleLocalSync()).resolves.toBeUndefined();
    expect(markLocal.fn).toHaveBeenCalledTimes(1);
  });
});
