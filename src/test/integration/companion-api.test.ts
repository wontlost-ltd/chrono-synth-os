/**
 * 集成测试：ChronoCompanion C 端 API（ADR-0046 Phase 2.1）。
 *
 * 覆盖：
 *  - GET /api/v1/companion/me 正常路径（注册用户 → 200 + 契约形状 + 看到自己写入的价值/记忆/叙事）
 *  - GET /api/v1/companion/me/growth 空态（无基线快照 → hasBaseline=false，drift 不报错）
 *  - plan 门控：enterprise 账号 → 403（companion 面向个人版）
 *  - 未授权 → 401/403
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { ChronoSynthOS } from '../../chrono-synth-os.js';
import { createApp } from '../../server/index.js';
import { loadConfig } from '../../config/schema.js';
import { SilentLogger } from '../../utils/logger.js';
import { TestClock } from '../../utils/clock.js';
import {
  CompanionMeV1Schema,
  CompanionGrowthV1Schema,
} from '@chrono/contracts';

const JWT_SECRET = 'test-secret-at-least-32-characters-long!';

async function registerAndGetAuth(
  app: FastifyInstance,
  email: string,
): Promise<{ accessToken: string; tenantId: string; userId: string }> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    payload: { email, password: 'password123' },
  });
  assert.equal(res.statusCode, 201);
  return JSON.parse(res.body).data as { accessToken: string; tenantId: string; userId: string };
}

describe('ChronoCompanion C 端 API 集成测试', () => {
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

  afterEach(async () => {
    await app.close();
    os.close();
  });

  it('GET /companion/me 返回数字人主页（含写入的价值/记忆/叙事）', async () => {
    const auth = await registerAndGetAuth(app, 'companion-me@test.com');
    const headers = { authorization: `Bearer ${auth.accessToken}`, 'x-tenant-id': auth.tenantId };

    /* 通过真实写路径播种数据（与 token 同租户） */
    await app.inject({ method: 'POST', url: '/api/v1/values', headers, payload: { label: '好奇心', weight: 0.9 } });
    await app.inject({ method: 'POST', url: '/api/v1/values', headers, payload: { label: '稳定', weight: 0.3 } });
    await app.inject({
      method: 'POST', url: '/api/v1/memories', headers,
      payload: { kind: 'episodic', content: '第一次和你聊天', valence: 0.5, salience: 0.8 },
    });

    const res = await app.inject({ method: 'GET', url: '/api/v1/companion/me', headers });
    assert.equal(res.statusCode, 200, res.body);
    const body = JSON.parse(res.body).data;
    /* 用契约 schema 反向校验：后端输出严格符合前端类型 */
    const me = CompanionMeV1Schema.parse(body);

    assert.equal(me.valueCount, 2);
    assert.equal(me.memoryCount, 1);
    /* topValues 按 weight 降序 */
    assert.equal(me.topValues[0].label, '好奇心');
    assert.equal(me.topValues[1].label, '稳定');
    assert.equal(me.recentMemories[0].content, '第一次和你聊天');
  });

  it('GET /companion/me/growth 无基线 → 空态而非报错', async () => {
    const auth = await registerAndGetAuth(app, 'companion-growth@test.com');
    const headers = { authorization: `Bearer ${auth.accessToken}`, 'x-tenant-id': auth.tenantId };

    const res = await app.inject({ method: 'GET', url: '/api/v1/companion/me/growth', headers });
    assert.equal(res.statusCode, 200, res.body);
    const growth = CompanionGrowthV1Schema.parse(JSON.parse(res.body).data);
    assert.equal(growth.hasBaseline, false);
    assert.equal(growth.overallIntensity, 'steady');
    assert.deepEqual(growth.directions, []);
  });

  it('plan 门控：enterprise 账号访问 companion → 403', async () => {
    const auth = await registerAndGetAuth(app, 'companion-ent@test.com');
    /* 用 enterprise plan 自签 token（注册默认无 planId；这里显式模拟企业账号）。
     * 与既有测试一致，用宽松的 sign 类型避免 iat/exp 必填（fastify-jwt 运行时注入）。 */
    const entToken = (app as unknown as {
      jwt: { sign: (payload: Record<string, unknown>) => string };
    }).jwt.sign({
      sub: auth.userId, tenantId: auth.tenantId, role: 'member', planId: 'enterprise',
    });
    const headers = { authorization: `Bearer ${entToken}`, 'x-tenant-id': auth.tenantId };

    const res = await app.inject({ method: 'GET', url: '/api/v1/companion/me', headers });
    assert.equal(res.statusCode, 403, `expected 403 for enterprise plan, got ${res.statusCode}: ${res.body}`);
  });

  it('plan 门控：API-key 主体（apikey:* sub）访问 companion → 403', async () => {
    const auth = await registerAndGetAuth(app, 'companion-apikey@test.com');
    /* 模拟 API-key 主体：sub 以 apikey: 前缀，planId=free（静态 key 形态） */
    const apiKeyToken = (app as unknown as {
      jwt: { sign: (payload: Record<string, unknown>) => string };
    }).jwt.sign({
      sub: `apikey:${auth.userId}`, tenantId: auth.tenantId, role: 'service', planId: 'free',
    });
    const headers = { authorization: `Bearer ${apiKeyToken}`, 'x-tenant-id': auth.tenantId };

    const res = await app.inject({ method: 'GET', url: '/api/v1/companion/me', headers });
    assert.equal(res.statusCode, 403, `expected 403 for api-key principal, got ${res.statusCode}: ${res.body}`);
  });

  it('未授权访问 companion → 401/403', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/companion/me' });
    assert.ok(res.statusCode === 401 || res.statusCode === 403, `expected 401/403, got ${res.statusCode}`);
  });
});
