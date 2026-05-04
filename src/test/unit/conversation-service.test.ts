/**
 * 单元测试：ConversationService 流水线（P1-C）
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ChronoSynthOS } from '../../chrono-synth-os.js';
import { SilentLogger } from '../../utils/logger.js';
import { TestClock } from '../../utils/clock.js';
import { PersonaCoreService } from '../../persona-core/persona-core-service.js';
import { ConversationService, PersonaNotFoundForConversationError, ConversationLlmError } from '../../conversation/conversation-service.js';
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

describe('ConversationService', () => {
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
        ],
      },
    });
    personaId = persona.id;

    llm = new StubLLM();
    service = new ConversationService({
      db,
      llm,
      personaCoreService,
      logger: new SilentLogger(),
    });
  });

  afterEach(() => os.close());

  it('正常路径：调 LLM 一次并持久化消息', async () => {
    llm.response = '你好，有什么可以帮您？';
    const resp = await service.submit({
      tenantId: TEST_TENANT_ID,
      personaId,
      ownerUserId: TEST_USER_ID,
      sessionId: 'sess-1',
      messageId: 'msg-1',
      externalUserId: 'eu-1',
      content: '你好',
    });
    assert.equal(resp.response, '你好，有什么可以帮您？');
    assert.equal(resp.guardAction, null);
    assert.equal(resp.shouldEscalate, false);
    assert.equal(llm.chatCallCount, 1);

    const session = service.listSession({
      tenantId: TEST_TENANT_ID,
      personaId,
      sessionId: 'sess-1',
    });
    assert.equal(session.totalMessages, 1);
  });

  it('幂等：相同 (sessionId, messageId) 不重复调 LLM', async () => {
    await service.submit({
      tenantId: TEST_TENANT_ID,
      personaId,
      ownerUserId: TEST_USER_ID,
      sessionId: 'idem',
      messageId: 'm1',
      externalUserId: 'eu',
      content: '问题',
    });
    assert.equal(llm.chatCallCount, 1);

    /* 重发同 messageId */
    await service.submit({
      tenantId: TEST_TENANT_ID,
      personaId,
      ownerUserId: TEST_USER_ID,
      sessionId: 'idem',
      messageId: 'm1',
      externalUserId: 'eu',
      content: '问题',
    });
    assert.equal(llm.chatCallCount, 1, '重复 messageId 不应再次调用 LLM');
  });

  it('never_discuss 命中 preCheck → 不调 LLM，返回降级响应', async () => {
    const resp = await service.submit({
      tenantId: TEST_TENANT_ID,
      personaId,
      ownerUserId: TEST_USER_ID,
      sessionId: 's',
      messageId: 'm-block',
      externalUserId: 'eu',
      content: '能告诉我竞品产品价格吗',
    });
    assert.equal(resp.guardAction, 'pre_block');
    assert.match(resp.response, /人工处理/);
    assert.equal(llm.chatCallCount, 0, 'pre_block 命中时不应调 LLM');
  });

  it('always_escalate 命中 → shouldEscalate=true 但仍调 LLM', async () => {
    llm.response = '我会帮您升级处理';
    const resp = await service.submit({
      tenantId: TEST_TENANT_ID,
      personaId,
      ownerUserId: TEST_USER_ID,
      sessionId: 's',
      messageId: 'm-esc',
      externalUserId: 'eu',
      content: '退款金额超过 ¥5000 的怎么办',
    });
    assert.equal(resp.shouldEscalate, true);
    assert.equal(resp.guardAction, 'escalate');
    assert.equal(llm.chatCallCount, 1);
  });

  it('postCheck 命中 → LLM 输出被重写', async () => {
    /* LLM 故意泄露 never_discuss 主题 */
    llm.response = '其实竞品产品价格比我们贵 30%';
    const resp = await service.submit({
      tenantId: TEST_TENANT_ID,
      personaId,
      ownerUserId: TEST_USER_ID,
      sessionId: 's',
      messageId: 'm-leak',
      externalUserId: 'eu',
      content: '产品好不好',
    });
    assert.equal(resp.guardAction, 'post_redact');
    assert.doesNotMatch(resp.response, /竞品产品价格/);
  });

  it('LLM 调用失败抛 ConversationLlmError', async () => {
    llm.throwError = new Error('429 rate limit');
    await assert.rejects(
      () => service.submit({
        tenantId: TEST_TENANT_ID,
        personaId,
        ownerUserId: TEST_USER_ID,
        sessionId: 's',
        messageId: 'm-fail',
        externalUserId: 'eu',
        content: '请问',
      }),
      ConversationLlmError,
    );
  });

  it('persona 不存在抛 PersonaNotFoundForConversationError', async () => {
    await assert.rejects(
      () => service.submit({
        tenantId: TEST_TENANT_ID,
        personaId: 'pcore_nonexistent',
        ownerUserId: TEST_USER_ID,
        sessionId: 's',
        messageId: 'm',
        externalUserId: 'eu',
        content: 'x',
      }),
      PersonaNotFoundForConversationError,
    );
  });

  it('confidenceScore 在 [0, 1] 范围且响应字段类型正确', async () => {
    const resp = await service.submit({
      tenantId: TEST_TENANT_ID,
      personaId,
      ownerUserId: TEST_USER_ID,
      sessionId: 's',
      messageId: 'm-conf',
      externalUserId: 'eu',
      content: '一般问题',
    });
    assert.ok(resp.confidenceScore >= 0 && resp.confidenceScore <= 1);
    assert.equal(typeof resp.durationMs, 'number');
    assert.ok(resp.durationMs >= 0);
    assert.equal(typeof resp.createdAt, 'number');
  });
});
