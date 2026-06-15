/**
 * 单元测试：确定性关键词 + 连续短语打分（conversation-knowledge-retriever 导出的 companion 复用函数）。
 * 重点验证 scorePhraseBonus 的消歧能力（flat white ≠ 手冲咖啡）。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tokenize, scoreTextByKeyword, scorePhraseBonus } from '../../conversation/conversation-knowledge-retriever.js';

describe('scoreTextByKeyword', () => {
  it('长词（≥4 字符）权重 2，短词权重 1', () => {
    assert.equal(scoreTextByKeyword('hello world', ['hello']), 2);  // 5 字符
    assert.equal(scoreTextByKeyword('a bc def', ['bc']), 1);        // 2 字符
  });
  it('未命中得 0', () => {
    assert.equal(scoreTextByKeyword('foo bar', tokenize('量子计算')), 0);
  });
});

describe('scorePhraseBonus（消歧）', () => {
  it('latin 连续短语整段命中 → +2×词数；单词撞车不加分', () => {
    /* 「flat white」整段命中 → +4；单独「coffee」不构成短语。 */
    assert.equal(scorePhraseBonus('i love flat white coffee', '怎么做 flat white'), 4);
    /* 手冲记忆不含「flat white」短语 → phrase 加分 0。 */
    assert.equal(scorePhraseBonus('我研究了手冲咖啡', 'flat white 怎么做'), 0);
  });

  it('flat white 查询：flat white 记忆总分远高于手冲撞车记忆', () => {
    const q = '怎么冲一杯 flat white 咖啡';
    const tokens = tokenize(q);
    const flatWhiteScore = scoreTextByKeyword('我学会了制作 flat white，先萃取 espresso', tokens)
      + scorePhraseBonus('我学会了制作 flat white，先萃取 espresso', q);
    const pourOverScore = scoreTextByKeyword('我研究了手冲咖啡的技巧，水温 92-96 度', tokens)
      + scorePhraseBonus('我研究了手冲咖啡的技巧，水温 92-96 度', q);
    assert.ok(flatWhiteScore > pourOverScore, `flat white(${flatWhiteScore}) 应 > 手冲(${pourOverScore})`);
  });

  it('CJK ≥4 字专名连续段整段命中加分（如「人类简史」）', () => {
    /* 「人类简史」4 字专名整段命中 → +4；2/3-gram 撞车的「人类」不构成专名加分。 */
    assert.equal(scorePhraseBonus('我最近在读人类简史', '人类简史讲了什么'), 4);
    assert.equal(scorePhraseBonus('我研究了人类学', '人类简史讲了什么'), 0, '只共享「人类」不构成专名短语');
  });

  it('确定性：相同输入相同输出', () => {
    const a = scorePhraseBonus('flat white espresso', '怎么做 flat white');
    const b = scorePhraseBonus('flat white espresso', '怎么做 flat white');
    assert.equal(a, b);
  });

  it('每起点只取最长命中，不重复累加子短语（防组合式膨胀，Codex 复审）', () => {
    /* 查询「alpha beta gamma」整段命中 → 只加 2×3=6，不再额外加 alpha-beta(4)/beta-gamma(4)。 */
    const s = scorePhraseBonus('x alpha beta gamma y', 'alpha beta gamma');
    assert.equal(s, 6, '3 词短语只记一次 2×3');
  });

  it('超长输入不爆开（词数 cap + O(words) 量级）', () => {
    /* 200 个词的查询 + 长记忆，应快速返回有限分数（不组合爆炸）。 */
    const longQuery = Array.from({ length: 200 }, (_, i) => `word${i}`).join(' ');
    const longHay = longQuery;  /* 全命中 */
    const t0 = Date.now();
    const s = scorePhraseBonus(longHay, longQuery);
    assert.ok(Date.now() - t0 < 200, '超长输入应快速返回');
    assert.ok(Number.isFinite(s) && s > 0);
  });
});
