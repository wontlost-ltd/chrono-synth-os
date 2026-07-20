/**
 * 单元测试：githubFetch（GitHub 出站安全网关薄封装）
 *
 * 核心不变式：所有 GitHub 出站网络调用只经 githubFetch，并锁死
 *   host = api.github.com + scheme = https:。任何越界 URL 必须在
 *   发出网络请求之前就被拒绝（先验 SSRF guard → 拒绝即不 fetch）。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { githubFetch, GITHUB_API_HOST } from '../../integrations/github/github-http.js';

/** 记录调用次数的 fetch spy——若被调用即说明"拒绝后仍发了请求"（错误）。 */
function makeFetchSpy(): { calls: Array<{ url: string; init?: RequestInit }>; impl: typeof fetch } {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const impl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return new Response('ok', { status: 200 });
  }) as unknown as typeof fetch;
  return { calls, impl };
}

describe('githubFetch', () => {
  it('导出锁定的 host 常量', () => {
    assert.equal(GITHUB_API_HOST, 'api.github.com');
  });

  it('非 api.github.com host → 拒绝，且不发出请求', async () => {
    const spy = makeFetchSpy();
    await assert.rejects(
      () => githubFetch('https://evil.com/x', {}, { fetchImpl: spy.impl }),
      /allowlist|evil\.com/i,
    );
    assert.equal(spy.calls.length, 0, '拒绝后绝不能调用 fetch');
  });

  it('http scheme → 拒绝，且不发出请求', async () => {
    const spy = makeFetchSpy();
    await assert.rejects(
      () => githubFetch('http://api.github.com/x', {}, { fetchImpl: spy.impl }),
      /scheme|http:/i,
    );
    assert.equal(spy.calls.length, 0, '拒绝后绝不能调用 fetch');
  });

  it('畸形 URL → 拒绝，且不发出请求', async () => {
    const spy = makeFetchSpy();
    await assert.rejects(
      () => githubFetch('not-a-url', {}, { fetchImpl: spy.impl }),
      /URL|parse/i,
    );
    assert.equal(spy.calls.length, 0);
  });

  it('合法 api.github.com https → 过 guard 并以 redirect:manual 发出', async () => {
    const spy = makeFetchSpy();
    const res = await githubFetch(
      'https://api.github.com/user',
      { headers: { accept: 'application/vnd.github+json' } },
      { fetchImpl: spy.impl },
    );
    assert.equal(res.status, 200);
    assert.equal(spy.calls.length, 1, '合法请求应恰好发出一次');
    const passed = spy.calls[0]!.init!;
    assert.equal(passed.redirect, 'manual', '必须禁止自动跟随重定向');
    assert.ok(passed.signal instanceof AbortSignal, '必须挂超时 AbortSignal');
    /* 调用方传入的 init 字段（如 headers）应被透传保留。 */
    assert.deepEqual((passed.headers as Record<string, string>).accept, 'application/vnd.github+json');
  });

  it('自定义 hostAllowlist 生效（GitHub Enterprise 场景）', async () => {
    const spy = makeFetchSpy();
    /* 覆盖默认 allowlist 后 api.github.com 反而被拒。 */
    await assert.rejects(
      () => githubFetch('https://api.github.com/user', {}, {
        hostAllowlist: ['ghe.internal.example.com'],
        fetchImpl: spy.impl,
      }),
      /allowlist/i,
    );
    assert.equal(spy.calls.length, 0);

    /* 列入 allowlist 的企业 host 放行。 */
    const res = await githubFetch('https://ghe.internal.example.com/api/v3/user', {}, {
      hostAllowlist: ['ghe.internal.example.com'],
      fetchImpl: spy.impl,
    });
    assert.equal(res.status, 200);
    assert.equal(spy.calls.length, 1);
  });
});
