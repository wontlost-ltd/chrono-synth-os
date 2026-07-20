/**
 * 单元测试：GitHubWritePort（GitHub 写端点，Plan 4 反馈发布段消费）
 *
 * 本 port 是整个 GitHub 集成里**唯一能写 GitHub 的模块**（对 issue 发评论 /
 *   对 PR 发 COMMENT 型 review）。写侧与 Plan 1 的只读 ReadPort 严格分离，
 *   Task 4 的 highRisk 写工具是它唯一持有者。
 *
 * 所有出站请求都经注入的 fetchImpl（mock githubFetch，即 SSRF 网关）+ 注入的
 *   auth（mock GitHubAuthManager），不真连 GitHub。断言：
 *   - createIssueComment 打 POST /repos/<repo>/issues/<n>/comments，带
 *     `Authorization: token <installation-token>` + body JSON `{body}`；
 *   - createReview 打 POST /repos/<repo>/pulls/<n>/reviews，body 含
 *     `event:'COMMENT'`（首版只发 COMMENT，不做 APPROVE/REQUEST_CHANGES）；
 *   - 非 2xx 响应 → 抛 StateError；
 *   - 解析返回 JSON 的 id + html_url（映射 htmlUrl）；
 *   - GHE：apiBase / hostAllowlist 透传给 githubFetch。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { GitHubWritePortImpl } from '../../integrations/github/github-write-port.js';
import { StateError } from '../../errors/index.js';
import type { GitHubAuthManager } from '../../integrations/github/github-auth-manager.js';
import type { githubFetch as GithubFetch } from '../../integrations/github/github-http.js';

/** 记录出站调用的 githubFetch spy；按预设队列依次返回 Response。 */
interface FetchCall {
  url: string;
  init: RequestInit;
  opts: unknown;
}
function makeFetchSpy(
  responses: Array<{ status?: number; body: string; headers?: Record<string, string> }>,
): { calls: FetchCall[]; impl: typeof GithubFetch } {
  const calls: FetchCall[] = [];
  let i = 0;
  const impl = (async (url: string, init: RequestInit, opts?: unknown) => {
    calls.push({ url, init, opts });
    const r = responses[Math.min(i, responses.length - 1)]!;
    i += 1;
    return new Response(r.body, {
      status: r.status ?? 200,
      headers: { 'content-type': 'application/json', ...(r.headers ?? {}) },
    });
  }) as unknown as typeof GithubFetch;
  return { calls, impl };
}

/** 返回固定 installation token 的 mock auth。 */
function makeAuth(token: string): GitHubAuthManager {
  return {
    getInstallationToken: async () => token,
  } as unknown as GitHubAuthManager;
}

/** 抛错的 mock auth（模拟 getApp 无凭据 → getInstallationToken throw）。 */
function makeThrowingAuth(): GitHubAuthManager {
  return {
    getInstallationToken: async () => {
      throw new Error('本租户未配置 GitHub App 凭据（getApp 返回 undefined）');
    },
  } as unknown as GitHubAuthManager;
}

/** 从调用里取 Authorization 头（headers 以对象形态传入）。 */
function header(call: FetchCall, name: string): string {
  return (call.init.headers as Record<string, string>)[name] ?? '';
}

/** 解析调用 body（JSON.stringify 后的 payload）。 */
function bodyOf(call: FetchCall): Record<string, unknown> {
  return JSON.parse(call.init.body as string) as Record<string, unknown>;
}

describe('GitHubWritePort', () => {
  it('createIssueComment 打 POST /repos/<repo>/issues/<n>/comments，带 token + body JSON', async () => {
    const resp = JSON.stringify({
      id: 12345,
      html_url: 'https://github.com/owner/repo/issues/7#issuecomment-12345',
    });
    const spy = makeFetchSpy([{ status: 201, body: resp }]);
    const port = new GitHubWritePortImpl(makeAuth('tok-abc'), { fetchImpl: spy.impl });

    const out = await port.createIssueComment('owner/repo', 7, '这是一条自动回评');

    assert.equal(spy.calls.length, 1);
    const call = spy.calls[0]!;
    /* URL 打到 /repos/owner/repo/issues/7/comments。 */
    assert.match(call.url, /\/repos\/owner\/repo\/issues\/7\/comments$/);
    /* method 必须是 POST。 */
    assert.equal(call.init.method, 'POST');
    /* 携带 installation token（token 前缀而非 Bearer）。 */
    assert.equal(header(call, 'Authorization'), 'token tok-abc');
    assert.equal(header(call, 'Accept'), 'application/vnd.github+json');
    assert.equal(header(call, 'Content-Type'), 'application/json');
    /* body 是 {body}。 */
    assert.deepEqual(bodyOf(call), { body: '这是一条自动回评' });
    /* 返回映射 id + htmlUrl。 */
    assert.equal(out.id, 12345);
    assert.equal(out.htmlUrl, 'https://github.com/owner/repo/issues/7#issuecomment-12345');
  });

  it("createReview 打 POST /repos/<repo>/pulls/<n>/reviews，body 含 event:'COMMENT'", async () => {
    const resp = JSON.stringify({
      id: 98765,
      html_url: 'https://github.com/owner/repo/pull/11#pullrequestreview-98765',
    });
    const spy = makeFetchSpy([{ status: 200, body: resp }]);
    const port = new GitHubWritePortImpl(makeAuth('tok-xyz'), { fetchImpl: spy.impl });

    const out = await port.createReview('owner/repo', 11, '整体没问题，几处小建议', 'COMMENT');

    assert.equal(spy.calls.length, 1);
    const call = spy.calls[0]!;
    assert.match(call.url, /\/repos\/owner\/repo\/pulls\/11\/reviews$/);
    assert.equal(call.init.method, 'POST');
    assert.equal(header(call, 'Authorization'), 'token tok-xyz');
    assert.equal(header(call, 'Content-Type'), 'application/json');
    /* body 含 event:'COMMENT'（首版锁死 COMMENT，绝不 APPROVE/REQUEST_CHANGES）。 */
    const payload = bodyOf(call);
    assert.equal(payload.body, '整体没问题，几处小建议');
    assert.equal(payload.event, 'COMMENT');
    /* 返回映射 id + htmlUrl。 */
    assert.equal(out.id, 98765);
    assert.equal(out.htmlUrl, 'https://github.com/owner/repo/pull/11#pullrequestreview-98765');
  });

  it('非 2xx 响应 → 抛 StateError', async () => {
    const spy = makeFetchSpy([{ status: 422, body: '{"message":"Validation Failed"}' }]);
    const port = new GitHubWritePortImpl(makeAuth('t'), { fetchImpl: spy.impl });

    await assert.rejects(
      () => port.createIssueComment('owner/repo', 7, 'x'),
      (err: unknown) => {
        assert.ok(err instanceof StateError, '须抛 StateError');
        assert.match((err as Error).message, /422|失败|GitHub/i);
        return true;
      },
    );
  });

  it('无凭据（auth throw）→ 抛错且不发出网络请求', async () => {
    const spy = makeFetchSpy([{ body: '{}' }]);
    const port = new GitHubWritePortImpl(makeThrowingAuth(), { fetchImpl: spy.impl });

    await assert.rejects(
      () => port.createReview('owner/repo', 1, 'x', 'COMMENT'),
      /GitHub|凭据|credential|未连接|未配置/i,
    );
    /* auth 先失败 → 绝不发出网络请求。 */
    assert.equal(spy.calls.length, 0, 'auth 失败时不应发请求');
  });

  it('解析返回 id + html_url→htmlUrl', async () => {
    const resp = JSON.stringify({
      id: 555,
      html_url: 'https://github.com/o/r/issues/1#issuecomment-555',
      /* 巨型响应里的无关字段——不应影响映射。 */
      node_id: 'MDEy',
      user: { login: 'bot', id: 99 },
      created_at: '2026-07-19T00:00:00Z',
    });
    const spy = makeFetchSpy([{ status: 201, body: resp }]);
    const port = new GitHubWritePortImpl(makeAuth('t'), { fetchImpl: spy.impl });

    const out = await port.createIssueComment('o/r', 1, 'hi');
    assert.equal(out.id, 555);
    assert.equal(out.htmlUrl, 'https://github.com/o/r/issues/1#issuecomment-555');
    /* 精简映射：只暴露 id + htmlUrl。 */
    assert.deepEqual(Object.keys(out).sort(), ['htmlUrl', 'id']);
  });

  it('GHE：apiBase + hostAllowlist 透传给 githubFetch', async () => {
    const resp = JSON.stringify({ id: 1, html_url: 'https://ghe.example.com/o/r/issues/2#c-1' });
    const spy = makeFetchSpy([{ status: 201, body: resp }]);
    const port = new GitHubWritePortImpl(makeAuth('t'), {
      fetchImpl: spy.impl,
      apiBase: 'https://ghe.example.com/api/v3',
      hostAllowlist: ['ghe.example.com'],
    });

    await port.createIssueComment('o/r', 2, 'hello GHE');

    const call = spy.calls[0]!;
    /* URL 打到 GHE base 而非公有云。 */
    assert.match(call.url, /^https:\/\/ghe\.example\.com\/api\/v3\/repos\/o\/r\/issues\/2\/comments$/);
    /* hostAllowlist 透传给 githubFetch（第三参 opts）。 */
    assert.deepEqual(call.opts, { hostAllowlist: ['ghe.example.com'] });
  });

  it('铁律：写方法都经注入 fetchImpl（githubFetch SSRF 网关），不裸 fetch', async () => {
    /* 若实现走裸 fetch 而非注入的 fetchImpl，则 spy 记不到任何调用——
     * 该断言把"必经 githubFetch"钉成可回归的不变式。 */
    const spy = makeFetchSpy([
      { status: 201, body: '{"id":1,"html_url":"https://x/1"}' },
      { status: 200, body: '{"id":2,"html_url":"https://x/2"}' },
    ]);
    const port = new GitHubWritePortImpl(makeAuth('t'), { fetchImpl: spy.impl });

    await port.createIssueComment('o/r', 1, 'a');
    await port.createReview('o/r', 2, 'b', 'COMMENT');

    assert.equal(spy.calls.length, 2, '两次写都必须经注入的 fetchImpl');
  });
});
