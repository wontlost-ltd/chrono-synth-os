/**
 * P1-X-ssrf — SSRF guard tests.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  validateOutboundUrl, assertResolvedAddressSafe,
  isPrivateIPv4, isPrivateIPv6, isPrivateAddress,
} from '../../security/ssrf-guard.js';

describe('isPrivateIPv4', () => {
  it('RFC 1918 ranges', () => {
    assert.equal(isPrivateIPv4('10.0.0.1'), true);
    assert.equal(isPrivateIPv4('10.255.255.255'), true);
    assert.equal(isPrivateIPv4('172.16.0.1'), true);
    assert.equal(isPrivateIPv4('172.31.255.255'), true);
    assert.equal(isPrivateIPv4('192.168.1.1'), true);
  });

  it('loopback + link-local + CGNAT + metadata', () => {
    assert.equal(isPrivateIPv4('127.0.0.1'), true);
    assert.equal(isPrivateIPv4('169.254.169.254'), true,
      'AWS / GCP metadata service — blocking this is the load-bearing case');
    assert.equal(isPrivateIPv4('100.64.0.1'), true);
  });

  it('public IPs allowed', () => {
    assert.equal(isPrivateIPv4('8.8.8.8'), false);
    assert.equal(isPrivateIPv4('1.1.1.1'), false);
    assert.equal(isPrivateIPv4('142.250.80.46'), false); /* google.com */
  });

  it('handles edge of ranges (just outside is allowed)', () => {
    assert.equal(isPrivateIPv4('172.32.0.1'), false);
    assert.equal(isPrivateIPv4('11.0.0.1'), false);
    assert.equal(isPrivateIPv4('192.169.0.1'), false);
  });
});

describe('isPrivateIPv6', () => {
  it('loopback and unspecified', () => {
    assert.equal(isPrivateIPv6('::1'), true);
    assert.equal(isPrivateIPv6('::'), true);
  });

  it('unique-local fc00::/7', () => {
    assert.equal(isPrivateIPv6('fc00::1'), true);
    assert.equal(isPrivateIPv6('fd12:3456::1'), true);
  });

  it('link-local fe80::/10', () => {
    assert.equal(isPrivateIPv6('fe80::1'), true);
    assert.equal(isPrivateIPv6('feb0::1'), true);
  });

  it('IPv4-mapped reuses v4 check', () => {
    assert.equal(isPrivateIPv6('::ffff:127.0.0.1'), true);
    assert.equal(isPrivateIPv6('::ffff:169.254.169.254'), true);
    assert.equal(isPrivateIPv6('::ffff:8.8.8.8'), false);
  });

  it('public IPv6 allowed', () => {
    assert.equal(isPrivateIPv6('2001:4860:4860::8888'), false); /* Google DNS */
  });
});

describe('validateOutboundUrl', () => {
  it('blocks unsupported scheme', () => {
    const r = validateOutboundUrl('http://example.com');
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, 'UNSUPPORTED_SCHEME');
  });

  it('blocks literal private IP', () => {
    const r = validateOutboundUrl('https://10.0.0.1/x');
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, 'PRIVATE_HOST');
  });

  it('blocks AWS metadata service literal', () => {
    const r = validateOutboundUrl('https://169.254.169.254/latest/meta-data/');
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, 'PRIVATE_HOST');
  });

  it('blocks IPv6 loopback', () => {
    const r = validateOutboundUrl('https://[::1]/x');
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, 'PRIVATE_HOST');
  });

  it('permits public IP literal when no hostAllowlist', () => {
    const r = validateOutboundUrl('https://1.1.1.1/');
    assert.equal(r.ok, true);
  });

  it('rejects IP literal when hostAllowlist is set', () => {
    const r = validateOutboundUrl('https://1.1.1.1/', {
      allowedSchemes: ['https:'], hostAllowlist: ['example.com'], allowEnvBypass: false,
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, 'NOT_IN_ALLOWLIST');
  });

  it('rejects unlisted hostname when hostAllowlist is set', () => {
    const r = validateOutboundUrl('https://evil.example/', {
      allowedSchemes: ['https:'], hostAllowlist: ['api.example.com'], allowEnvBypass: false,
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, 'NOT_IN_ALLOWLIST');
  });

  it('admits listed hostname', () => {
    const r = validateOutboundUrl('https://api.example.com/v1/x', {
      allowedSchemes: ['https:'], hostAllowlist: ['api.example.com'], allowEnvBypass: false,
    });
    assert.equal(r.ok, true);
  });

  it('rejects malformed URL', () => {
    const r = validateOutboundUrl('not-a-url');
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, 'INVALID_URL');
  });

  it('SSRF_GUARD_DISABLED env bypass only honoured when allowEnvBypass=true', () => {
    /* Default options don't allow bypass; setting env should NOT relax. */
    const original = process.env.SSRF_GUARD_DISABLED;
    process.env.SSRF_GUARD_DISABLED = '1';
    try {
      const strict = validateOutboundUrl('https://127.0.0.1/');
      assert.equal(strict.ok, false, 'default options must NOT honour the env bypass');
      const lax = validateOutboundUrl('https://127.0.0.1/', {
        allowedSchemes: ['https:'], hostAllowlist: [], allowEnvBypass: true,
      });
      assert.equal(lax.ok, true);
    } finally {
      if (original === undefined) delete process.env.SSRF_GUARD_DISABLED;
      else process.env.SSRF_GUARD_DISABLED = original;
    }
  });
});

describe('assertResolvedAddressSafe (DNS rebinding guard)', () => {
  it('admits public resolved IPs', () => {
    assert.equal(assertResolvedAddressSafe('8.8.8.8').ok, true);
    assert.equal(assertResolvedAddressSafe('2001:4860:4860::8888').ok, true);
  });

  it('rejects private resolved IPs (the DNS-rebinding attack vector)', () => {
    /* The classic scenario: validateOutboundUrl saw the public IP at
     * resolve time; on the actual connect, the resolver returned the
     * private IP. assertResolvedAddressSafe must catch that. */
    const r = assertResolvedAddressSafe('169.254.169.254');
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, 'PRIVATE_HOST');
  });

  it('rejects non-IP values', () => {
    const r = assertResolvedAddressSafe('example.com');
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, 'INVALID_URL');
  });
});

describe('isPrivateAddress (entry point)', () => {
  it('dispatches by family', () => {
    assert.equal(isPrivateAddress('10.0.0.1'), true);
    assert.equal(isPrivateAddress('::1'), true);
    assert.equal(isPrivateAddress('8.8.8.8'), false);
    assert.equal(isPrivateAddress('not-an-ip'), false);
  });
});
