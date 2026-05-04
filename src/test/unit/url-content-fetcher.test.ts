/**
 * 单元测试：UrlContentFetcher（P1-B SSRF 防护 + 限制）
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { UrlContentFetcher, isPrivateHostname } from '../../knowledge/url-content-fetcher.js';

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
});
