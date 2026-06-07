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
} {
  const calls: FetchCall[] = [];
  let cookie = '';
  let deferred: { resolve: (r: Response) => void } | null = null;

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
    deferNextRefresh: () => {
      deferred = { resolve: () => {} };
      return (body: unknown, ok = true) => {
        deferred!.resolve(jsonResponse(body, ok));
        deferred = null;
      };
    },
  };
}

test('logout 携带 x-csrf-token，并在请求之后才清空会话', async () => {
  const env = installEnv();
  env.setCookie('csrf_token=csrf-abc; other=x');
  const auth = await import('../src/auth.ts?logout' as string);

  await auth.login('a@test.com', 'pw');
  assert.equal(auth.isAuthenticated(), true);

  await auth.logout();
  const logoutCall = env.calls.find((c) => c.url.includes('/auth/logout'));
  assert.ok(logoutCall, 'logout 应发出请求');
  assert.equal(logoutCall.headers['x-csrf-token'], 'csrf-abc', 'logout 必须带 CSRF header');
  assert.equal(auth.isAuthenticated(), false, 'logout 后会话已清空');
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
  assert.equal(r1, true);
  assert.equal(r2, true);
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
  assert.equal(result, false, '陈旧 refresh 应被 epoch 守卫丢弃');
  assert.equal(auth.isAuthenticated(), false, 'logout 后不得被在途 refresh 恢复登录');
});
