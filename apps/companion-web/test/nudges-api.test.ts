/**
 * 单元测试：companion-web 主动消息 API client（api.ts 的 fetchNudges / markNudgeRead）。
 * 覆盖：GET url + 契约校验、markNudgeRead POST url/method、契约不符即抛（防 DTO 漂移）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

interface FetchCall { url: string; method: string; headers: Record<string, string>; body: string | undefined }

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

async function loggedInApi(nudgeResponses: Array<{ status: number; body: unknown }>): Promise<{ calls: FetchCall[]; api: typeof import('../src/api.ts') }> {
  let idx = 0;
  const { calls } = installFetch((call) => {
    if (call.url.includes('/auth/login')) {
      return { status: 200, body: { accessToken: 'tok-1', tenantId: 'default', userId: 'u1' } };
    }
    const r = nudgeResponses[Math.min(idx, nudgeResponses.length - 1)];
    idx++;
    return r;
  });
  const auth = await import('../src/auth.ts');
  await auth.login('u@test.com', 'pw');
  calls.length = 0;
  const api = await import('../src/api.ts');
  return { calls, api };
}

const VALID_LIST = {
  schemaVersion: 'companion-nudge-list.v1',
  items: [
    { id: 'pmsg-1', kind: 'growth', body: '我好像又成长了一点。', status: 'unread', createdAt: 1_700_000_000_000, readAt: null },
  ],
};

test('fetchNudges：GET 正确 url（带 status=all）+ 契约校验通过', async () => {
  const { calls, api } = await loggedInApi([{ status: 200, body: VALID_LIST }]);
  const res = await api.fetchNudges('all');
  assert.equal(calls[0].method, 'GET');
  assert.match(calls[0].url, /\/api\/v1\/companion\/me\/nudges\?status=all$/);
  assert.equal(res.items.length, 1);
  assert.equal(res.items[0].body, '我好像又成长了一点。');
});

test('fetchNudges：缺省 status=unread', async () => {
  const { calls, api } = await loggedInApi([{ status: 200, body: { ...VALID_LIST, items: [] } }]);
  await api.fetchNudges();
  assert.match(calls[0].url, /\?status=unread$/);
});

test('fetchNudges：响应不符契约（多余字段）→ 抛（防 DTO 漂移）', async () => {
  const bad = { ...VALID_LIST, items: [{ ...VALID_LIST.items[0], signal_type: 'leak' }] };
  const { api } = await loggedInApi([{ status: 200, body: bad }]);
  await assert.rejects(() => api.fetchNudges('all'), '多余内部字段应被 strict 契约拒绝');
});

test('markNudgeRead：POST 到正确 url（id 转义）', async () => {
  const { calls, api } = await loggedInApi([{ status: 200, body: { id: 'pmsg-1', status: 'read' } }]);
  await api.markNudgeRead('pmsg-1');
  assert.equal(calls[0].method, 'POST');
  assert.match(calls[0].url, /\/api\/v1\/companion\/me\/nudges\/pmsg-1\/read$/);
});
