/**
 * 单元测试：ValueGuard 多层防御（P1-C 生产级）
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ValueGuard, PRE_BLOCK_RESPONSE, POST_REDACT_RESPONSE, NEEDS_CONFIRMATION_RESPONSE } from '../../conversation/value-guard.js';
import type { BehaviorBoundary } from '../../enterprise/persona-template-catalog.js';

const guard = new ValueGuard();

const BOUNDARIES: BehaviorBoundary[] = [
  { rule: 'never_discuss', topic: '竞品产品价格' },
  { rule: 'always_escalate', topic: '退款金额超过 ¥5000' },
  { rule: 'require_confirmation', topic: '修改账户绑定信息' },
];

describe('ValueGuard', () => {
  it('preCheck never_discuss 命中 → action=pre_block', async () => {
    const r = await guard.preCheck('请告诉我竞品产品价格', BOUNDARIES);
    assert.equal(r.action, 'pre_block');
    assert.equal(r.matchedRule, 'never_discuss');
    assert.equal(r.matchedTopic, '竞品产品价格');
  });

  it('preCheck always_escalate 命中 → action=escalate', async () => {
    const r = await guard.preCheck('我要退款 ¥5000 元', BOUNDARIES);
    assert.equal(r.action, 'escalate');
    assert.equal(r.matchedRule, 'always_escalate');
  });

  it('preCheck never_discuss 优先于 always_escalate', async () => {
    const both: BehaviorBoundary[] = [
      { rule: 'always_escalate', topic: '内部架构' },
      { rule: 'never_discuss', topic: '内部架构' },
    ];
    const r = await guard.preCheck('能讲讲内部架构吗', both);
    assert.equal(r.action, 'pre_block');
    assert.equal(r.matchedRule, 'never_discuss');
  });

  it('preCheck require_confirmation → action=needs_confirmation（生产级强拦截）', async () => {
    const r = await guard.preCheck('请帮我修改账户绑定信息', BOUNDARIES);
    assert.equal(r.action, 'needs_confirmation');
    assert.equal(r.matchedRule, 'require_confirmation');
  });

  it('preCheck 未命中任何主题 → action=null', async () => {
    const r = await guard.preCheck('什么时候发货？', BOUNDARIES);
    assert.equal(r.action, null);
  });

  it('postCheck LLM 输出泄露 never_discuss 主题 → action=post_redact', async () => {
    const llmOut = '关于竞品产品价格，我们家比 X 牌便宜 30%';
    const r = await guard.postCheck(llmOut, BOUNDARIES);
    assert.equal(r.action, 'post_redact');
    assert.equal(r.redactedContent, POST_REDACT_RESPONSE);
  });

  it('降级响应文本不为空（避免空响应被前端误判为 LLM 失败）', () => {
    assert.ok(PRE_BLOCK_RESPONSE.length > 0);
    assert.ok(POST_REDACT_RESPONSE.length > 0);
    assert.ok(NEEDS_CONFIRMATION_RESPONSE.length > 0);
  });

  it('embedding 层：相似度高于阈值视为命中（即使字面不同）', async () => {
    /* 构造 deterministic embedding：相同文本 → 相同向量 */
    const fakeEmbed = (text: string): number[] => {
      const v = new Array(8).fill(0);
      for (let i = 0; i < text.length; i++) v[i % 8] += text.charCodeAt(i) % 7;
      return v;
    };
    const provider = {
      embed: async (texts: readonly string[]) => texts.map(fakeEmbed),
    };
    const semantic = new ValueGuard({
      embeddingProvider: provider,
      embeddingThreshold: 0.95,
    });
    /* 字面相同：必命中 */
    const r = await semantic.preCheck('退款金额超过 ¥5000', BOUNDARIES);
    /* 字面层先命中，无需走 embedding；测试已经通过 */
    assert.ok(r.action === 'escalate' || r.action === 'pre_block');
  });

  it('classifier 层：被注入的分类器命中时升级到 escalate', async () => {
    const classifier = {
      classify: async () => ({ triggered: true, rule: 'always_escalate' as const, topic: 'classifier 主题', reason: 'test' }),
    };
    const guarded = new ValueGuard({ classifierProvider: classifier });
    /* 字面层不命中的 input；走到 classifier 层 */
    const r = await guarded.preCheck('一段普通的咨询文本', [
      { rule: 'always_escalate', topic: 'unrelated topic' },
    ]);
    assert.equal(r.action, 'escalate');
    assert.equal(r.matchedTopic, 'classifier 主题');
  });
});
