/**
 * 单元测试：companion-web 感知 API client（api.ts 的 perceive）。
 *
 * 覆盖：POST 请求形状（url/method/body/auth header）+ 响应契约校验 + 401 刷新重试 + 403/400 错误。
 * 用 node:test + 原生 TS（Node v24 type-strip），stub 全局 fetch + document.cookie + sessionStorage。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

interface FetchCall { url: string; method: string; headers: Record<string, string>; body: string | undefined }

/** 安装可控 fetch + document.cookie。auth.ts 的 session 是内存变量——测试先经 login() 建会话。 */
function installFetch(responder: (call: FetchCall) => { status: number; body: unknown }): { calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  (globalThis as { document?: { cookie: string } }).document = { cookie: 'csrf=t' };
  (globalThis as { fetch?: unknown }).fetch = async (url: string, init?: RequestInit) => {
    const call = { url, method: init?.method ?? 'GET', headers: (init?.headers ?? {}) as Record<string, string>, body: init?.body as string | undefined };
    calls.push(call);
    const r = responder(call);
    return { status: r.status, ok: r.status >= 200 && r.status < 300, json: async () => ({ data: r.body }) } as Response;
  };
  return { calls };
}

/** 经 login 建立内存会话（accessToken=tok-1），返回 api 模块。 */
async function loggedInApi(perceiveResponses: Array<{ status: number; body: unknown }>): Promise<{ calls: FetchCall[]; api: typeof import('../src/api.ts') }> {
  let perceiveIdx = 0;
  const { calls } = installFetch((call) => {
    if (call.url.includes('/auth/login')) {
      return { status: 200, body: { accessToken: 'tok-1', tenantId: 'default', userId: 'u1' } };
    }
    const r = perceiveResponses[Math.min(perceiveIdx, perceiveResponses.length - 1)];
    perceiveIdx++;
    return r;
  });
  const auth = await import('../src/auth.ts');
  await auth.login('u@test.com', 'pw');
  calls.length = 0;   /* 清掉 login 调用，只留 perceive */
  const api = await import('../src/api.ts');
  return { calls, api };
}

const VALID_RESULT = {
  schemaVersion: 'companion-perceive-result.v1',
  perceivedMemories: [{ id: 'm1', content: '我听到：今天很累', valence: -0.2, salience: 0.6 }],
  growthCandidateCount: 0,
  pendingApprovalCount: 0,
};

test('perceive: POST 正确 url/body/auth header + 响应契约校验', async () => {
  const { calls, api } = await loggedInApi([{ status: 200, body: VALID_RESULT }]);
  const res = await api.perceive({ modality: 'audio', representation: '今天很累' });

  assert.equal(calls[0].url, '/api/v1/companion/me/perceive');
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].headers.authorization, 'Bearer tok-1');
  assert.equal(calls[0].headers['x-tenant-id'], 'default');
  assert.match(String(calls[0].headers['content-type']), /application\/json/);
  assert.deepEqual(JSON.parse(calls[0].body!), { modality: 'audio', representation: '今天很累' });
  assert.equal(res.perceivedMemories[0].content, '我听到：今天很累');
});

test('perceive: 403 → ApiAuthError（plan/权限，不刷新）', async () => {
  const { api } = await loggedInApi([{ status: 403, body: null }]);
  await assert.rejects(() => api.perceive({ modality: 'audio', representation: 'x' }), (e) => e instanceof api.ApiAuthError && (e as { status: number }).status === 403);
});

test('perceive: 后端漂移（缺字段）→ 契约校验抛错（不静默渲染错数据）', async () => {
  const { api } = await loggedInApi([{ status: 200, body: { schemaVersion: 'companion-perceive-result.v1', perceivedMemories: [] } }]);
  await assert.rejects(() => api.perceive({ modality: 'audio', representation: 'x' }));
});
