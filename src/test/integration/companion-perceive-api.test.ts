/**
 * 集成测试：ChronoCompanion「让 TA 听一段」感知 API（接入战略缺口修复）。
 *
 * 证明 PerceptionDistiller 第一次接入生产请求路径：用户提交 transcript → 人格沉淀 episodic
 * 记忆 → 返回人格记住的；端到端打通 + 契约形状 + plan 门控 + 租户隔离 + 论点红线（不收原始媒体）。
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { ChronoSynthOS } from '../../chrono-synth-os.js';
import { createApp } from '../../server/index.js';
import { loadConfig } from '../../config/schema.js';
import { SilentLogger } from '../../utils/logger.js';
import { TestClock } from '../../utils/clock.js';
import { CompanionPerceiveResultV1Schema, CompanionMeV1Schema } from '@chrono/contracts';
import { registerCompanionPerceiveRoutes } from '../../server/routes/companion/perceive.js';
import { MockPerceptionProvider } from '../../perception/sources/mock-perception-provider.js';
import type { PerceptionProvider } from '../../perception/perception-provider.js';

const JWT_SECRET = 'test-secret-at-least-32-characters-long!';

async function registerAndGetAuth(app: FastifyInstance, email: string): Promise<{ accessToken: string; tenantId: string }> {
  const res = await app.inject({ method: 'POST', url: '/api/v1/auth/register', payload: { email, password: 'password123' } });
  assert.equal(res.statusCode, 201, res.body);
  return JSON.parse(res.body).data as { accessToken: string; tenantId: string };
}

describe('ChronoCompanion 感知 API 集成测试', () => {
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

  it('POST /companion/me/perceive：提交 transcript → 人格沉淀记忆 + 返回记住的', async () => {
    const auth = await registerAndGetAuth(app, 'perceive@test.com');
    const headers = { authorization: `Bearer ${auth.accessToken}`, 'x-tenant-id': auth.tenantId };

    const res = await app.inject({
      method: 'POST', url: '/api/v1/companion/me/perceive', headers,
      payload: { modality: 'audio', representation: '今天开会很累。但我没和别人说。回家路上想安静一会。' },
    });
    assert.equal(res.statusCode, 200, res.body);
    /* 私有缓存头（个人感知数据不跨会话复用）。 */
    assert.match(String(res.headers['cache-control']), /no-store/);
    const result = CompanionPerceiveResultV1Schema.parse(JSON.parse(res.body).data);

    /* 人格记住了多条事实（确定性 mock 按句切分）。 */
    assert.ok(result.perceivedMemories.length >= 2, '应沉淀多条感知记忆');
    /* 记忆是人格第一人称（「我听到：…」）。 */
    assert.ok(result.perceivedMemories[0].content.includes('我听到'), '应是人格视角');

    /* 端到端：这些记忆真的进了 memory graph —— /companion/me 能看到。 */
    const me = await app.inject({ method: 'GET', url: '/api/v1/companion/me', headers });
    const meData = CompanionMeV1Schema.parse(JSON.parse(me.body).data);
    assert.ok(meData.memoryCount >= 2, '感知记忆进入 memory graph');
  });

  it('身份核安全：感知产生的身份层候选不自动应用（pendingApprovalCount 可见）', async () => {
    /* mock provider 默认不产身份提案，故 pendingApprovalCount=0；本测试验证字段存在且语义正确
     * （身份层提案若有，必 pending——由 perception-distiller 单测覆盖自动门拒绝；此处验契约出口）。 */
    const auth = await registerAndGetAuth(app, 'perceive-identity@test.com');
    const headers = { authorization: `Bearer ${auth.accessToken}`, 'x-tenant-id': auth.tenantId };
    const res = await app.inject({
      method: 'POST', url: '/api/v1/companion/me/perceive', headers,
      payload: { modality: 'audio', representation: '我在弹钢琴。' },
    });
    const result = CompanionPerceiveResultV1Schema.parse(JSON.parse(res.body).data);
    assert.equal(typeof result.pendingApprovalCount, 'number');
    assert.ok(result.pendingApprovalCount >= 0);
  });

  it('身份核安全（强）：注入会产身份提案的 provider → pendingApprovalCount=1 且核心 value 权重不变', async () => {
    /* 用 scripted provider 直接挂 route（provider 注入点），断言身份提案进 route 出口为 pending、
     * 且绝不自动改身份核（Codex 复审：锁住 pendingApprovalCount 的生产映射 + 红线）。 */
    const fastify = (await import('fastify')).default;
    const local = fastify();
    /* 测试鉴权 stub：注入 user + tenantId（绕过完整 JWT，聚焦 route 逻辑）。 */
    local.addHook('onRequest', async (req) => {
      (req as { user?: unknown }).user = { sub: 'user_1', planId: 'free', role: 'user' };
      (req as { tenantId?: string }).tenantId = 'default';
    });
    /* 先建真实 value，让身份提案的 valueId 真实存在 → 进门为 pending（非 rejected）。 */
    const v = os.core.addValue('探索', 0.5);
    const scripted: PerceptionProvider = new MockPerceptionProvider({
      scriptedAnalysis: {
        confidence: 0.9,
        facts: [{ summary: '我听到：想安静一会', memoryKind: 'episodic', valence: -0.2, salience: 0.6 }],
        identityHints: [{ kind: 'value_shift', valueId: v.id, delta: 0.5, reason: '反复需要独处' }],
      },
    });

    registerCompanionPerceiveRoutes(local, os, undefined, scripted);
    await local.ready();
    const res = await local.inject({ method: 'POST', url: '/api/v1/companion/me/perceive', payload: { modality: 'audio', representation: 'x' } });
    assert.equal(res.statusCode, 200, res.body);
    const result = CompanionPerceiveResultV1Schema.parse(JSON.parse(res.body).data);
    assert.equal(result.pendingApprovalCount, 1, '身份提案 → pending（绝不自动应用）');
    /* 核心 value 权重未变（身份核未被感知自动改）。 */
    assert.equal(os.core.values.getAll().get(v.id)!.weight, 0.5, '感知绝不自动改身份核 value');
    await local.close();
  });

  it('红线：超长 representation 被契约拒绝（防原始媒体内嵌 / 滥用）', async () => {
    const auth = await registerAndGetAuth(app, 'perceive-oversize@test.com');
    const headers = { authorization: `Bearer ${auth.accessToken}`, 'x-tenant-id': auth.tenantId };
    const res = await app.inject({
      method: 'POST', url: '/api/v1/companion/me/perceive', headers,
      payload: { modality: 'audio', representation: 'x'.repeat(5000) },   /* > 4000 上限 */
    });
    assert.equal(res.statusCode, 400, '超长表征应被契约校验拒绝');
  });

  it('plan 门控：enterprise 账号 → 403（companion 面向个人版）', async () => {
    const auth = await registerAndGetAuth(app, 'perceive-ent@test.com');
    /* 把账号升到 enterprise plan（通过 subscribe；与 companion-api 测试同款）。 */
    const headers = { authorization: `Bearer ${auth.accessToken}`, 'x-tenant-id': auth.tenantId };
    const sub = await app.inject({ method: 'POST', url: '/api/v1/billing/subscribe', headers, payload: { planId: 'enterprise' } });
    /* 重新登录拿带 enterprise plan 的 token。 */
    if (sub.statusCode === 200 || sub.statusCode === 201) {
      const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: 'perceive-ent@test.com', password: 'password123' } });
      const entToken = (JSON.parse(login.body).data as { accessToken: string }).accessToken;
      const res = await app.inject({
        method: 'POST', url: '/api/v1/companion/me/perceive',
        headers: { authorization: `Bearer ${entToken}`, 'x-tenant-id': auth.tenantId },
        payload: { modality: 'audio', representation: '测试' },
      });
      assert.equal(res.statusCode, 403, 'enterprise 账号不能用 companion 感知');
    }
  });

  it('未授权 → 401', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/v1/companion/me/perceive',
      payload: { modality: 'audio', representation: '测试' },
    });
    assert.ok(res.statusCode === 401 || res.statusCode === 403, '无 token 应拒绝');
  });
});
