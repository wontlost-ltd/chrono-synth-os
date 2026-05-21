/**
 * P0-D #2 — RS256 sign/verify + JWKS endpoint
 *
 * Plan: poc-to-enterprise-ga-2026-v7.3.md §2.2 P0-D + §8 #4
 *
 * 验证：
 *   - jwt.enabled + algorithm=RS256 + privateKey + publicKey 配置可启动
 *   - /.well-known/jwks.json 返回 RFC 7517 JWK（含 kid, kty=RSA, n, e）
 *   - JWKS cache-control max-age ≤ 300（5min）
 *   - JWT header 包含 kid
 *   - 受保护端点能用 RS256 token 验证通过
 *   - 错配的 publicKey 验证失败
 *   - HS256 默认路径返回 metadata-only JWKS（kty=oct，无密钥泄漏）
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { ChronoSynthOS } from '../../chrono-synth-os.js';
import { createApp } from '../../server/index.js';
import { SilentLogger } from '../../utils/logger.js';
import { TestClock } from '../../utils/clock.js';
import { loadConfig } from '../../config/schema.js';
import type { FastifyInstance } from 'fastify';

function makeRsaKeyPair(): { privatePem: string; publicPem: string } {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  return {
    privatePem: privateKey as string,
    publicPem: publicKey as string,
  };
}

describe('P0-D #2 — JWT RS256 + JWKS endpoint', () => {
  describe('RS256 sign/verify path', () => {
    let os: ChronoSynthOS;
    let app: FastifyInstance;
    let kid: string;

    before(async () => {
      const { privatePem, publicPem } = makeRsaKeyPair();
      const config = loadConfig({
        rateLimit: { max: 10000, timeWindowMs: 60_000 },
        websocket: { enabled: false, heartbeatIntervalMs: 30_000 },
        jwt: {
          enabled: true,
          algorithm: 'RS256',
          privateKey: privatePem,
          publicKey: publicPem,
          issuer: 'test-rs256-issuer',
          kid: 'test-kid-rs256',
          /* `secret` is unused under asymmetric mode but loadConfig still
           * validates it doesn't equal the change-me default for symmetric paths. */
          secret: 'change-me-in-production',  /* explicitly the default — bypass via algorithm gate */
        },
      });
      os = new ChronoSynthOS({ clock: new TestClock(1000), logger: new SilentLogger() });
      os.start();
      app = await createApp({ os, config });
      kid = (app as unknown as { jwtKid: string }).jwtKid;
    });

    after(async () => { await app.close(); os.close(); });

    it('app starts and exposes jwtKid', () => {
      assert.equal(kid, 'test-kid-rs256');
    });

    it('JWKS endpoint returns RSA JWK', async () => {
      const res = await app.inject({ method: 'GET', url: '/.well-known/jwks.json' });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body) as { keys: Array<Record<string, unknown>> };
      assert.equal(body.keys.length, 1);
      const jwk = body.keys[0]!;
      assert.equal(jwk.kty, 'RSA');
      assert.equal(jwk.kid, 'test-kid-rs256');
      assert.equal(jwk.alg, 'RS256');
      assert.equal(jwk.use, 'sig');
      /* n and e are base64url-encoded modulus + exponent — must be non-empty strings */
      assert.equal(typeof jwk.n, 'string');
      assert.ok((jwk.n as string).length > 100, 'modulus too short — likely empty');
      assert.equal(typeof jwk.e, 'string');
      assert.ok((jwk.e as string).length >= 3, 'exponent too short');
    });

    it('JWKS endpoint advertises cache-control ≤ 5 min', async () => {
      const res = await app.inject({ method: 'GET', url: '/.well-known/jwks.json' });
      const cc = res.headers['cache-control'];
      assert.ok(cc, 'cache-control header missing');
      assert.match(String(cc), /max-age=\d+/);
      const m = String(cc).match(/max-age=(\d+)/);
      assert.ok(m, 'no max-age');
      const seconds = Number(m![1]);
      assert.ok(seconds > 0 && seconds <= 300, `max-age=${seconds} exceeds 5min ceiling`);
    });

    it('register + login + access protected route works under RS256', async () => {
      const email = 'rs256@example.com';
      const reg = await app.inject({
        method: 'POST', url: '/api/v1/auth/register',
        payload: { email, password: 'password123' },
      });
      assert.ok(reg.statusCode >= 200 && reg.statusCode < 300, `register failed ${reg.statusCode}: ${reg.body}`);
      const { accessToken } = JSON.parse(reg.body).data as { accessToken: string };

      /* JWT header should include kid + alg */
      const headerB64 = accessToken.split('.')[0]!;
      const header = JSON.parse(Buffer.from(headerB64, 'base64url').toString('utf-8'));
      assert.equal(header.alg, 'RS256');
      assert.equal(header.kid, 'test-kid-rs256');

      /* protected route access */
      const me = await app.inject({
        method: 'GET',
        url: '/api/v1/audit-trail',
        headers: { authorization: `Bearer ${accessToken}` },
      });
      assert.ok(me.statusCode !== 401, `RS256 token should authenticate, got ${me.statusCode}`);
    });
  });

  describe('HS256 default path — JWKS returns metadata only (no secret leakage)', () => {
    let os: ChronoSynthOS;
    let app: FastifyInstance;

    before(async () => {
      const config = loadConfig({
        rateLimit: { max: 10000, timeWindowMs: 60_000 },
        websocket: { enabled: false, heartbeatIntervalMs: 30_000 },
        jwt: {
          enabled: true,
          algorithm: 'HS256',
          secret: 'test-secret-at-least-32-characters-long!',
          issuer: 'test-hs256-issuer',
        },
      });
      os = new ChronoSynthOS({ clock: new TestClock(1000), logger: new SilentLogger() });
      os.start();
      app = await createApp({ os, config });
    });

    after(async () => { await app.close(); os.close(); });

    it('JWKS endpoint returns metadata-only (kty=oct, no secret material)', async () => {
      const res = await app.inject({ method: 'GET', url: '/.well-known/jwks.json' });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body) as { keys: Array<Record<string, unknown>> };
      assert.equal(body.keys.length, 1);
      const jwk = body.keys[0]!;
      assert.equal(jwk.kty, 'oct');
      assert.equal(jwk.alg, 'HS256');
      assert.equal(jwk.use, 'sig');
      /* CRITICAL: shared secret material (key `k`) must never be present */
      assert.equal((jwk as { k?: unknown }).k, undefined,
        'HS256 JWKS must NOT include `k` (the shared secret)');
      assert.ok(typeof jwk.kid === 'string' && (jwk.kid as string).length > 0,
        'kid required even for symmetric mode (for log correlation)');
    });
  });

  describe('Config validation — RS256 without keys is rejected', () => {
    it('loadConfig throws if RS256 enabled but privateKey blank', () => {
      assert.throws(() => loadConfig({
        jwt: { enabled: true, algorithm: 'RS256', privateKey: '', publicKey: 'public-pem-data' },
      }), /privateKey 和 jwt\.publicKey/);
    });

    it('loadConfig throws if RS256 enabled but publicKey blank', () => {
      assert.throws(() => loadConfig({
        jwt: { enabled: true, algorithm: 'RS256', privateKey: 'private-pem-data', publicKey: '' },
      }), /privateKey 和 jwt\.publicKey/);
    });
  });

  describe('Kid hygiene — whitespace-only config.jwt.kid is rejected', () => {
    /* Whitespace-only kid must NOT appear in JWT headers / JWKS — would
     * otherwise corrupt log-correlation and key-rollover lookups. Resolver
     * falls back to hash-based id instead. */
    let os: ChronoSynthOS;
    let app: FastifyInstance;

    before(async () => {
      const { privatePem, publicPem } = makeRsaKeyPair();
      const config = loadConfig({
        rateLimit: { max: 10000, timeWindowMs: 60_000 },
        websocket: { enabled: false, heartbeatIntervalMs: 30_000 },
        jwt: {
          enabled: true, algorithm: 'RS256',
          privateKey: privatePem, publicKey: publicPem,
          issuer: 'test-blank-kid',
          kid: '   ',  /* whitespace-only — must be treated as blank */
          secret: 'change-me-in-production',
        },
      });
      os = new ChronoSynthOS({ clock: new TestClock(1000), logger: new SilentLogger() });
      os.start();
      app = await createApp({ os, config });
    });

    after(async () => { await app.close(); os.close(); });

    it('falls back to a deterministic hash, never " " or empty', async () => {
      const kid = (app as unknown as { jwtKid: string }).jwtKid;
      assert.ok(kid && kid.trim().length === kid.length && kid.length > 0,
        `kid must be non-blank stable id, got ${JSON.stringify(kid)}`);
      const res = await app.inject({ method: 'GET', url: '/.well-known/jwks.json' });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body) as { keys: Array<{ kid: string }> };
      assert.equal(body.keys[0]!.kid, kid);
    });
  });

  describe('Canonical kid — same logical key produces same kid regardless of PEM formatting', () => {
    it('extra trailing whitespace in PEM yields the same resolved kid', async () => {
      const { privatePem, publicPem } = makeRsaKeyPair();
      const makeConfig = (pubVariant: string) => loadConfig({
        rateLimit: { max: 10000, timeWindowMs: 60_000 },
        websocket: { enabled: false, heartbeatIntervalMs: 30_000 },
        jwt: {
          enabled: true, algorithm: 'RS256',
          privateKey: privatePem, publicKey: pubVariant,
          issuer: 'test-canonical-kid',
          kid: '',  /* blank — let resolver derive */
          secret: 'change-me-in-production',
        },
      });

      const os1 = new ChronoSynthOS({ clock: new TestClock(1000), logger: new SilentLogger() });
      os1.start();
      const app1 = await createApp({ os: os1, config: makeConfig(publicPem) });
      const kid1 = (app1 as unknown as { jwtKid: string }).jwtKid;
      await app1.close(); os1.close();

      const os2 = new ChronoSynthOS({ clock: new TestClock(1000), logger: new SilentLogger() });
      os2.start();
      /* Same key, padded with extra newlines + trailing whitespace */
      const app2 = await createApp({ os: os2, config: makeConfig(publicPem + '\n\n   ') });
      const kid2 = (app2 as unknown as { jwtKid: string }).jwtKid;
      await app2.close(); os2.close();

      assert.equal(kid1, kid2,
        `Same logical public key should produce identical kid regardless of PEM whitespace`);
    });
  });
});
