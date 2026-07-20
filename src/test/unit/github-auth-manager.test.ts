/**
 * 单元测试：GitHubAuthManager（GitHub App 三级 token 认证链）
 *
 * 认证链：App 私钥 → 签 App JWT（RS256，≤10min）→ 换 installation token
 * → 内存缓存并在到期前静默重签。
 *
 * 核心不变式（照 memory adr-0060 T6 flaky 教训）：**时钟必须注入**
 *   （deps.now），token 有效期判定、JWT 的 iat/exp 全用注入时钟，绝不用真
 *   Date.now——否则有效期/刷新用例会 flaky。
 *
 * 所有出站换 token 都经注入的 fetchImpl（mock githubFetch），不真连 GitHub。
 * 测试内用 crypto.generateKeyPairSync('rsa') 生成一对真密钥，验证 JWT 三段
 * 结构与 RS256 签名可被公钥验签，但不发出任何真实网络请求。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { GitHubAuthManager, type AppCreds } from '../../integrations/github/github-auth-manager.js';
import type { githubFetch as GithubFetch } from '../../integrations/github/github-http.js';

/** 生成测试用 RSA 密钥对（2048 位），返回私钥 PEM 与公钥对象（供验签）。 */
function makeKeyPair(): { privateKeyPem: string; publicKey: crypto.KeyObject } {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  return {
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
    publicKey,
  };
}

/** base64url → utf8 字符串（解 JWT header / payload）。 */
function decodeSegment(seg: string): unknown {
  return JSON.parse(Buffer.from(seg, 'base64url').toString('utf8'));
}

/**
 * 记录调用的 githubFetch spy。每次调用返回队列头部预设的响应体（token +
 * expires_at），并记录 url / init 供断言（尤其 Authorization: Bearer <JWT>）。
 */
function makeFetchSpy(
  responses: Array<{ token: string; expires_at: string }>,
): { calls: Array<{ url: string; init: RequestInit; opts: unknown }>; impl: typeof GithubFetch } {
  const calls: Array<{ url: string; init: RequestInit; opts: unknown }> = [];
  let i = 0;
  const impl = (async (url: string, init: RequestInit, opts?: unknown) => {
    calls.push({ url, init, opts });
    const body = responses[Math.min(i, responses.length - 1)]!;
    i += 1;
    return new Response(JSON.stringify(body), {
      status: 201,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof GithubFetch;
  return { calls, impl };
}

/**
 * 返回原始 Response 的 fetch spy（供错误路径：非 2xx / 畸形 body / 空 token）。
 * 每次调用取队列头部的响应，用完保持末尾。
 */
function makeRawFetchSpy(
  responses: Array<{ status: number; body: string }>,
): { calls: Array<{ url: string }>; impl: typeof GithubFetch } {
  const calls: Array<{ url: string }> = [];
  let i = 0;
  const impl = (async (url: string) => {
    calls.push({ url });
    const r = responses[Math.min(i, responses.length - 1)]!;
    i += 1;
    return new Response(r.body, { status: r.status, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof GithubFetch;
  return { calls, impl };
}

/** ISO 时间戳工具：从注入的毫秒时钟基准偏移。 */
function isoAt(ms: number): string {
  return new Date(ms).toISOString();
}

describe('GitHubAuthManager', () => {
  it('首次调用签 App JWT 换 installation token', async () => {
    const { privateKeyPem } = makeKeyPair();
    const now = 1_700_000_000_000; // 固定注入时钟
    const app: AppCreds = { appId: '123456', privateKeyPem, gheBaseUrl: null };
    const spy = makeFetchSpy([{ token: 't1', expires_at: isoAt(now + 3_600_000) }]);

    const mgr = new GitHubAuthManager({
      getApp: () => app,
      installationId: '987654',
      now: () => now,
      fetchImpl: spy.impl,
    });

    const token = await mgr.getInstallationToken();
    assert.equal(token, 't1');
    assert.equal(spy.calls.length, 1, '首次应换取一次 token');
    /* 换 token 请求打到 installation access_tokens 端点。 */
    assert.match(spy.calls[0]!.url, /\/app\/installations\/987654\/access_tokens$/);
    /* 公有云路径不覆盖 allowlist（用 githubFetch 默认只放 api.github.com）。 */
    assert.equal(spy.calls[0]!.opts, undefined, '公有云不应传 opts');
  });

  it('token 未过期 → 复用缓存，不重新换', async () => {
    const { privateKeyPem } = makeKeyPair();
    const now = 1_700_000_000_000;
    const app: AppCreds = { appId: '123456', privateKeyPem, gheBaseUrl: null };
    const spy = makeFetchSpy([{ token: 't1', expires_at: isoAt(now + 3_600_000) }]);

    const mgr = new GitHubAuthManager({
      getApp: () => app,
      installationId: '987654',
      now: () => now, // 时钟不前进 → 缓存仍有效
      fetchImpl: spy.impl,
    });

    const a = await mgr.getInstallationToken();
    const b = await mgr.getInstallationToken();
    assert.equal(a, 't1');
    assert.equal(b, 't1');
    assert.equal(spy.calls.length, 1, '缓存有效期内应只换一次');
  });

  it('token 到期 → 静默重签换新 token', async () => {
    const { privateKeyPem } = makeKeyPair();
    let clock = 1_700_000_000_000;
    const app: AppCreds = { appId: '123456', privateKeyPem, gheBaseUrl: null };
    /* 第一次返回 t1（1h 后过期），第二次返回 t2。 */
    const spy = makeFetchSpy([
      { token: 't1', expires_at: isoAt(clock + 3_600_000) },
      { token: 't2', expires_at: isoAt(clock + 7_200_000) },
    ]);

    const mgr = new GitHubAuthManager({
      getApp: () => app,
      installationId: '987654',
      now: () => clock,
      fetchImpl: spy.impl,
    });

    const first = await mgr.getInstallationToken();
    assert.equal(first, 't1');
    assert.equal(spy.calls.length, 1);

    /* 把时钟推进到 t1 过期之后（进入 60s skew 窗口内 → 触发重签）。 */
    clock += 3_600_000; // 恰好到 expiresAt，now+60s >= expiresAt → 重签
    const second = await mgr.getInstallationToken();
    assert.equal(second, 't2', '过期后应换到新 token');
    assert.equal(spy.calls.length, 2, '过期后应重新换一次 token');
  });

  it('到期前 60s skew 窗口内 → 提前重签（不等真过期）', async () => {
    const { privateKeyPem } = makeKeyPair();
    let clock = 1_700_000_000_000;
    const app: AppCreds = { appId: '123456', privateKeyPem, gheBaseUrl: null };
    const spy = makeFetchSpy([
      { token: 't1', expires_at: isoAt(clock + 3_600_000) },
      { token: 't2', expires_at: isoAt(clock + 7_200_000) },
    ]);

    const mgr = new GitHubAuthManager({
      getApp: () => app,
      installationId: '987654',
      now: () => clock,
      fetchImpl: spy.impl,
    });

    await mgr.getInstallationToken(); // t1
    /* 推进到过期前 30s：仍在 skew(60s) 窗口内 → 应提前重签。 */
    clock += 3_600_000 - 30_000;
    const t = await mgr.getInstallationToken();
    assert.equal(t, 't2', 'skew 窗口内应提前换新');
    assert.equal(spy.calls.length, 2);
  });

  it('换 token 请求带 Authorization: Bearer <RS256 三段 JWT>，公钥可验签', async () => {
    const { privateKeyPem, publicKey } = makeKeyPair();
    const now = 1_700_000_000_000;
    const app: AppCreds = { appId: '123456', privateKeyPem, gheBaseUrl: null };
    const spy = makeFetchSpy([{ token: 't1', expires_at: isoAt(now + 3_600_000) }]);

    const mgr = new GitHubAuthManager({
      getApp: () => app,
      installationId: '987654',
      now: () => now,
      fetchImpl: spy.impl,
    });

    await mgr.getInstallationToken();

    const headers = spy.calls[0]!.init.headers as Record<string, string>;
    assert.match(headers.Authorization ?? '', /^Bearer /, '须带 Bearer 头');
    assert.equal(headers.Accept, 'application/vnd.github+json');

    const jwt = (headers.Authorization ?? '').slice('Bearer '.length);
    const parts = jwt.split('.');
    assert.equal(parts.length, 3, 'JWT 必须为三段（header.payload.signature）');

    const header = decodeSegment(parts[0]!) as { alg: string; typ: string };
    assert.equal(header.alg, 'RS256');
    assert.equal(header.typ, 'JWT');

    const payload = decodeSegment(parts[1]!) as { iat: number; exp: number; iss: string };
    assert.equal(payload.iss, '123456', 'iss 应为 appId');
    /* iat 回退 60s 容时钟漂移；exp = iat + 540（≤10min）。 */
    assert.equal(payload.iat, Math.floor(now / 1000) - 60);
    assert.equal(payload.exp, Math.floor(now / 1000) - 60 + 540);
    assert.ok(payload.exp - payload.iat <= 600, 'JWT 有效期须 ≤10min');

    /* 用公钥验签：签名对象 = header.payload，RSA-SHA256。 */
    const verifier = crypto.createVerify('RSA-SHA256');
    verifier.update(`${parts[0]}.${parts[1]}`);
    const ok = verifier.verify(publicKey, Buffer.from(parts[2]!, 'base64url'));
    assert.ok(ok, 'RS256 签名必须能被对应公钥验签');
  });

  it('无 App 凭据（getApp 返回 undefined）→ 抛错，不发请求', async () => {
    const now = 1_700_000_000_000;
    const spy = makeFetchSpy([{ token: 't1', expires_at: isoAt(now + 3_600_000) }]);
    const mgr = new GitHubAuthManager({
      getApp: () => undefined,
      installationId: '987654',
      now: () => now,
      fetchImpl: spy.impl,
    });
    await assert.rejects(() => mgr.getInstallationToken(), /App|凭据|credential/i);
    assert.equal(spy.calls.length, 0, '无凭据时绝不发出请求');
  });

  it('GHE base URL → 打企业 host 端点（gheBaseUrl 决定 host）', async () => {
    const { privateKeyPem } = makeKeyPair();
    const now = 1_700_000_000_000;
    const app: AppCreds = {
      appId: '123456',
      privateKeyPem,
      gheBaseUrl: 'https://ghe.internal.example.com/api/v3',
    };
    const spy = makeFetchSpy([{ token: 't1', expires_at: isoAt(now + 3_600_000) }]);
    const mgr = new GitHubAuthManager({
      getApp: () => app,
      installationId: '987654',
      now: () => now,
      fetchImpl: spy.impl,
    });

    const token = await mgr.getInstallationToken();
    assert.equal(token, 't1');
    assert.match(
      spy.calls[0]!.url,
      /^https:\/\/ghe\.internal\.example\.com\/api\/v3\/app\/installations\/987654\/access_tokens$/,
    );
    /* GHE 须把企业 host 传进 hostAllowlist，否则 SSRF 网关（默认只放
     * api.github.com）拒绝该自托管地址。 */
    assert.deepEqual(
      (spy.calls[0]!.opts as { hostAllowlist: string[] }).hostAllowlist,
      ['ghe.internal.example.com'],
    );
  });

  it('GHE 带自定义端口 → allowlist 用 hostname（不含端口），过真 SSRF 网关', async () => {
    const { privateKeyPem } = makeKeyPair();
    const now = 1_700_000_000_000;
    const app: AppCreds = {
      appId: '123456',
      privateKeyPem,
      gheBaseUrl: 'https://ghe.internal.example.com:8443/api/v3',
    };
    const spy = makeFetchSpy([{ token: 't1', expires_at: isoAt(now + 3_600_000) }]);
    const mgr = new GitHubAuthManager({
      getApp: () => app,
      installationId: '987654',
      now: () => now,
      fetchImpl: spy.impl,
    });

    await mgr.getInstallationToken();
    /* SSRF 网关按 URL.hostname（不含端口）比对 allowlist——所以 allowlist 项
     * 必须是 ghe.internal.example.com（无 :8443），否则合法带端口地址被误拒。 */
    assert.deepEqual(
      (spy.calls[0]!.opts as { hostAllowlist: string[] }).hostAllowlist,
      ['ghe.internal.example.com'],
    );
    assert.match(spy.calls[0]!.url, /:8443\/api\/v3\/app\/installations\/987654\/access_tokens$/);
  });

  it('非 2xx 响应 → 抛错', async () => {
    const { privateKeyPem } = makeKeyPair();
    const now = 1_700_000_000_000;
    const app: AppCreds = { appId: '123456', privateKeyPem, gheBaseUrl: null };
    const spy = makeRawFetchSpy([{ status: 401, body: '{"message":"Bad credentials"}' }]);
    const mgr = new GitHubAuthManager({
      getApp: () => app,
      installationId: '987654',
      now: () => now,
      fetchImpl: spy.impl,
    });
    await assert.rejects(() => mgr.getInstallationToken(), /401|失败/);
  });

  it('expires_at 无法解析 / token 缺失 → 抛错', async () => {
    const { privateKeyPem } = makeKeyPair();
    const now = 1_700_000_000_000;
    const app: AppCreds = { appId: '123456', privateKeyPem, gheBaseUrl: null };

    /* expires_at 非法 → Date.parse NaN → 抛错。 */
    const badExp = new GitHubAuthManager({
      getApp: () => app,
      installationId: '987654',
      now: () => now,
      fetchImpl: makeRawFetchSpy([{ status: 201, body: '{"token":"t1","expires_at":"not-a-date"}' }]).impl,
    });
    await assert.rejects(() => badExp.getInstallationToken(), /expires_at|token/);

    /* token 缺失 → 抛错。 */
    const noToken = new GitHubAuthManager({
      getApp: () => app,
      installationId: '987654',
      now: () => now,
      fetchImpl: makeRawFetchSpy([{ status: 201, body: `{"expires_at":"${isoAt(now + 3_600_000)}"}` }]).impl,
    });
    await assert.rejects(() => noToken.getInstallationToken(), /token/);
  });

  it('换取失败不污染缓存 → 下次调用可重新尝试并成功', async () => {
    const { privateKeyPem } = makeKeyPair();
    const now = 1_700_000_000_000;
    const app: AppCreds = { appId: '123456', privateKeyPem, gheBaseUrl: null };
    /* 第一次 500 失败，第二次 201 成功。 */
    const calls: Array<{ url: string }> = [];
    let i = 0;
    const impl = (async (url: string) => {
      calls.push({ url });
      const r = i === 0
        ? new Response('{"message":"boom"}', { status: 500 })
        : new Response(JSON.stringify({ token: 't1', expires_at: isoAt(now + 3_600_000) }), { status: 201 });
      i += 1;
      return r;
    }) as unknown as typeof GithubFetch;

    const mgr = new GitHubAuthManager({
      getApp: () => app,
      installationId: '987654',
      now: () => now,
      fetchImpl: impl,
    });

    await assert.rejects(() => mgr.getInstallationToken(), /500|失败/);
    /* 失败未写缓存 → 下次调用重新换取并成功。 */
    const token = await mgr.getInstallationToken();
    assert.equal(token, 't1');
    assert.equal(calls.length, 2, '失败后应能重试，共换取两次');
  });

  it('刷新边界精确：距过期 60_001ms 复用、恰好 60_000ms 重签', async () => {
    const { privateKeyPem } = makeKeyPair();
    let clock = 1_700_000_000_000;
    const expiresAt = clock + 3_600_000;
    const app: AppCreds = { appId: '123456', privateKeyPem, gheBaseUrl: null };
    const spy = makeFetchSpy([
      { token: 't1', expires_at: isoAt(expiresAt) },
      { token: 't2', expires_at: isoAt(expiresAt + 3_600_000) },
    ]);
    const mgr = new GitHubAuthManager({
      getApp: () => app,
      installationId: '987654',
      now: () => clock,
      fetchImpl: spy.impl,
    });

    await mgr.getInstallationToken(); // t1

    /* now + 60_000 = expiresAt - 1 < expiresAt → 复用。 */
    clock = expiresAt - 60_001;
    assert.equal(await mgr.getInstallationToken(), 't1', '距过期 60_001ms 应复用');
    assert.equal(spy.calls.length, 1);

    /* now + 60_000 = expiresAt（相等）→ 触发重签（>= 边界）。 */
    clock = expiresAt - 60_000;
    assert.equal(await mgr.getInstallationToken(), 't2', '恰好 60_000ms 应重签');
    assert.equal(spy.calls.length, 2);
  });
});
