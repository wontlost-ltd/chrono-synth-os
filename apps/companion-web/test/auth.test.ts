/**
 * 单元测试：companion-web 会话层（auth.ts）的浏览器侧行为。
 *
 * 核心是几个易回归的竞态/安全点（Codex 审查要求直接覆盖）：
 *   - refresh single-flight：并发 401 只触发一次 /auth/refresh；
 *   - logout 带 x-csrf-token（否则被后端 CSRF guard 403，refresh token 不吊销）；
 *   - epoch 守卫：logout 后到达的陈旧 refresh 结果不得把会话写回。
 *
 * 用 node:test + 原生 TS 运行（Node v24 type-strip），stub 全局 fetch 与 document.cookie，
 * 不引入 vitest/jsdom。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide401Action } from '../src/api-retry.ts';

interface FetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
}

/** 安装可控的全局 fetch + document.cookie，返回调用记录与一个手动放行 refresh 的钩子。 */
function installEnv(): {
  calls: FetchCall[];
  setCookie: (c: string) => void;
  /** 让下一个 /auth/refresh 响应挂起，返回一个 resolve 函数手动放行（测竞态）。 */
  deferNextRefresh: () => (body: unknown, ok?: boolean) => void;
  /** 每次 fetch 发出时的同步观察钩子（用于断言「发出请求那一刻」的状态）。 */
  setOnFetch: (fn: (url: string) => void) => void;
} {
  const calls: FetchCall[] = [];
  let cookie = '';
  let deferred: { resolve: (r: Response) => void } | null = null;
  let onFetch: ((url: string) => void) | undefined;

  (globalThis as { document?: { cookie: string } }).document = {
    get cookie() { return cookie; },
    set cookie(v: string) { cookie = v; },
  };

  function jsonResponse(body: unknown, ok: boolean): Response {
    return {
      ok,
      status: ok ? 200 : 401,
      json: async () => body,
    } as Response;
  }

  (globalThis as { fetch?: unknown }).fetch = async (url: string, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url, method: init?.method ?? 'GET', headers });
    onFetch?.(url);
    if (url.includes('/auth/refresh') && deferred) {
      return new Promise<Response>((resolve) => { deferred!.resolve = resolve; });
    }
    if (url.includes('/auth/login')) {
      return jsonResponse({ data: { accessToken: 'at-login', tenantId: 't1' } }, true);
    }
    if (url.includes('/auth/refresh')) {
      return jsonResponse({ data: { accessToken: 'at-refresh', tenantId: 't1' } }, true);
    }
    return jsonResponse({ data: {} }, true);
  };

  return {
    calls,
    setCookie: (c) => { cookie = c; },
    setOnFetch: (fn) => { onFetch = fn; },
    deferNextRefresh: () => {
      deferred = { resolve: () => {} };
      return (body: unknown, ok = true) => {
        deferred!.resolve(jsonResponse(body, ok));
        deferred = null;
      };
    },
  };
}

test('logout 携带 x-csrf-token + Authorization，并在请求发出之后才清空会话', async () => {
  const env = installEnv();
  env.setCookie('csrf_token=csrf-abc; other=x');
  const auth = await import('../src/auth.ts?logout' as string);

  await auth.login('a@test.com', 'pw');
  assert.equal(auth.isAuthenticated(), true);

  /* 断言「发出 logout 请求那一刻」会话仍在（先发请求再清，否则吊销会带不上凭证）。 */
  let authedAtLogoutFetch: boolean | null = null;
  env.setOnFetch((url) => {
    if (url.includes('/auth/logout')) authedAtLogoutFetch = auth.isAuthenticated();
  });

  await auth.logout();
  const logoutCall = env.calls.find((c) => c.url.includes('/auth/logout'));
  assert.ok(logoutCall, 'logout 应发出请求');
  assert.equal(logoutCall.headers['x-csrf-token'], 'csrf-abc', 'logout 必须带 CSRF header');
  assert.equal(logoutCall.headers['authorization'], 'Bearer at-login', 'logout 应带当前 access token');
  assert.equal(authedAtLogoutFetch, true, '发出 logout 请求时会话必须仍在');
  assert.equal(auth.isAuthenticated(), false, 'logout 完成后会话已清空');
});

test('refresh single-flight：并发 tryRefresh 只触发一次 /auth/refresh', async () => {
  const env = installEnv();
  env.setCookie('csrf_token=csrf-zzz');
  const auth = await import('../src/auth.ts?single' as string);

  await auth.login('b@test.com', 'pw');
  const release = env.deferNextRefresh();

  const p1 = auth.tryRefresh();
  const p2 = auth.tryRefresh();
  release({ data: { accessToken: 'at-refresh', tenantId: 't1' } });
  const [r1, r2] = await Promise.all([p1, p2]);

  const refreshCalls = env.calls.filter((c) => c.url.includes('/auth/refresh'));
  assert.equal(refreshCalls.length, 1, '并发 refresh 只应有一次网络请求');
  assert.equal(r1, 'refreshed');
  assert.equal(r2, 'refreshed');
  assert.equal(refreshCalls[0].headers['x-csrf-token'], 'csrf-zzz', 'refresh 必须带 CSRF header');
});

test('epoch 守卫：logout 后到达的陈旧 refresh 结果不把会话写回', async () => {
  const env = installEnv();
  env.setCookie('csrf_token=csrf-1');
  const auth = await import('../src/auth.ts?epoch' as string);

  await auth.login('c@test.com', 'pw');
  const release = env.deferNextRefresh();

  const refreshP = auth.tryRefresh();   // refresh 在途
  await auth.logout();                   // 期间登出（epoch 自增）
  assert.equal(auth.isAuthenticated(), false);

  release({ data: { accessToken: 'at-stale', tenantId: 't1' } }); // 陈旧 refresh 现在才返回
  const result = await refreshP;
  assert.equal(result, 'superseded', '陈旧 refresh 应被 epoch 守卫标记为 superseded');
  assert.equal(auth.isAuthenticated(), false, 'logout 后不得被在途 refresh 恢复登录');
});

test('tryRefresh failed 路径：refresh 非 ok / 畸形 body / fetch 抛错 → failed 且同 epoch 清会话', async () => {
  /* 非 ok */
  {
    const auth = await import('../src/auth.ts?fail1' as string);
    (globalThis as { document?: { cookie: string } }).document = { cookie: 'csrf_token=c' };
    (globalThis as { fetch?: unknown }).fetch = async (url: string) =>
      url.includes('/auth/login')
        ? ({ ok: true, status: 200, json: async () => ({ data: { accessToken: 'a', tenantId: 't' } }) } as Response)
        : ({ ok: false, status: 401, json: async () => ({}) } as Response);
    await auth.login('e@test.com', 'pw');
    assert.equal(await auth.tryRefresh(), 'failed');
    assert.equal(auth.isAuthenticated(), false, 'failed 应清会话');
  }
  /* 畸形 body（ok 但缺 token） */
  {
    const auth = await import('../src/auth.ts?fail2' as string);
    (globalThis as { document?: { cookie: string } }).document = { cookie: 'csrf_token=c' };
    (globalThis as { fetch?: unknown }).fetch = async (url: string) =>
      url.includes('/auth/login')
        ? ({ ok: true, status: 200, json: async () => ({ data: { accessToken: 'a', tenantId: 't' } }) } as Response)
        : ({ ok: true, status: 200, json: async () => ({ data: {} }) } as Response);
    await auth.login('f@test.com', 'pw');
    assert.equal(await auth.tryRefresh(), 'failed', '畸形 body 应 failed');
    assert.equal(auth.isAuthenticated(), false);
  }
  /* fetch 抛错 */
  {
    const auth = await import('../src/auth.ts?fail3' as string);
    (globalThis as { document?: { cookie: string } }).document = { cookie: 'csrf_token=c' };
    let phase = 'login';
    (globalThis as { fetch?: unknown }).fetch = async (url: string) => {
      if (url.includes('/auth/login')) { phase = 'refresh'; return { ok: true, status: 200, json: async () => ({ data: { accessToken: 'a', tenantId: 't' } }) } as Response; }
      if (phase === 'refresh') throw new Error('network down');
      return { ok: true, status: 200, json: async () => ({ data: {} }) } as Response;
    };
    await auth.login('g@test.com', 'pw');
    assert.equal(await auth.tryRefresh(), 'failed', 'fetch 抛错应 failed');
    assert.equal(auth.isAuthenticated(), false);
  }
});

test('decide401Action：会话身份决定刷新还是「陈旧 401」用当前会话重试', () => {
  /* 同一会话（token 未变）→ refresh */
  assert.equal(decide401Action('tok-A', 'tok-A'), 'refresh');
  /* 发请求时未登录、现仍未登录 → refresh（让 refresh 流程判定 failed） */
  assert.equal(decide401Action(null, null), 'refresh');
  /* 关键 round-5 残窗：发请求用旧 token，期间 login 换了新 token → 陈旧 401，用当前会话重试，不 refresh */
  assert.equal(decide401Action('tok-old', 'tok-new'), 'retry-current');
  /* 发请求时已登录，期间 logout（现为 null）→ 陈旧 401，retry-current（不 refresh、不清会话） */
  assert.equal(decide401Action('tok-old', null), 'retry-current');
  /* 发请求时未登录，期间 login → 也是会话身份变化，retry-current */
  assert.equal(decide401Action(null, 'tok-new'), 'retry-current');
});
