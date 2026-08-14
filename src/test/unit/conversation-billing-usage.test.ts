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
  public events: Array<RecordedEnqueue & { tenantId: string; sourceId?: string }> = [];
  /* 必须捕获 sourceId：不捕获就无法发现「退化成时间戳+进程序号」的重复计费缺陷。 */
  enqueue(tenantId: string, customerId: string, eventName: string, quantity: number, sourceId?: string): void {
    this.events.push({ tenantId, resource: eventName, customerId, quantity, sourceId });
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

    personaCoreService = PersonaCoreService.fromUnitOfWork(db);
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

    usageTracker = UsageTracker.fromUnitOfWork(db);
    billingOutbox = new StubBillingOutbox();
    llm = new StubLLM();

    service = new ConversationService({
      tx: db,
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

  /* 审计 Warning B4-6：无 sourceId 时 outbox 的幂等键退化成
   * 「tenant:event:时间戳:进程序号」——跨进程/跨重试都不去重，重试即重复计费。
   * 生产上**所有** enqueue 调用点原先都没传 sourceId。 */
  it('计费事件必须携带业务因果 ID（sourceId），否则重试会重复计费', async () => {
    await service.submit({
      tenantId: TEST_TENANT_ID, personaId, ownerUserId: TEST_USER_ID,
      sessionId: 's-bill', messageId: 'm-bill-1', externalUserId: 'eu',
      content: '你好',
    });

    assert.equal(billingOutbox.events.length, 1);
    const ev = billingOutbox.events[0]!;
    assert.ok(ev.sourceId, 'enqueue 必须带 sourceId');
    /* 锚必须①跨重试稳定 ②覆盖完整唯一域。
     * 曾误用服务端行 id（randomUUID，每次新值 → 幂等为零）；
     * 又曾漏掉 personaId（撞键 → 少计费，见下一条用例）。 */
    const SEP = '\u001f';
    assert.equal(
      ev.sourceId, [personaId, 's-bill', 'm-bill-1'].join(SEP),
      'sourceId 须为 personaId+sessionId+messageId 三段',
    );
    assert.ok(!/^cmsg_/.test(ev.sourceId!), '绝不能用每次新生成的服务端行 id');
  });

  /* Codex 交叉审查抓到（同模型 agent 漏判）：v065 的约束是
   * UNIQUE(tenant_id, persona_id, session_id, message_id) —— **四列**。
   * 锚少写 personaId 会让同租户同会话下的两个 persona 撞成同一个 outbox 键，
   * 第二条计费事件被当作重复丢弃 → **少计费**（漏钱，方向与重复计费相反）。 */
  it('同会话不同 persona：计费锚不得撞键（防少计费）', async () => {
    const secondPersona = personaCoreService.createPersona({
      tenantId: TEST_TENANT_ID,
      ownerUserId: TEST_USER_ID,
      displayName: '第二人格',
      profile: { narrative: '客服', behaviorBoundaries: [] },
    }).id;

    /* 两个 persona、同一 sessionId、同一 messageId。 */
    for (const pid of [personaId, secondPersona]) {
      await service.submit({
        tenantId: TEST_TENANT_ID, personaId: pid, ownerUserId: TEST_USER_ID,
        sessionId: 's-same', messageId: 'm-same', externalUserId: 'eu',
        content: '你好',
      });
    }

    const anchors = billingOutbox.events.map((e) => e.sourceId);
    assert.equal(anchors.length, 2, '两个 persona 各产生一条计费事件');
    assert.notEqual(anchors[0], anchors[1], '两条锚必须不同，否则第二条会被去重丢弃');
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
      tx: os.getDatabase(),
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
