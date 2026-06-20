import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyStance, isOpinionQuestion } from '../../conversation/stance.js';

/* ADR-0056 观点/不确定立场——确定性：相同 (opinionQuestion, grounding) → 相同 stance。 */
describe('classifyStance', () => {
  it('事实问答有依据（top relevance ≥ 弱阈）→ confident（无前缀，零回归）', () => {
    assert.equal(classifyStance(false, { topRelevance: 0.8, count: 3 }), 'confident');
    assert.equal(classifyStance(false, { topRelevance: 0.5, count: 2 }), 'confident');
    /* 单条关键词命中（0.2）也算有依据：事实问答不迟疑 → 零回归。 */
    assert.equal(classifyStance(false, { topRelevance: 0.2, count: 1 }), 'confident');
    assert.equal(classifyStance(false, { topRelevance: 0.8, count: 1 }), 'confident');
  });

  it('事实问答 grounding 弱（top relevance ＜ 0.12，仅远端图邻居）→ tentative', () => {
    assert.equal(classifyStance(false, { topRelevance: 0.1, count: 1 }), 'tentative');
    assert.equal(classifyStance(false, { topRelevance: 0.05, count: 2 }), 'tentative');
  });

  it('评价类问题 + 够底气（≥2 条印证，或单条 ≥0.5）→ opinion（我觉得）', () => {
    assert.equal(classifyStance(true, { topRelevance: 0.3, count: 2 }), 'opinion', '多条印证敢表态');
    assert.equal(classifyStance(true, { topRelevance: 0.6, count: 1 }), 'opinion', '单条高相关也敢表态');
  });

  it('评价类问题但依据单薄（仅 1 条且相关度一般）→ tentative（观点比事实更需底气）', () => {
    assert.equal(classifyStance(true, { topRelevance: 0.3, count: 1 }), 'tentative');
    assert.equal(classifyStance(true, { topRelevance: 0.2, count: 1 }), 'tentative');
  });

  it('无依据（count 0）→ tentative（不冒充自信）', () => {
    assert.equal(classifyStance(false, { topRelevance: 0, count: 0 }), 'tentative');
    assert.equal(classifyStance(true, { topRelevance: 0, count: 0 }), 'tentative');
  });

  it('确定性：相同输入相同输出', () => {
    assert.equal(
      classifyStance(true, { topRelevance: 0.6, count: 2 }),
      classifyStance(true, { topRelevance: 0.6, count: 2 }),
    );
  });
});

describe('isOpinionQuestion (zh-CN)', () => {
  it('评价/看法类问题 → true', () => {
    for (const q of [
      '你觉得这个方案怎么样', '你认为他靠谱吗', '你怎么看这件事', '你喜欢喝咖啡吗',
      '这家店好不好', '该不该换工作', '在你看来哪个更好', '你的看法是什么',
    ]) {
      assert.equal(isOpinionQuestion(q, 'zh-CN'), true, `「${q}」应为评价类问题`);
    }
  });
  it('纯事实问题 → false', () => {
    for (const q of ['flat white 怎么做', '虚拟线程是什么', '今天几点', '你叫什么名字']) {
      assert.equal(isOpinionQuestion(q, 'zh-CN'), false, `「${q}」不该被当评价类`);
    }
  });
  it('对抗（Codex 复审）：裸「你看」（你看过/你看一下）是事实/指令，不当评价类', () => {
    for (const q of ['你看过这本书吗', '你看一下 flat white 怎么做', '你看 Java virtual thread 是什么', '你看见我的钥匙了吗']) {
      assert.equal(isOpinionQuestion(q, 'zh-CN'), false, `「${q}」不该被当评价类`);
    }
  });
});

describe('isOpinionQuestion (en)', () => {
  it('评价/看法类问题 → true', () => {
    for (const q of [
      'what do you think of this', 'how do you feel about it', 'do you like coffee',
      'is this approach good', 'in your opinion which is better', 'should I quit my job',
      "what's your take on remote work",
    ]) {
      assert.equal(isOpinionQuestion(q, 'en'), true, `「${q}」应为评价类问题`);
    }
  });
  it('纯事实问题 → false', () => {
    for (const q of ['how do you make a flat white', 'what is a virtual thread', 'what time is it']) {
      assert.equal(isOpinionQuestion(q, 'en'), false, `「${q}」不该被当评价类`);
    }
  });
});
