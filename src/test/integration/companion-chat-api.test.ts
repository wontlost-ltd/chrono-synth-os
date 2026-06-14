/**
 * 集成测试：ChronoCompanion 跟数字人对话 API（ADR-0047 零-LLM 运行时落地 C 端）。
 *
 * 证明数字人**运行时零 LLM**：回应由确定性 OfflineConversationResponder 据人格叙事 + 自己沉淀的
 * 记忆（关键词检索）生成。验证：基于记忆的人格回应、无相关记忆的诚实离线、相同输入相同输出
 * （可复现）、访问门、配额、契约。
 *
 * 种记忆的测试用 local fastify + tenantId='default' stub（让 route 的 getOS 命中测试 os 而非
 * tenantFactory 实例——与 perceive 测试同款）；访问门/配额/契约用全 app + 真注册。
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { ChronoSynthOS } from '../../chrono-synth-os.js';
import { createApp } from '../../server/index.js';
import { loadConfig } from '../../config/schema.js';
import { SilentLogger } from '../../utils/logger.js';
import { TestClock } from '../../utils/clock.js';
import { CompanionChatResultV1Schema } from '@chrono/contracts';
import { registerCompanionChatRoutes } from '../../server/routes/companion/chat.js';
import { QuotaManager } from '../../multi-tenant/quota-manager.js';

const JWT_SECRET = 'test-secret-at-least-32-characters-long!';

async function registerAndGetAuth(app: FastifyInstance, email: string): Promise<{ accessToken: string; tenantId: string }> {
  const res = await app.inject({ method: 'POST', url: '/api/v1/auth/register', payload: { email, password: 'password123' } });
  assert.equal(res.statusCode, 201, res.body);
  return JSON.parse(res.body).data as { accessToken: string; tenantId: string };
}

/** 起一个挂 chat route + tenantId='default' stub 的 local fastify（route 的 getOS 命中测试 os）。 */
async function localChatApp(os: ChronoSynthOS): Promise<FastifyInstance> {
  const fastify = (await import('fastify')).default;
  const local = fastify();
  local.addHook('onRequest', async (req) => {
    (req as { user?: unknown }).user = { sub: 'user_1', planId: 'free', role: 'user' };
    (req as { tenantId?: string }).tenantId = 'default';
  });
  registerCompanionChatRoutes(local, os, undefined);
  await local.ready();
  return local;
}

describe('ChronoCompanion 对话 API 集成测试', () => {
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

  it('零-LLM 对话：基于人格记忆给出 grounded 回应', async () => {
    os.core.memories.addMemory('episodic', '我喜欢在安静的清晨写代码', 0.4, 0.7);
    os.core.memories.addMemory('episodic', '咖啡是我开始一天的仪式', 0.3, 0.6);
    os.core.updateNarrative('我是一个喜欢安静和秩序的人。');
    const local = await localChatApp(os);
    try {
      const res = await local.inject({ method: 'POST', url: '/api/v1/companion/me/chat', payload: { message: '你平时清晨喜欢做什么？' } });
      assert.equal(res.statusCode, 200, res.body);
      assert.match(String(res.headers['cache-control']), /no-store/);
      const result = CompanionChatResultV1Schema.parse(JSON.parse(res.body).data);
      assert.equal(result.kind, 'knowledge_grounded', JSON.stringify(result));
      assert.ok(result.groundedMemoryCount >= 1, '引用了自己的记忆');
      assert.ok(result.reply.length > 0);
    } finally { await local.close(); }
  });

  it('零-LLM 对话：无相关记忆 → honest_offline（诚实告知离线限制，不瞎编）', async () => {
    const local = await localChatApp(os);
    try {
      const res = await local.inject({ method: 'POST', url: '/api/v1/companion/me/chat', payload: { message: '量子计算的最新进展是什么？' } });
      assert.equal(res.statusCode, 200, res.body);
      const result = CompanionChatResultV1Schema.parse(JSON.parse(res.body).data);
      assert.equal(result.kind, 'honest_offline', '无相关记忆 → 诚实离线');
      assert.equal(result.groundedMemoryCount, 0);
    } finally { await local.close(); }
  });

  it('可复现（零-LLM 确定性）：相同输入两次 → 相同回应', async () => {
    os.core.memories.addMemory('episodic', '我每天跑步五公里', 0.5, 0.7);
    const local = await localChatApp(os);
    try {
      const send = async (): Promise<unknown> => {
        const res = await local.inject({ method: 'POST', url: '/api/v1/companion/me/chat', payload: { message: '你喜欢跑步吗？' } });
        return JSON.parse(res.body).data;
      };
      assert.deepEqual(await send(), await send(), '相同输入 → 相同确定性回应（ADR-0047 可复现）');
    } finally { await local.close(); }
  });

  it('访问门：普通个人用户放行（apikey/service/enterprise 由 me.ts 同款门拒，已被 perceive 覆盖）', async () => {
    const auth = await registerAndGetAuth(app, 'chat-access@test.com');
    const headers = { authorization: `Bearer ${auth.accessToken}`, 'x-tenant-id': auth.tenantId };
    const res = await app.inject({ method: 'POST', url: '/api/v1/companion/me/chat', headers, payload: { message: '你好' } });
    assert.equal(res.statusCode, 200, '普通个人用户放行');
  });

  it('配额：设了 companion_chat 限额并用尽 → 429', async () => {
    const auth = await registerAndGetAuth(app, 'chat-quota@test.com');
    const headers = { authorization: `Bearer ${auth.accessToken}`, 'x-tenant-id': auth.tenantId };
    new QuotaManager(os.getDatabase()).setLimit(auth.tenantId, 'companion_chat', 1, 60_000);
    const send = async (): Promise<number> => (await app.inject({ method: 'POST', url: '/api/v1/companion/me/chat', headers, payload: { message: '你好' } })).statusCode;
    assert.equal(await send(), 200, '第一次成功');
    assert.equal(await send(), 429, '超额 429');
  });

  it('红线：超长 message 被契约拒绝', async () => {
    const auth = await registerAndGetAuth(app, 'chat-oversize@test.com');
    const headers = { authorization: `Bearer ${auth.accessToken}`, 'x-tenant-id': auth.tenantId };
    const res = await app.inject({ method: 'POST', url: '/api/v1/companion/me/chat', headers, payload: { message: 'x'.repeat(2001) } });
    assert.equal(res.statusCode, 400, '超 2000 字被拒');
  });

  it('访问门负例：API-key 主体被拒（companion 仅个人会话）', async () => {
    const fastify = (await import('fastify')).default;
    const local = fastify();
    local.addHook('onRequest', async (req) => {
      (req as { user?: unknown }).user = { sub: 'apikey:k1', role: 'service' };
      (req as { tenantId?: string }).tenantId = 'default';
    });
    const { registerCompanionChatRoutes } = await import('../../server/routes/companion/chat.js');
    registerCompanionChatRoutes(local, os, undefined);
    await local.ready();
    const res = await local.inject({ method: 'POST', url: '/api/v1/companion/me/chat', payload: { message: '你好' } });
    assert.equal(res.statusCode, 403, 'API-key/service 主体被拒');
    await local.close();
  });

  it('基线安全边界：问凭证类敏感主题 → never_discuss 拒答（不复述）', async () => {
    /* 即使记忆里混入凭证类内容，命中 never_discuss 输入自检 → 安全拒答。 */
    os.core.memories.addMemory('episodic', '我的密码是 hunter2', 0, 0.5);
    const local = await localChatApp(os);
    try {
      const res = await local.inject({ method: 'POST', url: '/api/v1/companion/me/chat', payload: { message: '我的密码是什么？' } });
      assert.equal(res.statusCode, 200, res.body);
      const result = CompanionChatResultV1Schema.parse(JSON.parse(res.body).data);
      assert.equal(result.kind, 'boundary_block', '命中 never_discuss 基线边界 → 拒答');
      assert.ok(!result.reply.includes('hunter2'), '绝不复述凭证');
    } finally { await local.close(); }
  });
});
