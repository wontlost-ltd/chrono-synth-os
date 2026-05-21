/**
 * P0-C 否定测试 — JWT/Refresh Token 已吊销重放尝试
 *
 * Plan: poc-to-enterprise-ga-2026-v7.3.md §2.2 P0-C + §8 #4
 *
 * 验证 refresh-token 一旦被 revoke / 使用过 / 用户全量吊销，再次使用必拒。
 *
 * 注：完整 JWT key lifecycle 状态机（active/grace/retired/compromised）
 * 是 P0-D 单独任务（W3-W8）。本测试覆盖 refresh-token 层面的已吊销重放，
 * 这是 P0-C 验收 acceptance 中已可执行的子集。
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

interface AuthTokens { accessToken: string; refreshToken: string }

async function registerUser(app: FastifyInstance, email: string): Promise<AuthTokens> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    payload: { email, password: 'password123' },
  });
  /* POST /register returns 201 (resource created); rbac test does not assert it explicitly */
  assert.ok(res.statusCode >= 200 && res.statusCode < 300, `register failed: ${res.statusCode} ${res.body}`);
  const body = JSON.parse(res.body).data;
  return { accessToken: body.accessToken, refreshToken: body.refreshToken };
}

async function refreshTokens(app: FastifyInstance, refreshToken: string) {
  return app.inject({
    method: 'POST',
    url: '/api/v1/auth/refresh',
    payload: { refreshToken },
  });
}

describe('P0-C negative — JWT / refresh token 已吊销重放尝试', () => {
  let os: ChronoSynthOS;
  let app: FastifyInstance;

  const config = loadConfig({
    rateLimit: { max: 10000, timeWindowMs: 60_000 },
    websocket: { enabled: false, heartbeatIntervalMs: 30_000 },
    jwt: { enabled: true, secret: JWT_SECRET, issuer: 'test' },
  });

  beforeEach(async () => {
    os = new ChronoSynthOS({ clock: new TestClock(1000), logger: new SilentLogger() });
    os.start();
    app = await createApp({ os, config });
  });

  afterEach(async () => { await app.close(); os.close(); });

  it('refresh-token 一次性消费：旧 token 第二次 refresh 必拒', async () => {
    const tokens = await registerUser(app, 'user1@example.com');

    /* 第一次 refresh 成功 */
    const first = await refreshTokens(app, tokens.refreshToken);
    assert.ok(first.statusCode >= 200 && first.statusCode < 300, `first refresh failed: ${first.statusCode} ${first.body}`);

    /* 用旧 refresh-token 第二次 refresh 必须失败（非 2xx） */
    const second = await refreshTokens(app, tokens.refreshToken);
    assert.ok(second.statusCode >= 400, `revoked refresh token 应被拒绝，实际 ${second.statusCode}`);
  });

  it('登出后旧 refresh-token 立即失效', async () => {
    const tokens = await registerUser(app, 'user2@example.com');

    /* 登出 */
    const logout = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: { authorization: `Bearer ${tokens.accessToken}` },
      payload: { refreshToken: tokens.refreshToken },
    });
    assert.ok(logout.statusCode >= 200 && logout.statusCode < 300, `logout failed: ${logout.statusCode} ${logout.body}`);

    /* logout 后用旧 refresh-token 不应成功 */
    const refreshAfterLogout = await refreshTokens(app, tokens.refreshToken);
    assert.ok(refreshAfterLogout.statusCode >= 400, `logout 后的 refresh 应被拒，实际 ${refreshAfterLogout.statusCode}`);
  });

  it('伪造（未签发过的）refresh-token 拒绝', async () => {
    const fake = 'fake-token-that-never-existed-' + 'x'.repeat(32);
    const res = await refreshTokens(app, fake);
    assert.ok(res.statusCode >= 400, `未签发的 refresh token 应被拒，实际 ${res.statusCode}`);
  });

  it('格式无效的 Bearer token 拒绝（受保护端点）', async () => {
    /* This covers malformed JWT rejection, NOT actual `exp`-based expiration
     * or signed-but-revoked token replay. True expired/revoked-access-token
     * coverage requires either a forged JWT with past `exp` (deferred to
     * P0-D when key lifecycle adds a test signing helper) or clock-mocking
     * the verification path (also P0-D scope). */
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/audit-trail',  /* any JWT-protected route */
      headers: { authorization: 'Bearer this.is.not.a.valid.jwt' },
    });
    assert.equal(res.statusCode, 401);
  });
});
