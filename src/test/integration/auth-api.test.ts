/**
 * 认证 API 集成测试
 * 覆盖 register / login / refresh / logout 完整流程
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ChronoSynthOS } from '../../chrono-synth-os.js';
import { createApp } from '../../server/index.js';
import { SilentLogger } from '../../utils/logger.js';
import { TestClock } from '../../utils/clock.js';
import { loadConfig } from '../../config/schema.js';
import type { FastifyInstance } from 'fastify';

const JWT_SECRET = 'test-secret-at-least-32-characters-long!';

function normalizeSetCookieHeader(value: string | string[] | undefined): string[] {
  if (Array.isArray(value)) return value;
  return typeof value === 'string' ? [value] : [];
}

describe('认证 API 集成测试', () => {
  let os: ChronoSynthOS;
  let app: FastifyInstance;

  const config = loadConfig({
    rateLimit: { max: 10000, timeWindowMs: 60_000 },
    websocket: { enabled: false, heartbeatIntervalMs: 30_000 },
    jwt: { enabled: true, secret: JWT_SECRET, issuer: 'test' },
  });

  beforeEach(async () => {
    const clock = new TestClock(1000);
    const logger = new SilentLogger();
    os = new ChronoSynthOS({ clock, logger });
    os.start();
    app = await createApp({ os, config });
  });

  afterEach(async () => {
    await app.close();
    os.close();
  });

  describe('POST /api/v1/auth/register', () => {
    it('成功注册返回 201 含 token', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: { email: 'test@example.com', password: 'password123' },
      });
      assert.equal(res.statusCode, 201);
      const body = JSON.parse(res.body);
      assert.ok(body.data.userId);
      assert.equal(body.data.email, 'test@example.com');
      assert.ok(body.data.tenantId);
      assert.ok(body.data.accessToken);
      assert.ok(body.data.refreshToken);
      assert.ok(body.data.expiresIn);
    });

    it('access token payload carries jti (enables deny-list revocation per P0-D #1 review)', async () => {
      /* Without jti the /api/v1/auth/keys/deny-jti endpoint cannot target
       * tokens issued by AuthService — the deny-list would be a no-op for
       * the primary token surface. The dual code review flagged this; we
       * assert here that every registration mints a token with a non-empty
       * jti so future logout/incident flows can revoke it. */
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: { email: 'jti-check@example.com', password: 'password123' },
      });
      assert.equal(res.statusCode, 201);
      const accessToken = JSON.parse(res.body).data.accessToken as string;
      const [, payloadB64] = accessToken.split('.');
      const payload = JSON.parse(Buffer.from(payloadB64!, 'base64url').toString('utf-8'));
      assert.ok(typeof payload.jti === 'string' && payload.jti.length > 0,
        `access token missing jti claim; got payload ${JSON.stringify(payload)}`);
    });

    it('跨站前端来源时 refresh cookie 使用 SameSite=None', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        headers: {
          origin: 'https://app.other-site.test',
          host: 'api.example.test',
          'x-forwarded-proto': 'https',
        },
        payload: { email: 'cross-site@example.com', password: 'password123' },
      });

      assert.equal(res.statusCode, 201);
      const setCookie = Array.isArray(res.headers['set-cookie']) ? res.headers['set-cookie'][0] : res.headers['set-cookie'];
      if (typeof setCookie !== 'string') {
        assert.fail('expected Set-Cookie header');
      }
      assert.match(setCookie, /SameSite=None/);
      assert.match(setCookie, /; Secure/);
    });

    it('localhost 不同端口调试时 refresh cookie 保持 SameSite=Lax', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        headers: {
          origin: 'http://localhost:5173',
          host: 'localhost:3000',
        },
        payload: { email: 'localhost@example.com', password: 'password123' },
      });

      assert.equal(res.statusCode, 201);
      const setCookie = Array.isArray(res.headers['set-cookie']) ? res.headers['set-cookie'][0] : res.headers['set-cookie'];
      if (typeof setCookie !== 'string') {
        assert.fail('expected Set-Cookie header');
      }
      assert.match(setCookie, /SameSite=Lax/);
      assert.doesNotMatch(setCookie, /; Secure/);
    });

    it('同站点子域名在 HTTP 下仍使用 SameSite=Lax', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        headers: {
          origin: 'http://app.example.test:5173',
          host: 'api.example.test:3000',
          'x-forwarded-proto': 'http',
        },
        payload: { email: 'same-site-subdomain@example.com', password: 'password123' },
      });

      assert.equal(res.statusCode, 201);
      const setCookie = Array.isArray(res.headers['set-cookie']) ? res.headers['set-cookie'][0] : res.headers['set-cookie'];
      if (typeof setCookie !== 'string') {
        assert.fail('expected Set-Cookie header');
      }
      assert.match(setCookie, /SameSite=Lax/);
      assert.doesNotMatch(setCookie, /; Secure/);
    });

    it('重复邮箱返回 409', async () => {
      await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: { email: 'dup@example.com', password: 'password123' },
      });
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: { email: 'dup@example.com', password: 'password456' },
      });
      assert.equal(res.statusCode, 409);
    });

    it('无效邮箱返回 400', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: { email: 'not-an-email', password: 'password123' },
      });
      assert.equal(res.statusCode, 400);
    });

    it('密码过短返回 400', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: { email: 'short@example.com', password: '123' },
      });
      assert.equal(res.statusCode, 400);
    });

    it('相同 Idempotency-Key 的重复注册返回缓存响应并重放 refresh cookie', async () => {
      const first = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        headers: {
          'idempotency-key': 'register-idem-1',
        },
        payload: { email: 'idem@example.com', password: 'password123' },
      });
      const second = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        headers: {
          'idempotency-key': 'register-idem-1',
        },
        payload: { email: 'idem@example.com', password: 'password123' },
      });

      assert.equal(first.statusCode, 201);
      assert.equal(second.statusCode, 201);
      assert.equal(second.headers['x-idempotent-replayed'], 'true');
      assert.equal(second.body, first.body);
      assert.deepEqual(
        normalizeSetCookieHeader(second.headers['set-cookie'] as string | string[] | undefined),
        normalizeSetCookieHeader(first.headers['set-cookie'] as string | string[] | undefined),
      );
    });

    it('同一个 Idempotency-Key 不能复用到不同请求', async () => {
      const first = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        headers: {
          'idempotency-key': 'register-idem-2',
        },
        payload: { email: 'idem-mismatch@example.com', password: 'password123' },
      });
      assert.equal(first.statusCode, 201);

      const second = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        headers: {
          'idempotency-key': 'register-idem-2',
        },
        payload: { email: 'idem-other@example.com', password: 'password123' },
      });

      assert.equal(second.statusCode, 409);
      const body = JSON.parse(second.body);
      assert.equal(body.error, 'StateError');
      assert.match(body.message, /Idempotency-Key/);
    });
  });

  describe('POST /api/v1/auth/login', () => {
    it('正确凭证返回 token', async () => {
      await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: { email: 'login@example.com', password: 'password123' },
      });

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email: 'login@example.com', password: 'password123' },
      });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.ok(body.data.accessToken);
      assert.ok(body.data.refreshToken);
      assert.equal(body.data.email, 'login@example.com');
    });

    it('错误密码返回 401', async () => {
      await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: { email: 'wrong@example.com', password: 'password123' },
      });

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email: 'wrong@example.com', password: 'wrong-password' },
      });
      assert.equal(res.statusCode, 401);
    });

    it('不存在的邮箱返回 401', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email: 'nonexistent@example.com', password: 'password123' },
      });
      assert.equal(res.statusCode, 401);
    });
  });

  describe('POST /api/v1/auth/refresh', () => {
    it('有效刷新令牌返回新 token 对', async () => {
      const regRes = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: { email: 'refresh@example.com', password: 'password123' },
      });
      const { refreshToken } = JSON.parse(regRes.body).data;

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/refresh',
        payload: { refreshToken },
      });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.ok(body.data.accessToken);
      assert.ok(body.data.refreshToken);
      /* 新旧 refresh token 不同（令牌轮转） */
      assert.notEqual(body.data.refreshToken, refreshToken);
    });

    it('旧刷新令牌被吊销后不可用', async () => {
      const regRes = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: { email: 'revoke@example.com', password: 'password123' },
      });
      const { refreshToken } = JSON.parse(regRes.body).data;

      /* 使用一次后旧令牌被吊销 */
      await app.inject({
        method: 'POST',
        url: '/api/v1/auth/refresh',
        payload: { refreshToken },
      });

      /* 再次使用旧令牌应失败 */
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/refresh',
        payload: { refreshToken },
      });
      assert.equal(res.statusCode, 401);
    });

    it('无效刷新令牌返回 401', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/refresh',
        payload: { refreshToken: 'invalid-token' },
      });
      assert.equal(res.statusCode, 401);
    });
  });

  describe('POST /api/v1/auth/logout', () => {
    it('按 refreshToken 吊销后不可刷新', async () => {
      const regRes = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: { email: 'logout@example.com', password: 'password123' },
      });
      const { refreshToken } = JSON.parse(regRes.body).data;

      const logoutRes = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/logout',
        payload: { refreshToken },
      });
      assert.equal(logoutRes.statusCode, 204);

      const refreshRes = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/refresh',
        payload: { refreshToken },
      });
      assert.equal(refreshRes.statusCode, 401);
    });

    it('无 body 也返回 204', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/logout',
        payload: {},
      });
      assert.equal(res.statusCode, 204);
    });
  });
});
