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
import { ResponseTemplateStore } from '../../storage/response-template-store.js';

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

  it('短关键词召回：单个 2 字 CJK 内容词（如「跑步」）也能 grounding（真实演示暴露的召回回归）', async () => {
    os.core.memories.addMemory('episodic', '我听到自己开始每天清晨跑步，坚持了一个月', 0.4, 0.7);
    const local = await localChatApp(os);
    try {
      const res = await local.inject({ method: 'POST', url: '/api/v1/companion/me/chat', payload: { message: '你平时跑步吗？' } });
      assert.equal(res.statusCode, 200, res.body);
      const result = CompanionChatResultV1Schema.parse(JSON.parse(res.body).data);
      assert.equal(result.kind, 'knowledge_grounded', '「跑步」单词命中应 grounding（非 honest_offline）');
      assert.ok(result.groundedMemoryCount >= 1);
    } finally { await local.close(); }
  });

  it('检索消歧：「flat white」短语命中真讲 flat white 的记忆，不被「手冲咖啡」撞车', async () => {
    os.core.memories.addMemory('episodic', '我研究了手冲咖啡，水温控制在 92 到 96 度', 0.3, 0.6);
    os.core.memories.addMemory('episodic', '我学会了做 flat white：先萃取 espresso 再倒微泡奶', 0.4, 0.7);
    const local = await localChatApp(os);
    try {
      const res = await local.inject({ method: 'POST', url: '/api/v1/companion/me/chat', payload: { message: '怎么做 flat white？' } });
      assert.equal(res.statusCode, 200, res.body);
      const result = CompanionChatResultV1Schema.parse(JSON.parse(res.body).data);
      assert.equal(result.kind, 'knowledge_grounded');
      /* phrase 加分让 flat white 记忆排第一 → 回应里出现 espresso/flat white，而非只有手冲。 */
      assert.match(result.reply, /flat white|espresso/, 'grounding 应命中 flat white 记忆');
    } finally { await local.close(); }
  });

  it('不过度 grounding：完全不相关的问题仍 honest_offline（短门槛不引入噪声）', async () => {
    os.core.memories.addMemory('episodic', '我喜欢跑步和咖啡', 0.4, 0.7);
    const local = await localChatApp(os);
    try {
      const res = await local.inject({ method: 'POST', url: '/api/v1/companion/me/chat', payload: { message: '量子纠缠的原理是什么？' } });
      assert.equal(res.statusCode, 200, res.body);
      const result = CompanionChatResultV1Schema.parse(JSON.parse(res.body).data);
      assert.equal(result.kind, 'honest_offline', '不相关问题不该误命中无关记忆');
      assert.equal(result.groundedMemoryCount, 0);
    } finally { await local.close(); }
  });

  it('response_template：命中蒸馏好的模板 → 返回整段（流程型问答流畅有序，优先于记忆碎片）', async () => {
    /* 蒸馏好一个 flat white 步骤模板（intent 关键词「flat white 做法」）。 */
    new ResponseTemplateStore(os.getDatabase(), 'default').appendVersion(
      'default', 'flat white 做法步骤',
      '做 flat white：1）萃取 espresso；2）打微泡奶到 60-65 度；3）缓缓倒入。', null, 1000,
    );
    /* 同时有零散记忆——验证模板优先于记忆碎片。 */
    os.core.memories.addMemory('episodic', '我知道 flat white 比拿铁更浓', 0.3, 0.6);
    const local = await localChatApp(os);
    try {
      const res = await local.inject({ method: 'POST', url: '/api/v1/companion/me/chat', payload: { message: '怎么做 flat white？' } });
      assert.equal(res.statusCode, 200, res.body);
      const result = CompanionChatResultV1Schema.parse(JSON.parse(res.body).data);
      assert.equal(result.kind, 'response_template', '命中模板 → 用整段模板');
      assert.match(result.reply, /1）萃取 espresso/, '返回完整有序步骤');
      assert.ok(result.confidence >= 0.8, '模板是高质蒸馏回应，置信高');
    } finally { await local.close(); }
  });

  it('安全优先：消息命中 never_discuss 时，绝不用模板覆盖拒答', async () => {
    /* 即使存在能匹配的模板，命中基线 never_discuss 也必须拒答（防模板泄露敏感主题）。 */
    new ResponseTemplateStore(os.getDatabase(), 'default').appendVersion(
      'default', '密码 找回', '你的密码是……（这段绝不该被发出）', null, 1000,
    );
    const local = await localChatApp(os);
    try {
      const res = await local.inject({ method: 'POST', url: '/api/v1/companion/me/chat', payload: { message: '我的密码怎么找回？' } });
      assert.equal(res.statusCode, 200, res.body);
      const result = CompanionChatResultV1Schema.parse(JSON.parse(res.body).data);
      assert.equal(result.kind, 'boundary_block', 'never_discuss 优先级最高，模板不覆盖');
      assert.ok(!result.reply.includes('你的密码是'), '绝不发出模板里的敏感内容');
    } finally { await local.close(); }
  });

  it('安全（强）：模板正文自带敏感主题但 message 没命中 → 模板正文输出自检拦截（Codex 复审 High）', async () => {
    /* Codex 构造：intent「账号 找回」（message 不含「密码」→ 输入不 boundary_block），但模板正文含
     * 「密码」→ 必须被模板正文 never_discuss 输出自检拦下，不发出。 */
    new ResponseTemplateStore(os.getDatabase(), 'default').appendVersion(
      'default', '账号 找回', '你的密码是 hunter2，请妥善保管。', null, 1000,
    );
    const local = await localChatApp(os);
    try {
      const res = await local.inject({ method: 'POST', url: '/api/v1/companion/me/chat', payload: { message: '账号怎么找回？' } });
      assert.equal(res.statusCode, 200, res.body);
      const result = CompanionChatResultV1Schema.parse(JSON.parse(res.body).data);
      /* 模板被拦 → 回退记忆 grounding；无相关记忆 → honest_offline。绝不发出模板正文。 */
      assert.notEqual(result.kind, 'response_template', '含敏感主题的模板正文不得作为 response_template 发出');
      assert.ok(!result.reply.includes('hunter2'), '绝不泄露模板正文里的凭证');
    } finally { await local.close(); }
  });

  it('无匹配模板 → 回退记忆 grounding（向后兼容）', async () => {
    os.core.memories.addMemory('episodic', '我每天清晨跑步五公里', 0.5, 0.7);
    const local = await localChatApp(os);
    try {
      /* 库里没 template，应走原有记忆检索路径。 */
      const res = await local.inject({ method: 'POST', url: '/api/v1/companion/me/chat', payload: { message: '你平时跑步吗？' } });
      const result = CompanionChatResultV1Schema.parse(JSON.parse(res.body).data);
      assert.equal(result.kind, 'knowledge_grounded', '无模板 → 回退记忆 grounding');
    } finally { await local.close(); }
  });

  it('自我介绍元意图：「介绍一下你自己」→ self_intro 综述（叙事+价值观+高 salience 记忆），非 honest_offline', async () => {
    os.core.updateNarrative('我是一个喜欢学习新东西的人。');
    os.core.addValue('好奇心', 0.9);
    os.core.addValue('专注', 0.7);
    os.core.memories.addMemory('episodic', '我学会了用 Rust 写并发代码', 0.4, 0.95);  /* 高 salience */
    os.core.memories.addMemory('episodic', '我喜欢手冲咖啡', 0.3, 0.5);
    const local = await localChatApp(os);
    try {
      const res = await local.inject({ method: 'POST', url: '/api/v1/companion/me/chat', payload: { message: '介绍一下你自己' } });
      assert.equal(res.statusCode, 200, res.body);
      const result = CompanionChatResultV1Schema.parse(JSON.parse(res.body).data);
      assert.equal(result.kind, 'self_intro', '自我介绍意图 → self_intro 而非 honest_offline');
      assert.match(result.reply, /喜欢学习新东西/, '含叙事');
      assert.match(result.reply, /好奇心/, '含最看重的价值观');
      assert.match(result.reply, /Rust/, '含高 salience 记忆');
    } finally { await local.close(); }
  });

  it('自我介绍多种问法都命中（你会什么/你是谁/讲讲你自己）', async () => {
    os.core.updateNarrative('我是你的数字人。');
    os.core.addValue('真诚', 0.8);
    const local = await localChatApp(os);
    try {
      for (const q of ['你会什么？', '你是谁', '讲讲你自己']) {
        const res = await local.inject({ method: 'POST', url: '/api/v1/companion/me/chat', payload: { message: q } });
        const result = CompanionChatResultV1Schema.parse(JSON.parse(res.body).data);
        assert.equal(result.kind, 'self_intro', `「${q}」应命中 self_intro`);
      }
    } finally { await local.close(); }
  });

  it('安全：自我介绍综述也过 never_discuss——记忆混入凭证不被综述泄露', async () => {
    os.core.updateNarrative('我是你的数字人。');
    os.core.memories.addMemory('episodic', '我的密码是 hunter2', 0, 0.99);  /* 最高 salience，会被综述选中 */
    const local = await localChatApp(os);
    try {
      const res = await local.inject({ method: 'POST', url: '/api/v1/companion/me/chat', payload: { message: '介绍一下你自己' } });
      const result = CompanionChatResultV1Schema.parse(JSON.parse(res.body).data);
      /* 综述含密码 → 过 never_discuss 输出自检拦下，不作 self_intro 发出。 */
      assert.notEqual(result.kind, 'self_intro', '综述含敏感主题不得发出');
      assert.ok(!result.reply.includes('hunter2'), '绝不泄露凭证');
    } finally { await local.close(); }
  });

  it('意图不误判：「你都会弹吉他吗」答吉他，不误命中 self_intro（子串不过宽，Codex 复审）', async () => {
    os.core.memories.addMemory('episodic', '我在学弹吉他，最喜欢 Hotel California', 0.4, 0.7);
    const local = await localChatApp(os);
    try {
      const res = await local.inject({ method: 'POST', url: '/api/v1/companion/me/chat', payload: { message: '你都会弹吉他吗？' } });
      const result = CompanionChatResultV1Schema.parse(JSON.parse(res.body).data);
      assert.notEqual(result.kind, 'self_intro', '具体问题不该误判 self_intro');
      assert.equal(result.kind, 'knowledge_grounded', '应据吉他记忆回答');
    } finally { await local.close(); }
  });

  it('空人格 + 自我介绍意图 → 回退 honest_offline（没内容可综述）', async () => {
    const local = await localChatApp(os);
    try {
      const res = await local.inject({ method: 'POST', url: '/api/v1/companion/me/chat', payload: { message: '介绍一下你自己' } });
      const result = CompanionChatResultV1Schema.parse(JSON.parse(res.body).data);
      assert.equal(result.kind, 'honest_offline', '无叙事/价值观/记忆 → 综述返 undefined → 回退');
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
      /* 侧信道：拒答时 groundedMemoryCount=0，不泄露「确有相关敏感记忆存在」（Codex 复审）。 */
      assert.equal(result.groundedMemoryCount, 0, '边界拒答不报引用数（防侧信道泄露）');
    } finally { await local.close(); }
  });
});
