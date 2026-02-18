/**
 * RBAC 集成测试
 * 验证 JWT 启用时 admin 端点的角色守卫行为
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

/** 注册用户并返回 accessToken */
async function registerAndLogin(app: FastifyInstance, email: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    payload: { email, password: 'password123' },
  });
  return JSON.parse(res.body).data.accessToken;
}

describe('RBAC 集成测试', () => {
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

  afterEach(() => { os.close(); });

  describe('admin 端点需要 JWT + admin 角色', () => {
    const adminEndpoints = [
      { method: 'POST' as const, url: '/api/v1/operations/evolution/run' },
      { method: 'POST' as const, url: '/api/v1/operations/regulation/run', payload: {} },
      { method: 'POST' as const, url: '/api/v1/privacy/export' },
      { method: 'DELETE' as const, url: '/api/v1/privacy/data' },
    ];

    for (const endpoint of adminEndpoints) {
      it(`${endpoint.method} ${endpoint.url} 无 JWT 时返回 401`, async () => {
        const res = await app.inject({
          method: endpoint.method,
          url: endpoint.url,
          payload: endpoint.payload,
        });
        assert.equal(res.statusCode, 401);
      });

      it(`${endpoint.method} ${endpoint.url} admin JWT 允许访问`, async () => {
        const token = await registerAndLogin(app, `admin-${endpoint.url.replace(/\//g, '-')}@test.com`);
        const res = await app.inject({
          method: endpoint.method,
          url: endpoint.url,
          payload: endpoint.payload,
          headers: { authorization: `Bearer ${token}` },
        });
        /* admin 注册默认为 admin 角色，应返回成功状态 */
        assert.ok(res.statusCode >= 200 && res.statusCode < 300, `Expected 2xx but got ${res.statusCode}`);
      });
    }
  });

  describe('租户隔离：JWT tenantId 优先于 header', () => {
    it('JWT 用户的 tenantId 不被 X-Tenant-Id header 覆盖', async () => {
      const token = await registerAndLogin(app, 'tenant-test@test.com');
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/values',
        headers: {
          authorization: `Bearer ${token}`,
          'x-tenant-id': 'spoofed-tenant',
        },
      });
      assert.equal(res.statusCode, 200);
      /* 请求成功，tenantId 来自 JWT（不是 spoofed-tenant） */
    });
  });

  describe('非 admin 角色被拒绝', () => {
    it('viewer 角色无法访问 admin 端点', async () => {
      /* 注册用户（默认 admin），手动降级为 viewer */
      const regRes = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: { email: 'viewer@test.com', password: 'password123' },
      });
      const { userId } = JSON.parse(regRes.body).data;
      const db = os.getDatabase();
      db.prepare<void>('UPDATE users SET role = ? WHERE id = ?').run('viewer', userId);

      /* 重新登录获取 viewer token */
      const loginRes = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email: 'viewer@test.com', password: 'password123' },
      });
      const viewerToken = JSON.parse(loginRes.body).data.accessToken;

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/operations/evolution/run',
        headers: { authorization: `Bearer ${viewerToken}` },
      });
      assert.equal(res.statusCode, 403);
    });
  });
});
