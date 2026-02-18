/**
 * 计费 API 集成测试
 * 覆盖 plans / usage / checkout 验证 / webhook 验证
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

describe('计费 API 集成测试', () => {
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

  afterEach(() => {
    os.close();
  });

  describe('GET /api/v1/billing/plans', () => {
    it('返回所有可用计划', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/billing/plans',
      });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.ok(Array.isArray(body.data));
      assert.ok(body.data.length >= 1);
      assert.ok(body.data[0].id);
      assert.ok(body.data[0].name);
      assert.ok(body.data[0].limits);
    });
  });

  describe('GET /api/v1/billing/usage', () => {
    it('注册用户获取用量信息', async () => {
      const regRes = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: { email: 'billing@example.com', password: 'password123' },
      });
      const { accessToken, tenantId } = JSON.parse(regRes.body).data;

      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/billing/usage',
        headers: {
          authorization: `Bearer ${accessToken}`,
          'x-tenant-id': tenantId,
        },
      });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.data.planId, 'free');
      assert.equal(body.data.status, 'active');
      assert.ok(body.data.limits);
      assert.ok(body.data.usage !== undefined);
    });
  });

  describe('POST /api/v1/billing/checkout（Stripe 未启用时）', () => {
    it('Stripe 未启用时 checkout 返回 404', async () => {
      /* config.stripe.enabled 默认 false，路由不注册 */
      const regRes = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: { email: 'checkout@example.com', password: 'password123' },
      });
      const { accessToken, tenantId } = JSON.parse(regRes.body).data;

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/billing/checkout',
        headers: { authorization: `Bearer ${accessToken}`, 'x-tenant-id': tenantId },
        payload: { priceId: 'price_xxx', successUrl: '/success', cancelUrl: '/cancel' },
      });
      assert.equal(res.statusCode, 404);
    });
  });

  describe('POST /api/v1/billing/webhook（Stripe 未启用时）', () => {
    it('Stripe 未启用时 webhook 返回 404', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/billing/webhook',
        payload: {},
      });
      assert.equal(res.statusCode, 404);
    });
  });
});
