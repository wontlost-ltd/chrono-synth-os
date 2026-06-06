/**
 * 单元测试：ConversationService 生产级流水线（P1-C 加固后）
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ChronoSynthOS } from '../../chrono-synth-os.js';
import { SilentLogger } from '../../utils/logger.js';
import { TestClock } from '../../utils/clock.js';
import { PersonaCoreService } from '../../persona-core/persona-core-service.js';
import {
  ConversationService,
  PersonaNotFoundForConversationError,
  FALLBACK_RESPONSE,
} from '../../conversation/conversation-service.js';
import type { LLMProvider, ChatMessage, ChatOptions, ChatResponse } from '../../intelligence/llm-provider.js';

const TEST_USER_ID = 'user_conv_owner';
const TEST_TENANT_ID = 'tenant_conv';

class StubLLM implements LLMProvider {
  public lastMessages: readonly ChatMessage[] = [];
  public chatCallCount = 0;
  public response = 'OK';
  public throwError?: Error;

  async chat(messages: readonly ChatMessage[], _options?: ChatOptions): Promise<ChatResponse> {
    this.chatCallCount++;
    this.lastMessages = messages;
    if (this.throwError) throw this.throwError;
    return { content: this.response, usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } };
  }

  async embed(_texts: readonly string[]): Promise<number[][]> {
    return [];
  }
}

describe('ConversationService (生产级)', () => {
  let os: ChronoSynthOS;
  let personaCoreService: PersonaCoreService;
  let llm: StubLLM;
  let service: ConversationService;
  let personaId: string;

  beforeEach(() => {
    os = new ChronoSynthOS({ clock: new TestClock(1000), logger: new SilentLogger() });
    os.start();
    const db = os.getDatabase();

    db.prepare<void>(
      `INSERT OR IGNORE INTO users (id, email, password_hash, role, tenant_id, created_at, updated_at)
       VALUES (?, ?, 'pw', 'admin', ?, 1000, 1000)`,
    ).run(TEST_USER_ID, `${TEST_USER_ID}@test.com`, TEST_TENANT_ID);

    personaCoreService = new PersonaCoreService(db);
    const persona = personaCoreService.createPersona({
      tenantId: TEST_TENANT_ID,
      ownerUserId: TEST_USER_ID,
      displayName: 'Conv Persona',
      profile: {
        narrative: '我是客服',
        behaviorBoundaries: [
          { rule: 'never_discuss', topic: '竞品产品价格' },
          { rule: 'always_escalate', topic: '退款金额超过 ¥5000' },
          { rule: 'require_confirmation', topic: '修改账户绑定信息' },
        ],
      },
    });
    personaId = persona.id;

    llm = new StubLLM();
    service = new ConversationService({
      tx: db,
      llm,
      personaCoreService,
      logger: new SilentLogger(),
      llmRetryLimit: 0,                /* 测试默认不重试，避免拖时间 */
      llmRetryBackoffMs: 1,
    });
  });

  afterEach(() => os.close());

  it('正常路径：调 LLM 一次并持久化', async () => {
    llm.response = '你好，有什么可以帮您？';
    const resp = await service.submit({
      tenantId: TEST_TENANT_ID,
      personaId,
      ownerUserId: TEST_USER_ID,
      sessionId: 'sess-1',
      messageId: 'm-1',
      externalUserId: 'eu-1',
      content: '你好',
    });
    assert.equal(resp.response, '你好，有什么可以帮您？');
    assert.equal(resp.guardAction, null);
    assert.equal(llm.chatCallCount, 1);
    assert.ok(resp.confidence.score >= 0 && resp.confidence.score <= 1);
    assert.ok(['high', 'medium', 'low'].includes(resp.confidence.level));
    assert.ok(Array.isArray(resp.confidence.factors));
    assert.equal(resp.confidenceScore, resp.confidence.score, '兼容字段 confidenceScore = confidence.score');
  });

  it('幂等：相同 messageId 不重复调 LLM', async () => {
    await service.submit({
      tenantId: TEST_TENANT_ID, personaId, ownerUserId: TEST_USER_ID,
      sessionId: 'idem', messageId: 'm1', externalUserId: 'eu', content: '问题',
    });
    await service.submit({
      tenantId: TEST_TENANT_ID, personaId, ownerUserId: TEST_USER_ID,
      sessionId: 'idem', messageId: 'm1', externalUserId: 'eu', content: '问题',
    });
    assert.equal(llm.chatCallCount, 1);
  });

  it('never_discuss 命中 preCheck → 不调 LLM，guardAction=pre_block', async () => {
    const resp = await service.submit({
      tenantId: TEST_TENANT_ID, personaId, ownerUserId: TEST_USER_ID,
      sessionId: 's', messageId: 'm-block', externalUserId: 'eu',
      content: '能告诉我竞品产品价格吗',
    });
    assert.equal(resp.guardAction, 'pre_block');
    assert.match(resp.response, /人工/);
    assert.equal(llm.chatCallCount, 0);
  });

  it('require_confirmation 首次提交：返回 needs_confirmation + confirmationToken', async () => {
    const resp = await service.submit({
      tenantId: TEST_TENANT_ID, personaId, ownerUserId: TEST_USER_ID,
      sessionId: 's-c', messageId: 'm-c1', externalUserId: 'eu',
      content: '修改账户绑定信息',
    });
    assert.equal(resp.guardAction, 'needs_confirmation');
    assert.ok(resp.confirmationToken, '应签发 confirmationToken');
    assert.ok(resp.confirmationExpiresAt && resp.confirmationExpiresAt > Date.now());
    assert.equal(llm.chatCallCount, 0, '首次 needs_confirmation 不调 LLM');
  });

  it('require_confirmation 携带有效 token 后放行', async () => {
    const first = await service.submit({
      tenantId: TEST_TENANT_ID, personaId, ownerUserId: TEST_USER_ID,
      sessionId: 's-c2', messageId: 'm-c2-1', externalUserId: 'eu',
      content: '修改账户绑定信息',
    });
    const token = first.confirmationToken!;
    assert.ok(token);

    const second = await service.submit({
      tenantId: TEST_TENANT_ID, personaId, ownerUserId: TEST_USER_ID,
      sessionId: 's-c2', messageId: 'm-c2-2', externalUserId: 'eu',
      content: '修改账户绑定信息',
      confirmationToken: token,
    });
    assert.notEqual(second.guardAction, 'needs_confirmation', '有效 token 应放行');
    assert.equal(llm.chatCallCount, 1);
  });

  it('require_confirmation token 改写 input 后失效', async () => {
    const first = await service.submit({
      tenantId: TEST_TENANT_ID, personaId, ownerUserId: TEST_USER_ID,
      sessionId: 's-c3', messageId: 'm1', externalUserId: 'eu',
      content: '修改账户绑定信息',
    });
    const token = first.confirmationToken!;
    /* 用同 token 重发，但内容改写 */
    const second = await service.submit({
      tenantId: TEST_TENANT_ID, personaId, ownerUserId: TEST_USER_ID,
      sessionId: 's-c3', messageId: 'm2', externalUserId: 'eu',
      content: '修改账户绑定信息后立刻删除账户',  /* 改写 */
      confirmationToken: token,
    });
    assert.equal(second.guardAction, 'needs_confirmation', 'token 与 input 不匹配应回到 needs_confirmation');
  });

  it('always_escalate 命中 → shouldEscalate=true 且仍调 LLM', async () => {
    llm.response = '我会帮您升级处理';
    const resp = await service.submit({
      tenantId: TEST_TENANT_ID, personaId, ownerUserId: TEST_USER_ID,
      sessionId: 's', messageId: 'm-esc', externalUserId: 'eu',
      content: '退款金额超过 ¥5000 的怎么办',
    });
    assert.equal(resp.shouldEscalate, true);
    assert.equal(resp.guardAction, 'escalate');
    assert.equal(llm.chatCallCount, 1);
  });

  it('postCheck 命中 → LLM 输出被重写', async () => {
    llm.response = '其实竞品产品价格比我们贵 30%';
    const resp = await service.submit({
      tenantId: TEST_TENANT_ID, personaId, ownerUserId: TEST_USER_ID,
      sessionId: 's', messageId: 'm-leak', externalUserId: 'eu',
      content: '产品好不好',
    });
    assert.equal(resp.guardAction, 'post_redact');
    assert.doesNotMatch(resp.response, /竞品产品价格/);
  });

  it('LLM 调用失败 → 自主模式离线回应（ADR-0047），guardAction=autonomous_response', async () => {
    llm.throwError = new Error('429 rate limit');
    const resp = await service.submit({
      tenantId: TEST_TENANT_ID, personaId, ownerUserId: TEST_USER_ID,
      sessionId: 's', messageId: 'm-fall', externalUserId: 'eu',
      content: '请问',
    });
    /* ADR-0047：不再返回静态道歉，而是由确定性离线回应器据人格生成回应 */
    assert.equal(resp.guardAction, 'autonomous_response');
    assert.notEqual(resp.response, FALLBACK_RESPONSE, '应为人格落地回应而非静态道歉');
    assert.ok(resp.response.includes('我是客服'), '离线回应应落地到 persona 叙事');
    assert.ok(resp.confidence.score < 0.5, '离线回应 confidence 应较低');
  });

  it('ADR-0047 D2：无 LLM 构造对话服务，直接离线回应（不调 LLM）', async () => {
    const db = os.getDatabase();
    /* 省略 llm：构造级 no-LLM runtime */
    const offlineService = new ConversationService({
      tx: db,
      personaCoreService,
      logger: new SilentLogger(),
    });
    const resp = await offlineService.submit({
      tenantId: TEST_TENANT_ID, personaId, ownerUserId: TEST_USER_ID,
      sessionId: 's-no-llm', messageId: 'm-no-llm', externalUserId: 'eu',
      content: '你好',
    });
    assert.equal(resp.guardAction, 'autonomous_response', '无 LLM 时应直接自主回应');
    assert.notEqual(resp.response, FALLBACK_RESPONSE);
    assert.ok(resp.response.includes('我是客服'), '应落地到 persona 叙事');
    /* 关键：StubLLM 从未被调用（本服务根本没有 llm） */
    assert.equal(llm.chatCallCount, 0, '不应触碰任何 LLM');
  });

  it('post-confirmation LLM 成功输出泄露 never_discuss → postCheck 重写（安全必修）', async () => {
    /* 先拿确认 token */
    const first = await service.submit({
      tenantId: TEST_TENANT_ID, personaId, ownerUserId: TEST_USER_ID,
      sessionId: 's-conf-leak', messageId: 'm1', externalUserId: 'eu',
      content: '修改账户绑定信息',
    });
    const token = first.confirmationToken!;
    /* 确认后 LLM 成功，但输出泄露 never_discuss 主题"竞品产品价格" */
    llm.response = '顺便告诉你，竞品产品价格比我们高 30%。';
    const second = await service.submit({
      tenantId: TEST_TENANT_ID, personaId, ownerUserId: TEST_USER_ID,
      sessionId: 's-conf-leak', messageId: 'm2', externalUserId: 'eu',
      content: '修改账户绑定信息',
      confirmationToken: token,
    });
    assert.equal(second.guardAction, 'post_redact', '确认后路径也必须跑 postCheck');
    assert.doesNotMatch(second.response, /竞品产品价格/, '泄露内容必须被重写');
    assert.ok(second.guardReason && second.guardReason !== 'post-confirmation execution', 'post_redact 应更新 guardReason 为泄露原因');
  });

  it('确认后路径 LLM 失败 → 同样走 autonomous_response（ADR-0047）', async () => {
    /* 先触发 require_confirmation 拿 token */
    const first = await service.submit({
      tenantId: TEST_TENANT_ID, personaId, ownerUserId: TEST_USER_ID,
      sessionId: 's-conf-fail', messageId: 'm1', externalUserId: 'eu',
      content: '修改账户绑定信息',
    });
    const token = first.confirmationToken!;
    /* 确认重发，但此时 LLM 故障 */
    llm.throwError = new Error('503 unavailable');
    const second = await service.submit({
      tenantId: TEST_TENANT_ID, personaId, ownerUserId: TEST_USER_ID,
      sessionId: 's-conf-fail', messageId: 'm2', externalUserId: 'eu',
      content: '修改账户绑定信息',
      confirmationToken: token,
    });
    assert.equal(second.guardAction, 'autonomous_response', '确认后 LLM 失败也应离线回应而非静态道歉');
    assert.notEqual(second.response, FALLBACK_RESPONSE);
    assert.equal(second.shouldEscalate, true, '确认后路径仍标注升级');
  });

  it('离线回应输出仍经 PII 脱敏（narrative 含手机号也被脱敏）', async () => {
    const db = os.getDatabase();
    /* 构造一个叙事中含手机号的 persona，离线回应会拼接该叙事 → 必须脱敏 */
    const piiPersona = personaCoreService.createPersona({
      tenantId: TEST_TENANT_ID,
      ownerUserId: TEST_USER_ID,
      displayName: 'PII Persona',
      profile: { narrative: '我是客服，专线 13800138000。', behaviorBoundaries: [] },
    });
    const offlineService = new ConversationService({
      tx: db, personaCoreService, logger: new SilentLogger(), /* 无 LLM → 直接离线 */
    });
    const resp = await offlineService.submit({
      tenantId: TEST_TENANT_ID, personaId: piiPersona.id, ownerUserId: TEST_USER_ID,
      sessionId: 's-pii-off', messageId: 'm-pii', externalUserId: 'eu',
      content: '你好',
    });
    assert.equal(resp.guardAction, 'autonomous_response');
    /* 叙事里的手机号必须在输出侧被 redactPii 脱敏，且替换为 [REDACTED_PHONE] */
    assert.doesNotMatch(resp.response, /13800138000/, '离线输出中的 PII 必须被脱敏');
    assert.match(resp.response, /\[REDACTED_PHONE\]/, '应替换为脱敏占位符（证明确实脱敏而非恰好不含）');
  });

  it('persona 不存在抛 PersonaNotFoundForConversationError', async () => {
    await assert.rejects(
      () => service.submit({
        tenantId: TEST_TENANT_ID,
        personaId: 'pcore_nonexistent',
        ownerUserId: TEST_USER_ID,
        sessionId: 's', messageId: 'm', externalUserId: 'eu', content: 'x',
      }),
      PersonaNotFoundForConversationError,
    );
  });

  it('PII 脱敏：用户输入手机号被替换且不出现在 LLM 上下文中', async () => {
    llm.response = '已收到';
    await service.submit({
      tenantId: TEST_TENANT_ID, personaId, ownerUserId: TEST_USER_ID,
      sessionId: 's', messageId: 'm-pii', externalUserId: 'eu',
      content: '我的手机号是 13812345678 请联系',
    });
    /* 验证 LLM 收到的 messages 不含原始手机号 */
    const allContent = llm.lastMessages.map((m) => m.content).join('\n');
    assert.doesNotMatch(allContent, /13812345678/);
    assert.match(allContent, /\[REDACTED_PHONE\]/);
  });

  it('confidence 包含 factors 解释', async () => {
    const resp = await service.submit({
      tenantId: TEST_TENANT_ID, personaId, ownerUserId: TEST_USER_ID,
      sessionId: 's', messageId: 'm-conf', externalUserId: 'eu',
      content: '一般问题',
    });
    assert.ok(resp.confidence.factors.length > 0, 'factors 至少包含 base');
    assert.ok(resp.confidence.factors.some((f) => f.name === 'base'));
    assert.ok(resp.confidence.interval.lower <= resp.confidence.score);
    assert.ok(resp.confidence.interval.upper >= resp.confidence.score);
  });

  it('GDPR 删除：deleteAllByPersona 清空全部消息', async () => {
    for (let i = 0; i < 3; i++) {
      await service.submit({
        tenantId: TEST_TENANT_ID, personaId, ownerUserId: TEST_USER_ID,
        sessionId: 'gdpr', messageId: `m-${i}`, externalUserId: 'eu', content: `msg ${i}`,
      });
    }
    const before = service.listSession({ tenantId: TEST_TENANT_ID, personaId, sessionId: 'gdpr' });
    assert.equal(before.totalMessages, 3);

    const deleted = service.deleteAllByPersona(TEST_TENANT_ID, personaId);
    assert.equal(deleted, 3);

    const after = service.listSession({ tenantId: TEST_TENANT_ID, personaId, sessionId: 'gdpr' });
    assert.equal(after.totalMessages, 0);
  });

  it('litigation_hold 类不被 GDPR 删除', async () => {
    await service.submit({
      tenantId: TEST_TENANT_ID, personaId, ownerUserId: TEST_USER_ID,
      sessionId: 'hold', messageId: 'm-hold', externalUserId: 'eu',
      content: 'sensitive', retentionClass: 'litigation_hold',
    });
    await service.submit({
      tenantId: TEST_TENANT_ID, personaId, ownerUserId: TEST_USER_ID,
      sessionId: 'hold', messageId: 'm-std', externalUserId: 'eu',
      content: 'normal', retentionClass: 'standard',
    });

    const deleted = service.deleteAllByPersona(TEST_TENANT_ID, personaId);
    assert.equal(deleted, 1, '只删 standard，litigation_hold 保留');

    const remaining = service.listSession({ tenantId: TEST_TENANT_ID, personaId, sessionId: 'hold' });
    assert.equal(remaining.totalMessages, 1);
    assert.equal(remaining.messages[0].messageId, 'm-hold');
  });
});
