import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { detectLanguage } from '../../conversation/language-detect.js';

/* ADR-0055 多语种：对话语言确定性检测（zh-CN/en）。 */
describe('detectLanguage', () => {
  it('中文句 → zh-CN', () => {
    for (const s of ['你叫什么', '我给你起个名字叫张三', '今天天气不错', '怎么做 flat white']) {
      assert.equal(detectLanguage(s), 'zh-CN', `「${s}」应判中文`);
    }
  });

  it('英文句 → en', () => {
    for (const s of ["what's your name", 'call you Max', 'I like running', 'how do I make a flat white']) {
      assert.equal(detectLanguage(s), 'en', `「${s}」应判英文`);
    }
  });

  it('中英混合：CJK 占比达阈值 → zh-CN（中文用户直觉）', () => {
    assert.equal(detectLanguage('我想学 Python'), 'zh-CN');
    assert.equal(detectLanguage('这个 flat white 怎么做'), 'zh-CN');
  });

  it('英文为主夹少量专名 → en', () => {
    assert.equal(detectLanguage('what is Python'), 'en');
  });

  it('无可判定字符（纯标点/数字）→ 回退（默认 en）', () => {
    assert.equal(detectLanguage('123 !!!'), 'en');
    assert.equal(detectLanguage('', 'zh-CN'), 'zh-CN', '可指定回退');
  });

  it('确定性：相同输入 → 相同输出', () => {
    assert.equal(detectLanguage('hello there'), detectLanguage('hello there'));
  });
});
