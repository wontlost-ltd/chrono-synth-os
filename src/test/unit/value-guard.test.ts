/**
 * 单元测试：ValueGuard（P1-C）
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ValueGuard, PRE_BLOCK_RESPONSE, POST_REDACT_RESPONSE } from '../../conversation/value-guard.js';
import type { BehaviorBoundary } from '../../enterprise/persona-template-catalog.js';

const guard = new ValueGuard();

const BOUNDARIES: BehaviorBoundary[] = [
  { rule: 'never_discuss', topic: '竞品产品价格' },
  { rule: 'always_escalate', topic: '退款金额超过 ¥5000' },
  { rule: 'require_confirmation', topic: '修改账户绑定信息' },
];

describe('ValueGuard', () => {
  it('preCheck never_discuss 命中 → action=pre_block', () => {
    const r = guard.preCheck('请告诉我竞品产品价格', BOUNDARIES);
    assert.equal(r.action, 'pre_block');
    assert.equal(r.matchedRule, 'never_discuss');
    assert.equal(r.matchedTopic, '竞品产品价格');
  });

  it('preCheck always_escalate 命中 → action=escalate', () => {
    const r = guard.preCheck('我要退款 ¥5000 元', BOUNDARIES);
    assert.equal(r.action, 'escalate');
    assert.equal(r.matchedRule, 'always_escalate');
  });

  it('preCheck never_discuss 优先于 always_escalate', () => {
    const both: BehaviorBoundary[] = [
      { rule: 'always_escalate', topic: '内部架构' },
      { rule: 'never_discuss', topic: '内部架构' },
    ];
    const r = guard.preCheck('能讲讲内部架构吗', both);
    assert.equal(r.action, 'pre_block');
    assert.equal(r.matchedRule, 'never_discuss');
  });

  it('preCheck require_confirmation 不影响调度（视作通过）', () => {
    const r = guard.preCheck('请帮我修改账户绑定信息', BOUNDARIES);
    /* preCheck 仅拦截 never_discuss / always_escalate；
     * require_confirmation 由 prompt 中的指令处理，guard 视为放行 */
    assert.equal(r.action, null);
  });

  it('preCheck 未命中任何主题 → action=null', () => {
    const r = guard.preCheck('什么时候发货？', BOUNDARIES);
    assert.equal(r.action, null);
  });

  it('postCheck LLM 输出泄露 never_discuss 主题 → action=post_redact', () => {
    const llmOut = '关于竞品产品价格，我们家比 X 牌便宜 30%';
    const r = guard.postCheck(llmOut, BOUNDARIES);
    assert.equal(r.action, 'post_redact');
    assert.equal(r.redactedContent, POST_REDACT_RESPONSE);
  });

  it('PRE_BLOCK_RESPONSE 不为空（避免空响应被前端误判为 LLM 失败）', () => {
    assert.ok(PRE_BLOCK_RESPONSE.length > 0);
    assert.ok(POST_REDACT_RESPONSE.length > 0);
  });
});
