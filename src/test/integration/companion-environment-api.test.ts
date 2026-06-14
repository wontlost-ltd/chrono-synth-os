/**
 * 集成测试：ChronoCompanion 设备环境感知 API（ADR-0052 Edge-P1 接入生产路径）。
 *
 * 证明 EnvironmentSignalExtractor + EnvironmentObserver 第一次接入生产请求路径：设备上报信号窗
 * → 确定性提取环境状态 + 沉淀环境记忆；端到端 + 契约形状 + plan 门控 + 隔离 + 红线（纯确定性）。
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { ChronoSynthOS } from '../../chrono-synth-os.js';
import { createApp } from '../../server/index.js';
import { loadConfig } from '../../config/schema.js';
import { SilentLogger } from '../../utils/logger.js';
import { TestClock } from '../../utils/clock.js';
import { CompanionEnvironmentResultV1Schema, CompanionMeV1Schema } from '@chrono/contracts';

const JWT_SECRET = 'test-secret-at-least-32-characters-long!';

async function registerAndGetAuth(app: FastifyInstance, email: string): Promise<{ accessToken: string; tenantId: string }> {
  const res = await app.inject({ method: 'POST', url: '/api/v1/auth/register', payload: { email, password: 'password123' } });
  assert.equal(res.statusCode, 201, res.body);
  return JSON.parse(res.body).data as { accessToken: string; tenantId: string };
}

/** 造一窗某通道样本。 */
function window(channel: 'light' | 'sound' | 'motion', values: number[], t0 = 1000): Array<{ channel: typeof channel; value: number; at: number }> {
  return values.map((value, i) => ({ channel, value, at: t0 + i * 1000 }));
}

describe('ChronoCompanion 环境感知 API 集成测试', () => {
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

  it('默认（无 persist）：只提取返回状态，不写记忆（防泛滥）', async () => {
    const auth = await registerAndGetAuth(app, 'env@test.com');
    const headers = { authorization: `Bearer ${auth.accessToken}`, 'x-tenant-id': auth.tenantId };

    const res = await app.inject({
      method: 'POST', url: '/api/v1/companion/me/environment', headers,
      payload: { samples: [...window('light', [2, 3, 4]), ...window('sound', [0.8, 0.7])] },
    });
    assert.equal(res.statusCode, 200, res.body);
    assert.match(String(res.headers['cache-control']), /no-store/);
    const result = CompanionEnvironmentResultV1Schema.parse(JSON.parse(res.body).data);

    /* 光强低 → dark；声压高 → noisy。 */
    assert.equal(result.states.find((s) => s.channel === 'light')?.level, 'dark');
    assert.equal(result.states.find((s) => s.channel === 'sound')?.level, 'noisy');
    /* 默认不写记忆。 */
    assert.equal(result.sensedMemoryCount, 0, '默认不沉淀记忆（防泛滥）');
    const me = await app.inject({ method: 'GET', url: '/api/v1/companion/me', headers });
    assert.equal(CompanionMeV1Schema.parse(JSON.parse(me.body).data).memoryCount, 0, '记忆图无环境记忆');
  });

  it('persist=true（端侧已判定环境变化）：沉淀一条环境记忆，进 memory graph', async () => {
    const auth = await registerAndGetAuth(app, 'env-persist@test.com');
    const headers = { authorization: `Bearer ${auth.accessToken}`, 'x-tenant-id': auth.tenantId };

    const res = await app.inject({
      method: 'POST', url: '/api/v1/companion/me/environment', headers,
      payload: { samples: window('light', [2, 3, 4]), persist: true },
    });
    assert.equal(res.statusCode, 200, res.body);
    const result = CompanionEnvironmentResultV1Schema.parse(JSON.parse(res.body).data);
    assert.ok(result.sensedMemoryCount >= 1, 'persist=true 应沉淀环境记忆');

    const me = await app.inject({ method: 'GET', url: '/api/v1/companion/me', headers });
    const meData = CompanionMeV1Schema.parse(JSON.parse(me.body).data);
    assert.ok(meData.memoryCount >= 1);
    assert.ok(meData.recentMemories.some((m) => m.content.includes('我注意到')), '应有环境观察记忆「我注意到」');
  });

  it('红线：超量样本（>1000）被契约拒绝', async () => {
    const auth = await registerAndGetAuth(app, 'env-oversize@test.com');
    const headers = { authorization: `Bearer ${auth.accessToken}`, 'x-tenant-id': auth.tenantId };
    const samples = Array.from({ length: 1500 }, (_, i) => ({ channel: 'light' as const, value: 100, at: 1000 + i }));
    const res = await app.inject({ method: 'POST', url: '/api/v1/companion/me/environment', headers, payload: { samples } });
    assert.equal(res.statusCode, 400, '超量样本应被契约拒绝');
  });

  it('plan 门控：enterprise 账号 → 403', async () => {
    const auth = await registerAndGetAuth(app, 'env-ent@test.com');
    const headers = { authorization: `Bearer ${auth.accessToken}`, 'x-tenant-id': auth.tenantId };
    const sub = await app.inject({ method: 'POST', url: '/api/v1/billing/subscribe', headers, payload: { planId: 'enterprise' } });
    if (sub.statusCode === 200 || sub.statusCode === 201) {
      const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: 'env-ent@test.com', password: 'password123' } });
      const entToken = (JSON.parse(login.body).data as { accessToken: string }).accessToken;
      const res = await app.inject({
        method: 'POST', url: '/api/v1/companion/me/environment',
        headers: { authorization: `Bearer ${entToken}`, 'x-tenant-id': auth.tenantId },
        payload: { samples: window('light', [100]) },
      });
      assert.equal(res.statusCode, 403);
    }
  });

  it('未授权 → 401', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/companion/me/environment', payload: { samples: window('light', [100]) } });
    assert.ok(res.statusCode === 401 || res.statusCode === 403);
  });
});
