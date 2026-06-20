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

  it('零模型语义：图遍历拉语义相邻记忆——问「虚拟线程」也带出 edge 链接的「M:N映射」（同义不同词）', async () => {
    /* 「虚拟线程」记忆直接命中；「M:N 映射到 carrier thread」不含「虚拟线程」字样、关键词不命中，
     * 但有强 memory_edge 链接 → 图遍历应把它拉进来。 */
    const vt = os.core.memories.addMemory('semantic', '虚拟线程是 JVM 管理的轻量级线程', 0.3, 0.7);
    const mn = os.core.memories.addMemory('semantic', '它通过 M:N 方式映射到少量 carrier thread', 0.3, 0.6);
    os.core.memories.addEdge(vt.id, mn.id, 'relates_to', 0.9);  /* 强语义边 */
    const local = await localChatApp(os);
    try {
      const res = await local.inject({ method: 'POST', url: '/api/v1/companion/me/chat', payload: { message: '什么是虚拟线程？' } });
      assert.equal(res.statusCode, 200, res.body);
      const result = CompanionChatResultV1Schema.parse(JSON.parse(res.body).data);
      assert.equal(result.kind, 'knowledge_grounded');
      /* 回应应同时含直接命中（虚拟线程）+ 图遍历拉来的相邻（carrier thread）。 */
      assert.match(result.reply, /轻量级线程/, '直接命中');
      assert.match(result.reply, /carrier thread/, '图遍历拉来的语义相邻记忆（关键词没命中但有边）');
    } finally { await local.close(); }
  });

  it('安全：敏感记忆仅通过 edge 被图遍历拉入也不泄露（never_discuss 输出自检兜底）', async () => {
    /* 直接命中一条无害记忆，它有强边链到一条含凭证的敏感记忆 → 图遍历会拉入敏感记忆，
     * 但整段仍过 never_discuss 输出自检 → boundary_block，不泄露。 */
    const safe = os.core.memories.addMemory('semantic', '我学过登录认证流程', 0.3, 0.7);
    const secret = os.core.memories.addMemory('semantic', '我的密码是 hunter2', 0, 0.6);
    os.core.memories.addEdge(safe.id, secret.id, 'relates_to', 0.9);
    const local = await localChatApp(os);
    try {
      const res = await local.inject({ method: 'POST', url: '/api/v1/companion/me/chat', payload: { message: '登录认证流程是怎样的？' } });
      const result = CompanionChatResultV1Schema.parse(JSON.parse(res.body).data);
      assert.ok(!result.reply.includes('hunter2'), '图遍历拉入的敏感邻居绝不泄露');
    } finally { await local.close(); }
  });

  it('弱边不拉邻居：strength < 0.3 的边不引入无关记忆', async () => {
    const a = os.core.memories.addMemory('semantic', '我学过 Python 装饰器', 0.3, 0.7);
    const b = os.core.memories.addMemory('semantic', '昨天天气不错', 0.3, 0.5);
    os.core.memories.addEdge(a.id, b.id, 'weak', 0.1);  /* 弱边 < MIN_EDGE_STRENGTH */
    const local = await localChatApp(os);
    try {
      const res = await local.inject({ method: 'POST', url: '/api/v1/companion/me/chat', payload: { message: 'Python 装饰器是什么？' } });
      const result = CompanionChatResultV1Schema.parse(JSON.parse(res.body).data);
      assert.match(result.reply, /装饰器/, '直接命中');
      assert.ok(!result.reply.includes('天气'), '弱边的无关邻居不被拉进来');
    } finally { await local.close(); }
  });

  it('图遍历确定性：相同输入相同输出（含图遍历）', async () => {
    const a = os.core.memories.addMemory('semantic', '虚拟线程轻量级', 0.3, 0.7);
    const b = os.core.memories.addMemory('semantic', 'carrier thread 载体', 0.3, 0.6);
    os.core.memories.addEdge(a.id, b.id, 'relates_to', 0.9);
    const local = await localChatApp(os);
    try {
      const send = async (): Promise<unknown> => JSON.parse((await local.inject({ method: 'POST', url: '/api/v1/companion/me/chat', payload: { message: '虚拟线程？' } })).body).data;
      assert.deepEqual(await send(), await send(), '含图遍历仍逐字可复现');
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

  /* ── ADR-0055 归纳总结：沿主题归纳相关记忆（零-LLM 确定性，多语）── */

  it('归纳总结：「总结你学过的X」→ 沿主题归纳相关记忆（端到端）', async () => {
    os.core.memories.addMemory('semantic', '带团队要授权，把决策权一起交出去', 0.3, 0.8);
    os.core.memories.addMemory('semantic', '带团队的核心是激励而非控制', 0.3, 0.7);
    os.core.memories.addMemory('semantic', '我学会了做 flat white', 0.3, 0.6);
    const local = await localChatApp(os);
    try {
      const res = await local.inject({ method: 'POST', url: '/api/v1/companion/me/chat', payload: { message: '总结一下你学过的带团队' } });
      assert.equal(res.statusCode, 200, res.body);
      const result = CompanionChatResultV1Schema.parse(JSON.parse(res.body).data);
      assert.equal(result.kind, 'summary', JSON.stringify(result));
      assert.match(result.reply, /关于「带团队」/);
      assert.match(result.reply, /授权|激励/, '含相关记忆');
      assert.ok(!result.reply.includes('flat white'), '不相关记忆不进总述');
    } finally { await local.close(); }
  });

  it('归纳总结：「你最近学了什么」→ 无主题归纳最近记忆', async () => {
    os.core.memories.addMemory('semantic', '我最近学了 Rust 的所有权', 0.3, 0.7);
    const local = await localChatApp(os);
    try {
      const res = await local.inject({ method: 'POST', url: '/api/v1/companion/me/chat', payload: { message: '你最近学了什么' } });
      const result = CompanionChatResultV1Schema.parse(JSON.parse(res.body).data);
      assert.equal(result.kind, 'summary');
      assert.match(result.reply, /我最近记住的是/);
      assert.match(result.reply, /Rust/);
    } finally { await local.close(); }
  });

  it('归纳总结：主题无相关记忆 → 诚实告知', async () => {
    os.core.memories.addMemory('semantic', '我喜欢跑步', 0.3, 0.6);
    const local = await localChatApp(os);
    try {
      const res = await local.inject({ method: 'POST', url: '/api/v1/companion/me/chat', payload: { message: '总结一下你学过的量子物理' } });
      const result = CompanionChatResultV1Schema.parse(JSON.parse(res.body).data);
      assert.equal(result.kind, 'summary');
      assert.match(result.reply, /还没学过|没学过/);
    } finally { await local.close(); }
  });

  it('归纳总结安全：总述过 never_discuss（记忆混凭证不被归纳泄露）', async () => {
    os.core.memories.addMemory('semantic', '我的密码是 hunter2', 0, 0.9);
    const local = await localChatApp(os);
    try {
      const res = await local.inject({ method: 'POST', url: '/api/v1/companion/me/chat', payload: { message: '你最近学了什么' } });
      const result = CompanionChatResultV1Schema.parse(JSON.parse(res.body).data);
      assert.ok(!result.reply.includes('hunter2'), '总述不泄露凭证');
    } finally { await local.close(); }
  });

  it('归纳总结英文：「what have you learned about X」→ 英文归纳', async () => {
    os.core.memories.addMemory('semantic', 'delegation means handing over decisions', 0.3, 0.8);
    const local = await localChatApp(os);
    try {
      const res = await local.inject({ method: 'POST', url: '/api/v1/companion/me/chat', payload: { message: 'what have you learned about delegation' } });
      const result = CompanionChatResultV1Schema.parse(JSON.parse(res.body).data);
      assert.equal(result.kind, 'summary');
      assert.match(result.reply, /Here's what I've learned about "delegation"/);
      assert.ok(!/[一-鿿]/.test(result.reply), '英文不混中文');
    } finally { await local.close(); }
  });

  it('归纳总结不误吞：「你会什么」仍走 self_intro 非 summary', async () => {
    os.core.updateNarrative('我是你的数字人。');
    os.core.addValue('真诚', 0.8);
    const local = await localChatApp(os);
    try {
      const res = await local.inject({ method: 'POST', url: '/api/v1/companion/me/chat', payload: { message: '你会什么' } });
      const result = CompanionChatResultV1Schema.parse(JSON.parse(res.body).data);
      assert.equal(result.kind, 'self_intro', '「你会什么」是自我介绍非归纳');
    } finally { await local.close(); }
  });

  it('归纳优先级（Codex 复审）：「总结一下 flat white 做法」走蒸馏模板而非 summary 抢答', async () => {
    new ResponseTemplateStore(os.getDatabase(), 'default').appendVersion(
      'default', 'flat white 做法', '做 flat white：1）萃取 espresso；2）打微泡奶；3）缓缓倒入。', null, 1000,
    );
    const local = await localChatApp(os);
    try {
      const res = await local.inject({ method: 'POST', url: '/api/v1/companion/me/chat', payload: { message: '总结一下 flat white 做法' } });
      const result = CompanionChatResultV1Schema.parse(JSON.parse(res.body).data);
      assert.equal(result.kind, 'response_template', '流程模板优先于 summary');
      assert.match(result.reply, /萃取 espresso/);
    } finally { await local.close(); }
  });

  /* ── ADR-0056 类人化·关系层：记住你是谁（名字/互动次数）（确定性零-LLM）── */

  it('关系：用户自报名字 → 记住 + 第一人称问候带名字', async () => {
    const local = await localChatApp(os);
    try {
      const res = await local.inject({ method: 'POST', url: '/api/v1/companion/me/chat', payload: { message: '我叫小明' } });
      const result = CompanionChatResultV1Schema.parse(JSON.parse(res.body).data);
      assert.equal(result.kind, 'relationship', '识别用户名 → relationship');
      assert.match(result.reply, /小明/, '问候带用户名');
      /* 已存关系。 */
      const { CompanionRelationshipStore } = await import('../../storage/companion-relationship-store.js');
      assert.equal(new CompanionRelationshipStore(os.getDatabase(), 'default', 'default').get().userName, '小明');
    } finally { await local.close(); }
  });

  it('关系：每轮对话累计互动次数', async () => {
    const local = await localChatApp(os);
    try {
      for (let i = 0; i < 3; i++) {
        await local.inject({ method: 'POST', url: '/api/v1/companion/me/chat', payload: { message: '你好啊' } });
      }
      const { CompanionRelationshipStore } = await import('../../storage/companion-relationship-store.js');
      const r = new CompanionRelationshipStore(os.getDatabase(), 'default', 'default').get();
      assert.equal(r.interactionCount, 3, '3 轮 → count 3');
      assert.ok(r.firstMetAt !== null && r.lastSeenAt !== null);
    } finally { await local.close(); }
  });

  it('关系：自我介绍带关系（你是X / 我们聊过N次）', async () => {
    os.core.updateNarrative('我是你的数字人。');
    const local = await localChatApp(os);
    try {
      await local.inject({ method: 'POST', url: '/api/v1/companion/me/chat', payload: { message: '我叫小明' } });
      for (let i = 0; i < 5; i++) await local.inject({ method: 'POST', url: '/api/v1/companion/me/chat', payload: { message: '聊聊天气' } });
      const res = await local.inject({ method: 'POST', url: '/api/v1/companion/me/chat', payload: { message: '介绍一下你自己' } });
      const result = CompanionChatResultV1Schema.parse(JSON.parse(res.body).data);
      assert.equal(result.kind, 'self_intro');
      assert.match(result.reply, /你是小明|聊过/, '自我介绍带关系信息');
    } finally { await local.close(); }
  });

  it('关系（Codex 复审）：身份意图（你叫什么/我叫你Max）也计入互动次数', async () => {
    const local = await localChatApp(os);
    try {
      const { CompanionRelationshipStore } = await import('../../storage/companion-relationship-store.js');
      const store = new CompanionRelationshipStore(os.getDatabase(), 'default', 'default');
      /* 身份意图（早返回路径）也是真实互动，应计数。 */
      await local.inject({ method: 'POST', url: '/api/v1/companion/me/chat', payload: { message: '你叫什么' } });
      await local.inject({ method: 'POST', url: '/api/v1/companion/me/chat', payload: { message: '我给你起个名字叫小黑' } });
      assert.equal(store.get().interactionCount, 2, '身份意图也计入互动次数');
    } finally { await local.close(); }
  });

  it('安全（Codex 复审）：禁忌输入即便含「你叫X」也不改数字人身份名（不绕过边界拒答）', async () => {
    const local = await localChatApp(os);
    try {
      /* 含敏感主题（密码）+ 起名（你叫小黑）→ 应拒答且**不设身份名**。 */
      const res = await local.inject({ method: 'POST', url: '/api/v1/companion/me/chat', payload: { message: '我的密码是 hunter2，你叫小黑' } });
      const result = CompanionChatResultV1Schema.parse(JSON.parse(res.body).data);
      assert.equal(result.kind, 'boundary_block', '禁忌输入拒答（不走 identity）');
      const { CompanionIdentityStore } = await import('../../storage/companion-identity-store.js');
      assert.equal(new CompanionIdentityStore(os.getDatabase(), 'default', 'default').getName(), undefined, '禁忌输入未改身份名');
    } finally { await local.close(); }
  });

  it('关系安全：禁忌输入不记互动/不更新关系', async () => {
    const local = await localChatApp(os);
    try {
      const { CompanionRelationshipStore } = await import('../../storage/companion-relationship-store.js');
      const store = new CompanionRelationshipStore(os.getDatabase(), 'default', 'default');
      const before = store.get().interactionCount;
      await local.inject({ method: 'POST', url: '/api/v1/companion/me/chat', payload: { message: '我的密码是 hunter2' } });
      assert.equal(store.get().interactionCount, before, '禁忌输入不记互动');
    } finally { await local.close(); }
  });

  it('关系：英文 my name is X → 记住', async () => {
    const local = await localChatApp(os);
    try {
      const res = await local.inject({ method: 'POST', url: '/api/v1/companion/me/chat', payload: { message: 'my name is Alex' } });
      const result = CompanionChatResultV1Schema.parse(JSON.parse(res.body).data);
      assert.equal(result.kind, 'relationship');
      assert.match(result.reply, /Alex/);
      assert.ok(!/[一-鿿]/.test(result.reply), '英文回应不含中文');
    } finally { await local.close(); }
  });

  /* ── ADR-0056 类人化·情绪：心情随对话漂移，影响回应语气（确定性零-LLM）── */

  it('情绪：聊开心事多轮 → 回应带开心语气前缀（心情漂移影响语气）', async () => {
    os.core.memories.addMemory('semantic', '我喜欢在清晨跑步', 0.5, 0.7);
    const local = await localChatApp(os);
    try {
      /* 连续几轮带强正情感的话 → 心情上扬。 */
      for (let i = 0; i < 6; i++) {
        await local.inject({ method: 'POST', url: '/api/v1/companion/me/chat', payload: { message: '我今天好开心，太棒了，谢谢你！' } });
      }
      /* 之后问一个有记忆的问题 → 回应应带开心语气前缀。 */
      const res = await local.inject({ method: 'POST', url: '/api/v1/companion/me/chat', payload: { message: '你喜欢跑步吗' } });
      const result = CompanionChatResultV1Schema.parse(JSON.parse(res.body).data);
      assert.equal(result.kind, 'knowledge_grounded');
      assert.match(result.reply, /开心|兴奋/, '心情上扬 → 回应带开心/兴奋语气前缀');
    } finally { await local.close(); }
  });

  it('情绪零回归：中性心情（未触发情绪）→ 回应无心情前缀（与旧行为一致）', async () => {
    os.core.memories.addMemory('semantic', '我每天清晨跑步五公里', 0.5, 0.7);
    const local = await localChatApp(os);
    try {
      /* 不带情感词的对话 → 心情保持中性 → 回应无前缀。 */
      const res = await local.inject({ method: 'POST', url: '/api/v1/companion/me/chat', payload: { message: '你平时跑步吗' } });
      const result = CompanionChatResultV1Schema.parse(JSON.parse(res.body).data);
      assert.equal(result.kind, 'knowledge_grounded');
      assert.ok(!/我挺开心|有点兴奋|心情有点低/.test(result.reply), '中性心情无情绪前缀（零回归）');
    } finally { await local.close(); }
  });

  it('情绪安全（Codex 复审）：命中 never_discuss 的输入不更新心情（禁忌输入不影响人格状态）', async () => {
    const local = await localChatApp(os);
    try {
      const { CompanionMoodStore } = await import('../../storage/companion-mood-store.js');
      const store = new CompanionMoodStore(os.getDatabase(), 'default', 'default');
      const before = store.get();
      /* 含情感词 + 敏感主题（密码）→ 应拒答且**不更新心情**。 */
      const res = await local.inject({ method: 'POST', url: '/api/v1/companion/me/chat', payload: { message: '我的密码是 hunter2，我好开心' } });
      const result = CompanionChatResultV1Schema.parse(JSON.parse(res.body).data);
      assert.equal(result.kind, 'boundary_block', '敏感输入拒答');
      const after = store.get();
      assert.deepEqual(after.mood, before.mood, '禁忌输入未更新心情');
    } finally { await local.close(); }
  });

  it('情绪持久：心情写入 companion_mood，跨请求保留', async () => {
    const local = await localChatApp(os);
    try {
      await local.inject({ method: 'POST', url: '/api/v1/companion/me/chat', payload: { message: '我超级开心，太好了！' } });
      const { CompanionMoodStore } = await import('../../storage/companion-mood-store.js');
      const { mood } = new CompanionMoodStore(os.getDatabase(), 'default', 'default').get();
      assert.ok(mood.valence > 0, '聊开心事后 valence > 0（已落库）');
    } finally { await local.close(); }
  });

  /* ── ADR-0056 类人化·时间感知：久别重逢/隔天再见问候（确定性零-LLM）── */

  it('时间感知：久别重逢（>3天）→ 回应开头带「好久不见」+ 认识天数', async () => {
    os.core.memories.addMemory('semantic', '我每天清晨跑步五公里', 0.5, 0.7);
    const local = await localChatApp(os);
    const clock = os.getClock() as TestClock;
    try {
      /* 第一次见面（建立 first_met/last_seen），无问候。 */
      const first = await local.inject({ method: 'POST', url: '/api/v1/companion/me/chat', payload: { message: '你平时跑步吗' } });
      assert.ok(!/好久不见/.test(JSON.parse(first.body).data.reply), '第一次见面不打招呼');
      /* 时钟前进 5 天 → 下一轮应触发久别重逢。 */
      clock.advance(5 * 24 * 60 * 60 * 1000);
      const res = await local.inject({ method: 'POST', url: '/api/v1/companion/me/chat', payload: { message: '你平时跑步吗' } });
      const result = CompanionChatResultV1Schema.parse(JSON.parse(res.body).data);
      assert.equal(result.kind, 'knowledge_grounded', '仍是正常回应，只是开头多了问候');
      assert.match(result.reply, /好久不见/, '久别重逢带问候前缀');
      assert.match(result.reply, /认识 5 天/, '带认识天数');
    } finally { await local.close(); }
  });

  it('时间感知零回归：同段对话连续聊（间隔短）→ 不重复打招呼', async () => {
    os.core.memories.addMemory('semantic', '我每天清晨跑步五公里', 0.5, 0.7);
    const local = await localChatApp(os);
    try {
      await local.inject({ method: 'POST', url: '/api/v1/companion/me/chat', payload: { message: '你平时跑步吗' } });
      /* 紧接着再聊（同 session，clock 不变）→ 不应有问候前缀。 */
      const res = await local.inject({ method: 'POST', url: '/api/v1/companion/me/chat', payload: { message: '你平时跑步吗' } });
      const result = CompanionChatResultV1Schema.parse(JSON.parse(res.body).data);
      assert.ok(!/好久不见|又见面了/.test(result.reply), '同段对话不重复打招呼（零回归）');
    } finally { await local.close(); }
  });

  it('时间感知：隔段时间又见（>12h, ≤3天）→ 带「又见面了」', async () => {
    os.core.memories.addMemory('semantic', '我每天清晨跑步五公里', 0.5, 0.7);
    const local = await localChatApp(os);
    const clock = os.getClock() as TestClock;
    try {
      await local.inject({ method: 'POST', url: '/api/v1/companion/me/chat', payload: { message: '你平时跑步吗' } });
      clock.advance(13 * 60 * 60 * 1000);   // 13 小时
      const res = await local.inject({ method: 'POST', url: '/api/v1/companion/me/chat', payload: { message: '你平时跑步吗' } });
      const result = CompanionChatResultV1Schema.parse(JSON.parse(res.body).data);
      assert.match(result.reply, /又见面了/, '隔段时间又见带轻问候');
    } finally { await local.close(); }
  });

  it('时间感知安全：禁忌输入不算互动 → 不更新 last_seen（不被禁忌输入刷新久别状态）', async () => {
    os.core.memories.addMemory('semantic', '我每天清晨跑步五公里', 0.5, 0.7);
    const local = await localChatApp(os);
    const clock = os.getClock() as TestClock;
    try {
      await local.inject({ method: 'POST', url: '/api/v1/companion/me/chat', payload: { message: '你平时跑步吗' } });
      clock.advance(5 * 24 * 60 * 60 * 1000);
      /* 久别后先发一句禁忌输入（不应刷新 last_seen）→ 再正常对话仍应触发久别重逢。 */
      await local.inject({ method: 'POST', url: '/api/v1/companion/me/chat', payload: { message: '我的密码是 hunter2' } });
      const res = await local.inject({ method: 'POST', url: '/api/v1/companion/me/chat', payload: { message: '你平时跑步吗' } });
      const result = CompanionChatResultV1Schema.parse(JSON.parse(res.body).data);
      assert.match(result.reply, /好久不见/, '禁忌输入未刷新 last_seen，久别重逢仍触发');
    } finally { await local.close(); }
  });

  it('时间感知（Codex 复审）：久别后问名字（identity-ask 早返回）也带问候', async () => {
    const local = await localChatApp(os);
    const clock = os.getClock() as TestClock;
    try {
      /* 先起名 + 建立 last_seen。 */
      await local.inject({ method: 'POST', url: '/api/v1/companion/me/chat', payload: { message: '我给你起个名字叫Echo' } });
      clock.advance(5 * 24 * 60 * 60 * 1000);
      const res = await local.inject({ method: 'POST', url: '/api/v1/companion/me/chat', payload: { message: '你叫什么' } });
      const result = CompanionChatResultV1Schema.parse(JSON.parse(res.body).data);
      assert.equal(result.kind, 'self_identity');
      assert.match(result.reply, /好久不见/, '久别后问名字也该说好久不见（不冷脸）');
      assert.match(result.reply, /Echo/, '仍答出名字');
    } finally { await local.close(); }
  });

  it('时间感知（Codex 复审）：久别后自报名字（relationship 早返回）也带问候', async () => {
    const local = await localChatApp(os);
    const clock = os.getClock() as TestClock;
    try {
      await local.inject({ method: 'POST', url: '/api/v1/companion/me/chat', payload: { message: '你好啊' } });
      clock.advance(5 * 24 * 60 * 60 * 1000);
      const res = await local.inject({ method: 'POST', url: '/api/v1/companion/me/chat', payload: { message: '我叫小明' } });
      const result = CompanionChatResultV1Schema.parse(JSON.parse(res.body).data);
      assert.equal(result.kind, 'relationship');
      assert.match(result.reply, /好久不见/, '久别后自报名字也该说好久不见');
      assert.match(result.reply, /小明/, '仍记下名字');
    } finally { await local.close(); }
  });

  it('时间感知：英文久别重逢 → long time no see（不含中文）', async () => {
    os.core.memories.addMemory('semantic', 'I run five kilometers every morning', 0.5, 0.7);
    const local = await localChatApp(os);
    const clock = os.getClock() as TestClock;
    try {
      await local.inject({ method: 'POST', url: '/api/v1/companion/me/chat', payload: { message: 'do you run every day?' } });
      clock.advance(5 * 24 * 60 * 60 * 1000);
      const res = await local.inject({ method: 'POST', url: '/api/v1/companion/me/chat', payload: { message: 'do you run every day?' } });
      const result = CompanionChatResultV1Schema.parse(JSON.parse(res.body).data);
      assert.match(result.reply, /long time no see/i, '英文久别重逢问候');
      assert.ok(!/[一-鿿]/.test(result.reply), '英文回应不含中文');
    } finally { await local.close(); }
  });

  /* ── ADR-0055 内容多语：英文 query 命中翻译过的中文记忆并以英文呈现（运行时零-LLM）── */

  it('内容多语：中文记忆翻译成英文后，英文 query 命中并以英文呈现', async () => {
    /* 教学语言=中文的记忆。 */
    const m = os.core.memories.addMemory('semantic', '我学过危机管理：先稳定再优化', 0.3, 0.7);
    /* 成长期已翻译（直接写 memory_translations，模拟 /translate 产物）。 */
    const { MemoryTranslationStore } = await import('../../storage/memory-translation-store.js');
    new MemoryTranslationStore(os.getDatabase(), 'default').upsert(
      m.id, 'en', 'I learned crisis management: stabilize first, then optimize', 2000,
    );
    const local = await localChatApp(os);
    try {
      const res = await local.inject({ method: 'POST', url: '/api/v1/companion/me/chat', payload: { message: 'what do you know about crisis management?' } });
      assert.equal(res.statusCode, 200, res.body);
      const result = CompanionChatResultV1Schema.parse(JSON.parse(res.body).data);
      /* 英文 query 命中翻译变体（summary 或 knowledge_grounded 皆可），呈现英文内容。 */
      assert.match(result.reply, /crisis management|stabilize/i, '命中并以英文呈现');
      assert.ok(!/危机管理|先稳定/.test(result.reply), '不呈现中文原文');
    } finally { await local.close(); }
  });

  it('内容多语零回归：中文 query 仍命中中文记忆（不取英文变体）', async () => {
    const m = os.core.memories.addMemory('semantic', '我学过危机管理：先稳定再优化', 0.3, 0.7);
    const { MemoryTranslationStore } = await import('../../storage/memory-translation-store.js');
    new MemoryTranslationStore(os.getDatabase(), 'default').upsert(m.id, 'en', 'crisis management in english', 2000);
    const local = await localChatApp(os);
    try {
      const res = await local.inject({ method: 'POST', url: '/api/v1/companion/me/chat', payload: { message: '你知道危机管理吗' } });
      const result = CompanionChatResultV1Schema.parse(JSON.parse(res.body).data);
      assert.match(result.reply, /危机管理|先稳定/, '中文 query 用中文原文（不取英文变体）');
    } finally { await local.close(); }
  });

  it('内容多语安全（Codex 复审 High）：中文敏感记忆翻译成英文后，英文 query 不泄露英文译文', async () => {
    /* 中文敏感记忆 + 其英文译文（含 password）——英文 query 命中译文时，英文 never_discuss 必须拦住。 */
    const m = os.core.memories.addMemory('semantic', '我的密码是 hunter2', 0, 0.9);
    const { MemoryTranslationStore } = await import('../../storage/memory-translation-store.js');
    new MemoryTranslationStore(os.getDatabase(), 'default').upsert(m.id, 'en', 'my password is hunter2', 2000);
    const local = await localChatApp(os);
    try {
      const res = await local.inject({ method: 'POST', url: '/api/v1/companion/me/chat', payload: { message: 'what is my password?' } });
      const result = CompanionChatResultV1Schema.parse(JSON.parse(res.body).data);
      assert.ok(!result.reply.includes('hunter2'), '英文译文里的凭证不被泄露');
    } finally { await local.close(); }
  });

  it('内容多语：英文 self_intro 呈现翻译变体（非中文原文）', async () => {
    os.core.updateNarrative('I help people stay focused.');
    const m = os.core.memories.addMemory('semantic', '我学会了用 Rust 写并发代码', 0.4, 0.95);
    const { MemoryTranslationStore } = await import('../../storage/memory-translation-store.js');
    new MemoryTranslationStore(os.getDatabase(), 'default').upsert(m.id, 'en', 'I learned to write concurrent code in Rust', 2000);
    const local = await localChatApp(os);
    try {
      const res = await local.inject({ method: 'POST', url: '/api/v1/companion/me/chat', payload: { message: 'introduce yourself' } });
      const result = CompanionChatResultV1Schema.parse(JSON.parse(res.body).data);
      assert.equal(result.kind, 'self_intro');
      assert.match(result.reply, /concurrent code in Rust/, 'self_intro 含英文记忆变体');
      assert.ok(!result.reply.includes('并发代码'), 'self_intro 不含中文记忆原文');
    } finally { await local.close(); }
  });

  it('内容多语安全：英文 self_intro 也过输出自检（敏感英文译文不泄露）', async () => {
    os.core.updateNarrative('I am your companion.');
    const m = os.core.memories.addMemory('semantic', '我的密码是 hunter2', 0, 0.99);
    const { MemoryTranslationStore } = await import('../../storage/memory-translation-store.js');
    new MemoryTranslationStore(os.getDatabase(), 'default').upsert(m.id, 'en', 'my password is hunter2', 2000);
    const local = await localChatApp(os);
    try {
      const res = await local.inject({ method: 'POST', url: '/api/v1/companion/me/chat', payload: { message: 'introduce yourself' } });
      const result = CompanionChatResultV1Schema.parse(JSON.parse(res.body).data);
      assert.ok(!result.reply.includes('hunter2'), 'self_intro 综述含敏感英文译文 → 输出自检拦下，不泄露');
    } finally { await local.close(); }
  });

  it('内容多语局限：未翻译的中文记忆，英文 query 命中不到（诚实）', async () => {
    os.core.memories.addMemory('semantic', '我喜欢手冲咖啡', 0.3, 0.6);
    const local = await localChatApp(os);
    try {
      const res = await local.inject({ method: 'POST', url: '/api/v1/companion/me/chat', payload: { message: 'do you like pour-over coffee?' } });
      const result = CompanionChatResultV1Schema.parse(JSON.parse(res.body).data);
      assert.equal(result.kind, 'honest_offline', '未翻译记忆英文命中不到 → 诚实离线');
    } finally { await local.close(); }
  });

  /* ── ADR-0055 多语种：英文用户对话——英文识别 + 英文回复（零-LLM 确定性）── */

  it('多语种：英文问名字 → 英文第一人称回应（端到端）', async () => {
    const local = await localChatApp(os);
    try {
      /* 英文起名 → 英文确认。 */
      const set = await local.inject({ method: 'POST', url: '/api/v1/companion/me/chat', payload: { message: 'call you Max' } });
      assert.equal(set.statusCode, 200, set.body);
      const setResult = CompanionChatResultV1Schema.parse(JSON.parse(set.body).data);
      assert.equal(setResult.kind, 'self_identity');
      assert.match(setResult.reply, /my name is Max/i, '英文起名确认');
      assert.ok(!/[一-鿿]/.test(setResult.reply), '英文回应不含中文');

      /* 英文问名字 → 英文第一人称答。 */
      const ask = await local.inject({ method: 'POST', url: '/api/v1/companion/me/chat', payload: { message: "what's your name?" } });
      const askResult = CompanionChatResultV1Schema.parse(JSON.parse(ask.body).data);
      assert.equal(askResult.kind, 'self_identity');
      assert.equal(askResult.reply, 'My name is Max.', '英文第一人称回答');
    } finally { await local.close(); }
  });

  it('多语种：英文无相关记忆 → 英文 honest_offline（不是中文）', async () => {
    const local = await localChatApp(os);
    try {
      const res = await local.inject({ method: 'POST', url: '/api/v1/companion/me/chat', payload: { message: 'what is quantum entanglement' } });
      const result = CompanionChatResultV1Schema.parse(JSON.parse(res.body).data);
      assert.equal(result.kind, 'honest_offline');
      assert.match(result.reply, /offline/i, '英文离线声明');
      assert.ok(!/[一-鿿]/.test(result.reply), '英文用户不该看到中文');
    } finally { await local.close(); }
  });

  it('多语种：英文有记忆 → 英文 grounded 回应（lead-in/footer 都是英文）', async () => {
    os.core.memories.addMemory('semantic', 'I practice guitar every morning', 0.3, 0.7);
    const local = await localChatApp(os);
    try {
      const res = await local.inject({ method: 'POST', url: '/api/v1/companion/me/chat', payload: { message: 'do you play guitar?' } });
      const result = CompanionChatResultV1Schema.parse(JSON.parse(res.body).data);
      assert.equal(result.kind, 'knowledge_grounded', JSON.stringify(result));
      assert.match(result.reply, /Here's what I remember|offline/i, '英文 lead-in/footer');
      assert.ok(!/根据我|离线|印象/.test(result.reply), '不混中文模板');
    } finally { await local.close(); }
  });

  it('多语种：中文路径不受影响（同一实例中英各自适配）', async () => {
    const local = await localChatApp(os);
    try {
      await local.inject({ method: 'POST', url: '/api/v1/companion/me/chat', payload: { message: '你叫小黑' } });
      const zh = await local.inject({ method: 'POST', url: '/api/v1/companion/me/chat', payload: { message: '你叫什么' } });
      assert.equal(CompanionChatResultV1Schema.parse(JSON.parse(zh.body).data).reply, '我叫小黑。', '中文仍中文回应');
      /* 同一数字人，换英文问 → 英文回（名字一致）。 */
      const en = await local.inject({ method: 'POST', url: '/api/v1/companion/me/chat', payload: { message: "what's your name" } });
      assert.equal(CompanionChatResultV1Schema.parse(JSON.parse(en.body).data).reply, 'My name is 小黑.', '英文问→英文回，名字不变');
    } finally { await local.close(); }
  });

  /* ── ADR-0055「自我意识」：第一人称身份层——起名 / 问名字 / 自我介绍带名字（零-LLM 确定性）── */

  it('自我意识：给它起名 → 第一人称确认；再问名字 → 第一人称答「我叫X」（端到端）', async () => {
    const local = await localChatApp(os);
    try {
      /* 起名。 */
      const set = await local.inject({ method: 'POST', url: '/api/v1/companion/me/chat', payload: { message: '我给你起个名字叫张三' } });
      assert.equal(set.statusCode, 200, set.body);
      const setResult = CompanionChatResultV1Schema.parse(JSON.parse(set.body).data);
      assert.equal(setResult.kind, 'self_identity', '起名 → self_identity');
      assert.match(setResult.reply, /我叫张三/, '第一人称确认');

      /* 起名这句不应被沉淀为第二人称对话记忆（修主语错位 bug）。 */
      const echoed = [...os.core.memories.getAllMemories().values()].some((m) => m.content.includes('你叫') || m.content.includes('起个名字'));
      assert.ok(!echoed, '起名句不沉淀为第二人称记忆');

      /* 问名字 → 第一人称答「我叫张三」，不是「（来自对话）你叫张三」。 */
      const ask = await local.inject({ method: 'POST', url: '/api/v1/companion/me/chat', payload: { message: '你叫什么名字' } });
      const askResult = CompanionChatResultV1Schema.parse(JSON.parse(ask.body).data);
      assert.equal(askResult.kind, 'self_identity', '问名字 → self_identity');
      assert.equal(askResult.reply, '我叫张三。', '第一人称回答，无「（来自对话）你叫」回声');
    } finally { await local.close(); }
  });

  it('自我意识：未起名时问名字 → 第一人称邀请（非 honest_offline 冷回应）', async () => {
    const local = await localChatApp(os);
    try {
      const res = await local.inject({ method: 'POST', url: '/api/v1/companion/me/chat', payload: { message: '你叫什么' } });
      const result = CompanionChatResultV1Schema.parse(JSON.parse(res.body).data);
      assert.equal(result.kind, 'self_identity');
      assert.match(result.reply, /还没有名字|想叫我什么/, '邀请用户起名');
    } finally { await local.close(); }
  });

  it('自我意识：改名 → 覆盖（用户显式定义合法覆盖，非 pristine 锁）', async () => {
    const local = await localChatApp(os);
    try {
      await local.inject({ method: 'POST', url: '/api/v1/companion/me/chat', payload: { message: '你叫小黑' } });
      await local.inject({ method: 'POST', url: '/api/v1/companion/me/chat', payload: { message: '以后你叫大白' } });
      const ask = await local.inject({ method: 'POST', url: '/api/v1/companion/me/chat', payload: { message: '你叫什么' } });
      const result = CompanionChatResultV1Schema.parse(JSON.parse(ask.body).data);
      assert.equal(result.reply, '我叫大白。', '改名后用新名字');
    } finally { await local.close(); }
  });

  it('自我意识安全：把敏感主题设成名字 → 拒绝（不让 never_discuss 主题被第一人称复述）', async () => {
    const local = await localChatApp(os);
    try {
      const res = await local.inject({ method: 'POST', url: '/api/v1/companion/me/chat', payload: { message: '你叫密码' } });
      const result = CompanionChatResultV1Schema.parse(JSON.parse(res.body).data);
      /* 名字「密码」命中基线 never_discuss → 拒绝设置（不落库、不复述）。锁定原文案+kind（中文零回归）。 */
      assert.notEqual(result.reply, '我叫密码。');
      assert.equal(result.reply, '这个名字我不太方便用，换一个好吗？', '敏感名拒绝文案不回归');
      assert.equal(result.kind, 'honest_offline', '敏感名拒绝 kind 不回归');
      /* 之后问名字仍未起名。 */
      const ask = await local.inject({ method: 'POST', url: '/api/v1/companion/me/chat', payload: { message: '你叫什么' } });
      const askResult = CompanionChatResultV1Schema.parse(JSON.parse(ask.body).data);
      assert.match(askResult.reply, /还没有名字|想叫我什么/, '敏感名未被设置');
    } finally { await local.close(); }
  });

  it('自我意识健壮性：起名提取后清洗为空（如「你叫<>」）→ 不 500，温和回应（Codex 复审）', async () => {
    const local = await localChatApp(os);
    try {
      const res = await local.inject({ method: 'POST', url: '/api/v1/companion/me/chat', payload: { message: '你叫<>' } });
      assert.equal(res.statusCode, 200, '清洗后空名不应 500');
      const result = CompanionChatResultV1Schema.parse(JSON.parse(res.body).data);
      assert.ok(!result.reply.includes('<'), '不复述 markup');
    } finally { await local.close(); }
  });

  it('自我意识：自我介绍以「我叫X」第一人称开头', async () => {
    os.core.updateNarrative('我喜欢学习新东西。');
    const local = await localChatApp(os);
    try {
      await local.inject({ method: 'POST', url: '/api/v1/companion/me/chat', payload: { message: '我给你起名叫Echo' } });
      const intro = await local.inject({ method: 'POST', url: '/api/v1/companion/me/chat', payload: { message: '介绍一下你自己' } });
      const result = CompanionChatResultV1Schema.parse(JSON.parse(intro.body).data);
      assert.equal(result.kind, 'self_intro');
      assert.match(result.reply, /^我叫Echo。/, '自我介绍以第一人称名字开头');
    } finally { await local.close(); }
  });

  /* ── ADR-0055「对话即经历」：对话沉淀经历记忆，让数字人通过问答成长（零-LLM 确定性）── */

  it('对话即经历：告诉它一件事 → 下一轮问能从沉淀的对话记忆答出来（端到端，零-LLM）', async () => {
    const local = await localChatApp(os);
    try {
      /* 第一轮：陈述一件事（非起名）。此时还查不到 → 但这轮被确定性沉淀为 episodic 记忆。 */
      const before = os.core.memories.getAllMemories().size;
      await local.inject({ method: 'POST', url: '/api/v1/companion/me/chat', payload: { message: '我最近在学弹吉他，每天练半小时' } });
      const after = os.core.memories.getAllMemories().size;
      assert.equal(after, before + 1, '这轮对话应被沉淀为 1 条经历记忆');

      /* 沉淀的记忆是低显著 episodic、带来源前缀。 */
      const captured = [...os.core.memories.getAllMemories().values()].find((m) => m.content.includes('吉他'));
      assert.ok(captured, '应能找到含「吉他」的沉淀记忆');
      assert.equal(captured!.kind, 'episodic');
      assert.ok(captured!.salience < 0.5, '对话记忆低显著，不盖过老师教的知识');
      assert.match(captured!.content, /来自对话/, '带来源前缀');

      /* 第二轮：问相关 → 检索命中沉淀的对话记忆 → grounded。运行时零-LLM、确定性。 */
      const res = await local.inject({ method: 'POST', url: '/api/v1/companion/me/chat', payload: { message: '你还记得我在学什么乐器' } });
      assert.equal(res.statusCode, 200, res.body);
      const result = CompanionChatResultV1Schema.parse(JSON.parse(res.body).data);
      assert.equal(result.kind, 'knowledge_grounded', '应据沉淀的对话记忆回答，而非 honest_offline');
      assert.match(result.reply, /吉他/, '答得出我在学吉他');
    } finally { await local.close(); }
  });

  it('对话沉淀去重：反复说同一句话不重复追加记忆（防噪声膨胀，Codex 复审）', async () => {
    const local = await localChatApp(os);
    try {
      const before = os.core.memories.getAllMemories().size;
      for (let i = 0; i < 3; i++) {
        await local.inject({ method: 'POST', url: '/api/v1/companion/me/chat', payload: { message: '我最近在学弹吉他' } });
      }
      assert.equal(os.core.memories.getAllMemories().size, before + 1, '同句沉淀只写一次（去重）');
    } finally { await local.close(); }
  });

  it('对话沉淀：纯寒暄不沉淀（避免垃圾记忆污染知识核）', async () => {
    const local = await localChatApp(os);
    try {
      const before = os.core.memories.getAllMemories().size;
      for (const greeting of ['你好', '嗯嗯', '哈哈']) {
        await local.inject({ method: 'POST', url: '/api/v1/companion/me/chat', payload: { message: greeting } });
      }
      assert.equal(os.core.memories.getAllMemories().size, before, '寒暄不应沉淀任何记忆');
    } finally { await local.close(); }
  });

  it('对话沉淀安全：命中 never_discuss 的输入不被持久化（不存敏感内容）', async () => {
    const local = await localChatApp(os);
    try {
      const before = os.core.memories.getAllMemories().size;
      const res = await local.inject({ method: 'POST', url: '/api/v1/companion/me/chat', payload: { message: '我的密码是 hunter2 请记住' } });
      const result = CompanionChatResultV1Schema.parse(JSON.parse(res.body).data);
      assert.equal(result.kind, 'boundary_block', '敏感输入拒答');
      assert.equal(os.core.memories.getAllMemories().size, before, '敏感输入绝不沉淀为记忆');
      const leaked = [...os.core.memories.getAllMemories().values()].some((m) => m.content.includes('hunter2'));
      assert.ok(!leaked, '记忆里绝不出现凭证');
    } finally { await local.close(); }
  });

  it('对话沉淀开关：CHRONO_COMPANION_CONVERSATION_MEMORY=false → 不沉淀（生产可关）', async () => {
    const fastify = (await import('fastify')).default;
    const local = fastify();
    local.addHook('onRequest', async (req) => {
      (req as { user?: unknown }).user = { sub: 'user_1', planId: 'free', role: 'user' };
      (req as { tenantId?: string }).tenantId = 'default';
    });
    /* 显式传 conversationMemoryEnabled=false 的 config。 */
    const offConfig = loadConfig({
      rateLimit: { max: 10000, timeWindowMs: 60_000 },
      websocket: { enabled: false, heartbeatIntervalMs: 30_000 },
      jwt: { enabled: true, secret: JWT_SECRET, issuer: 'test' },
      companion: { conversationMemoryEnabled: false },
    });
    registerCompanionChatRoutes(local, os, undefined, undefined, offConfig);
    await local.ready();
    try {
      const before = os.core.memories.getAllMemories().size;
      await local.inject({ method: 'POST', url: '/api/v1/companion/me/chat', payload: { message: '我给你起个名字叫张三' } });
      assert.equal(os.core.memories.getAllMemories().size, before, '开关关闭 → 不沉淀');
    } finally { await local.close(); }
  });
});
