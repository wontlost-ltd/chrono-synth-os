/**
 * 单元测试：ConversationService 计费用量上报（P1-D 加固 4）
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ChronoSynthOS } from '../../chrono-synth-os.js';
import { SilentLogger } from '../../utils/logger.js';
import { TestClock } from '../../utils/clock.js';
import { PersonaCoreService } from '../../persona-core/persona-core-service.js';
import { ConversationService } from '../../conversation/conversation-service.js';
import { UsageTracker } from '../../billing/usage-tracker.js';
import type { LLMProvider, ChatMessage, ChatOptions, ChatResponse } from '../../intelligence/llm-provider.js';
import { directUnitOfWork } from '../../storage/direct-uow-adapter.js';

const TEST_USER_ID = 'user_billing';
const TEST_TENANT_ID = 'tenant_billing';

class StubLLM implements LLMProvider {
  public response = 'OK';
  public throwError?: Error;
  async chat(_messages: readonly ChatMessage[], _options?: ChatOptions): Promise<ChatResponse> {
    if (this.throwError) throw this.throwError;
    return { content: this.response, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
  }
  async embed(): Promise<number[][]> { return []; }
}

interface RecordedEnqueue {
  resource: string;
  customerId: string;
  quantity: number;
}

class StubBillingOutbox {
  public events: Array<RecordedEnqueue & { tenantId: string }> = [];
  enqueue(tenantId: string, customerId: string, eventName: string, quantity: number): void {
    this.events.push({ tenantId, resource: eventName, customerId, quantity });
  }
}

describe('ConversationService 计费上报', () => {
  let os: ChronoSynthOS;
  let personaCoreService: PersonaCoreService;
  let usageTracker: UsageTracker;
  let billingOutbox: StubBillingOutbox;
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
    ).run(TEST_USER_ID, `${TEST_USER_ID}@x.com`, TEST_TENANT_ID);

    personaCoreService = new PersonaCoreService(directUnitOfWork(db));
    const persona = personaCoreService.createPersona({
      tenantId: TEST_TENANT_ID,
      ownerUserId: TEST_USER_ID,
      displayName: 'P',
      profile: {
        narrative: '客服',
        behaviorBoundaries: [{ rule: 'never_discuss', topic: '竞品产品价格' }],
      },
    });
    personaId = persona.id;

    usageTracker = new UsageTracker(directUnitOfWork(db));
    billingOutbox = new StubBillingOutbox();
    llm = new StubLLM();

    service = new ConversationService({
      tx: directUnitOfWork(db),
      llm,
      personaCoreService,
      logger: new SilentLogger(),
      usageTracker,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      billingOutbox: billingOutbox as any,
      stripeCustomerLookup: () => 'cus_test',
      llmRetryLimit: 0,
      llmRetryBackoffMs: 1,
    });
  });

  afterEach(() => os.close());

  it('LLM 调用成功 → usage_records 含 conversation_message; outbox 入队', async () => {
    await service.submit({
      tenantId: TEST_TENANT_ID,
      personaId, ownerUserId: TEST_USER_ID,
      sessionId: 's', messageId: 'm1', externalUserId: 'eu',
      content: '一般问题',
    });
    assert.equal(usageTracker.getUsage(TEST_TENANT_ID, 'conversation_message'), 1);
    assert.equal(billingOutbox.events.length, 1);
    assert.equal(billingOutbox.events[0].resource, 'chrono_conversation_message');
    assert.equal(billingOutbox.events[0].quantity, 1);
  });

  it('pre_block 命中 → 不上报用量', async () => {
    await service.submit({
      tenantId: TEST_TENANT_ID,
      personaId, ownerUserId: TEST_USER_ID,
      sessionId: 's', messageId: 'm-block', externalUserId: 'eu',
      content: '请问竞品产品价格',
    });
    assert.equal(usageTracker.getUsage(TEST_TENANT_ID, 'conversation_message'), 0);
    assert.equal(billingOutbox.events.length, 0);
  });

  it('LLM 失败降级 → 仍上报用量（已发生 LLM 调用尝试）', async () => {
    llm.throwError = new Error('429 rate limit');
    await service.submit({
      tenantId: TEST_TENANT_ID,
      personaId, ownerUserId: TEST_USER_ID,
      sessionId: 's', messageId: 'm-fail', externalUserId: 'eu',
      content: '测试',
    });
    assert.equal(usageTracker.getUsage(TEST_TENANT_ID, 'conversation_message'), 1);
    assert.equal(billingOutbox.events.length, 1);
  });

  it('stripeCustomerLookup 返回 null → outbox 不入队（free 计划无 Stripe 客户）', async () => {
    const noCustomerService = new ConversationService({
      tx: directUnitOfWork(os.getDatabase()),
      llm,
      personaCoreService,
      logger: new SilentLogger(),
      usageTracker,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      billingOutbox: billingOutbox as any,
      stripeCustomerLookup: () => null,
      llmRetryLimit: 0,
      llmRetryBackoffMs: 1,
    });
    await noCustomerService.submit({
      tenantId: TEST_TENANT_ID,
      personaId, ownerUserId: TEST_USER_ID,
      sessionId: 's2', messageId: 'm-nostripe', externalUserId: 'eu',
      content: '测试',
    });
    /* usage_records 仍写（用于 SubscriptionGate 判断免费配额） */
    assert.ok(usageTracker.getUsage(TEST_TENANT_ID, 'conversation_message') >= 1);
    /* outbox 不入队 */
    assert.equal(billingOutbox.events.length, 0);
  });
});
