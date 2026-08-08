/**
 * 单元测试：UrlContentFetcher（P1-B SSRF 防护 + 正向抓取）
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { UrlContentFetcher, isPrivateHostname } from '../../knowledge/url-content-fetcher.js';

interface RouteHandler {
  (req: IncomingMessage, res: ServerResponse): void;
}

async function startTestServer(handler: RouteHandler): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer((req, res) => handler(req, res));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  if (!addr || typeof addr !== 'object') {
    throw new Error('test server failed to bind');
  }
  return { server, baseUrl: `http://127.0.0.1:${addr.port}` };
}

async function stopServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

describe('UrlContentFetcher', () => {
  it('isPrivateHostname 命中 RFC1918 / loopback / 169.254 / IPv6 link-local', () => {
    assert.equal(isPrivateHostname('localhost'), true);
    assert.equal(isPrivateHostname('127.0.0.1'), true);
    assert.equal(isPrivateHostname('127.5.6.7'), true);
    assert.equal(isPrivateHostname('10.0.0.1'), true);
    assert.equal(isPrivateHostname('192.168.1.1'), true);
    assert.equal(isPrivateHostname('172.16.0.1'), true);
    assert.equal(isPrivateHostname('172.31.255.255'), true);
    assert.equal(isPrivateHostname('169.254.169.254'), true);  // AWS metadata
    assert.equal(isPrivateHostname('::1'), true);
    assert.equal(isPrivateHostname('fd00::1'), true);            // IPv6 ULA
    assert.equal(isPrivateHostname('fe80::1'), true);            // IPv6 link-local

    /* 公共地址通过 */
    assert.equal(isPrivateHostname('8.8.8.8'), false);
    assert.equal(isPrivateHostname('example.com'), false);
    assert.equal(isPrivateHostname('172.32.0.1'), false);  // 在 172.16-172.31 范围外
  });

  it('fetch 拒绝 localhost', async () => {
    const fetcher = new UrlContentFetcher({ skipDnsResolve: true });
    await assert.rejects(
      () => fetcher.fetch('http://localhost:8080/secret'),
      /restricted range/,
    );
  });

  it('fetch 拒绝 169.254 云元数据地址', async () => {
    const fetcher = new UrlContentFetcher({ skipDnsResolve: true });
    await assert.rejects(
      () => fetcher.fetch('http://169.254.169.254/latest/meta-data'),
      /restricted range/,
    );
  });

  it('fetch 拒绝非 HTTP/HTTPS 协议', async () => {
    const fetcher = new UrlContentFetcher({ skipDnsResolve: true });
    await assert.rejects(
      () => fetcher.fetch('file:///etc/passwd'),
      /protocol/,
    );
    await assert.rejects(
      () => fetcher.fetch('ftp://example.com/file'),
      /protocol/,
    );
  });

  it('fetch 拒绝 invalid URL', async () => {
    const fetcher = new UrlContentFetcher({ skipDnsResolve: true });
    await assert.rejects(
      () => fetcher.fetch('not a url'),
      /invalid URL/,
    );
  });

  /* ──────────── 正向 fetch 路径（本地 http 服务器，allowLoopback=true） ──────────── */

  it('fetch 成功返回 content + contentType', async () => {
    const { server, baseUrl } = await startTestServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8' });
      res.end('# Hello World\n\nThis is a test document.');
    });
    after(() => stopServer(server));

    const fetcher = new UrlContentFetcher({ allowLoopback: true });
    const result = await fetcher.fetch(`${baseUrl}/doc`);
    assert.equal(result.content, '# Hello World\n\nThis is a test document.');
    assert.equal(result.contentType, 'text/markdown; charset=utf-8');
  });

  it('fetch 拒绝 Content-Length 超过 maxBytes', async () => {
    const { server, baseUrl } = await startTestServer((_req, res) => {
      res.writeHead(200, { 'content-length': '99999999' });
      res.end('x');
    });
    after(() => stopServer(server));

    const fetcher = new UrlContentFetcher({ allowLoopback: true, maxBytes: 1024 });
    await assert.rejects(
      () => fetcher.fetch(`${baseUrl}/big`),
      /Content-Length .* exceeds/,
    );
  });

  it('fetch 拒绝实际 body 超过 maxBytes（无 Content-Length 时）', async () => {
    const big = 'A'.repeat(2048);
    const { server, baseUrl } = await startTestServer((_req, res) => {
      /* 不设置 content-length，让 chunked transfer 走过头部检查 */
      res.writeHead(200, { 'content-type': 'text/plain', 'transfer-encoding': 'chunked' });
      res.end(big);
    });
    after(() => stopServer(server));

    const fetcher = new UrlContentFetcher({ allowLoopback: true, maxBytes: 1024 });
    await assert.rejects(
      () => fetcher.fetch(`${baseUrl}/chunked`),
      /body length .* exceeds/,
    );
  });

  it('fetch 在 timeoutMs 内未响应则中止', async () => {
    const { server, baseUrl } = await startTestServer((_req, _res) => {
      /* 故意挂起，不 res.end()，触发客户端超时 */
    });
    after(() => stopServer(server));

    const fetcher = new UrlContentFetcher({ allowLoopback: true, timeoutMs: 200 });
    await assert.rejects(
      () => fetcher.fetch(`${baseUrl}/slow`),
      (err: Error) => err.name === 'AbortError' || /aborted/i.test(err.message) || err.name === 'TimeoutError',
    );
  });

  it('fetch 拒绝 3xx 重定向（强制显式 URL）', async () => {
    const { server, baseUrl } = await startTestServer((_req, res) => {
      res.writeHead(302, { location: '/elsewhere' });
      res.end();
    });
    after(() => stopServer(server));

    const fetcher = new UrlContentFetcher({ allowLoopback: true });
    await assert.rejects(
      () => fetcher.fetch(`${baseUrl}/redirect`),
      /redirects disabled/,
    );
  });

  it('fetch 4xx/5xx 抛错', async () => {
    const { server, baseUrl } = await startTestServer((_req, res) => {
      res.writeHead(503);
      res.end('service unavailable');
    });
    after(() => stopServer(server));

    const fetcher = new UrlContentFetcher({ allowLoopback: true });
    await assert.rejects(
      () => fetcher.fetch(`${baseUrl}/error`),
      /failed with status 503/,
    );
  });
});

/* 审计 Warning B4-15：DNS 校验与实际连接是两次**独立**解析，中间有 rebinding 窗口；
 * 且原实现只取首个地址，多 A 记录主机可以把私有 IP 藏在第二条之后。 */
describe('UrlContentFetcher — DNS rebinding / 多地址防护', () => {
  it('多 A 记录中任一条命中私有段 → 整体拒绝（不只看首条）', async () => {
    const fetcher = new UrlContentFetcher({
      /* 首条是公网地址，第二条是云元数据端点——原实现只查首条会直接放行。 */
      resolveAll: async () => ['93.184.216.34', '169.254.169.254'],
    });
    await assert.rejects(
      () => fetcher.fetch('http://evil.example.com/'),
      /169\.254\.169\.254.*SSRF/,
      '任一地址落在私有段即须拒绝',
    );
  });

  it('私有地址排在首条同样拒绝', async () => {
    const fetcher = new UrlContentFetcher({
      resolveAll: async () => ['10.0.0.5', '93.184.216.34'],
    });
    await assert.rejects(() => fetcher.fetch('http://evil.example.com/'), /SSRF/);
  });

  it('全部为公网地址 → 通过 SSRF 检查（不误伤正常站点）', async () => {
    /* 用真实 loopback 服务器承接请求，但让 DNS 钩子返回公网地址以通过检查；
     * 连接被 pin 到返回的首个地址，故这里断言"检查通过后确实去连了该地址"——
     * 连接失败是预期的（93.184.216.34 不可达），关键是**没有** SSRF 拒绝。 */
    const fetcher = new UrlContentFetcher({
      timeoutMs: 1500,
      resolveAll: async () => ['93.184.216.34'],
    });
    await assert.rejects(
      () => fetcher.fetch('http://public.example.com/'),
      (err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        assert.ok(!/SSRF/.test(msg), `不应被 SSRF 拒绝，实际: ${msg}`);
        return true;
      },
    );
  });

  it('DNS 返回空结果 → 拒绝（不静默放行）', async () => {
    const fetcher = new UrlContentFetcher({ resolveAll: async () => [] });
    await assert.rejects(
      () => fetcher.fetch('http://empty.example.com/'),
      /DNS lookup failed/,
    );
  });
});
