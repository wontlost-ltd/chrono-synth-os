import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { composeNudge } from '../../proactivity/proactive-composer.js';

/**
 * 主动文案生成（ADR-0054 Phase 4）：据叙事/记忆个性化（确定性零-LLM），无 context 回退基线模板。
 */
describe('composeNudge（ADR-0054 Phase 4 个性化文案）', () => {
  it('无 context → 基线模板（向后兼容 P3）', () => {
    const n = composeNudge('core:memory-consolidated');
    assert.equal(n.kind, 'memory');
    assert.ok(n.body.length > 0);
    /* 基线模板不含引号片段。 */
    assert.ok(!n.body.includes('「'));
  });

  it('有 snippet → 个性化 opener 引用片段', () => {
    const n = composeNudge('core:memory-consolidated', { snippet: '那次一个人去海边看日出' });
    assert.match(n.body, /那次一个人去海边看日出/);
    assert.match(n.body, /「.*」/, '应把片段放进引号');
  });

  it('确定性：相同输入 → 相同文案（可复现）', () => {
    const a = composeNudge('system:evolution-completed', { snippet: '我更愿意主动尝试了' });
    const b = composeNudge('system:evolution-completed', { snippet: '我更愿意主动尝试了' });
    assert.equal(a.body, b.body);
  });

  it('片段超长 → 截断 + 省略号（不复述整段原文）', () => {
    const long = '一'.repeat(200);
    const n = composeNudge('core:narrative-changed', { snippet: long });
    assert.match(n.body, /…/, '超长片段应截断加省略号');
    assert.ok(n.body.length < 200, '不应把整段原文塞进去');
  });

  it('空白 snippet → 回退基线模板', () => {
    const n = composeNudge('core:narrative-changed', { snippet: '   ' });
    assert.equal(n.body, composeNudge('core:narrative-changed').body, '空白片段等价无 context');
  });

  it('三类信号都有基线 + 个性化两套文案', () => {
    for (const sig of ['core:memory-consolidated', 'core:narrative-changed', 'system:evolution-completed'] as const) {
      const base = composeNudge(sig);
      const personalized = composeNudge(sig, { snippet: '某个有意义的片段' });
      assert.ok(base.body.length > 0);
      assert.notEqual(base.body, personalized.body, `${sig} 个性化应不同于基线`);
      assert.equal(base.kind, personalized.kind, 'kind 一致');
    }
  });
});
