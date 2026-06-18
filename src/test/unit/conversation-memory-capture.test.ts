import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  decideConversationCapture,
  CONVERSATION_MEMORY_SALIENCE,
  CONVERSATION_MEMORY_VALENCE,
} from '../../conversation/conversation-memory-capture.js';

/* ADR-0055「对话即经历」沉淀决策——纯确定性，相同输入相同输出。 */
describe('decideConversationCapture', () => {
  it('实质内容 → 沉淀，正文带来源前缀', () => {
    const d = decideConversationCapture('我给你起个名字叫张三', 'zh-CN');
    assert.equal(d.capture, true);
    assert.match(d.content, /^（来自对话）/);
    assert.match(d.content, /张三/);
  });

  it('纯寒暄 → 不沉淀（避免垃圾记忆）', () => {
    for (const greeting of ['你好', '嗯嗯', '哈哈', '好的', 'ok', '谢谢', '再见']) {
      assert.equal(decideConversationCapture(greeting, 'zh-CN').capture, false, `「${greeting}」应不沉淀`);
    }
  });

  it('过短 / 空白 → 不沉淀', () => {
    assert.equal(decideConversationCapture('', 'zh-CN').capture, false);
    assert.equal(decideConversationCapture('   ', 'zh-CN').capture, false);
    assert.equal(decideConversationCapture('好', 'zh-CN').capture, false);
  });

  it('纯疑问句 → 不沉淀（避免问句自回声污染检索 + 保住可复现）', () => {
    for (const q of ['你喜欢跑步吗', '虚拟线程？', '你叫什么名字', '我给你起的名字叫什么', '你会做什么呢']) {
      assert.equal(decideConversationCapture(q, 'zh-CN').capture, false, `「${q}」是疑问，应不沉淀`);
    }
  });

  it('陈述句 → 沉淀（用户告诉它的事，有内化价值）', () => {
    for (const s of ['我给你起个名字叫张三', '我叫你张三', '我希望你以后更主动', '我的生日是六月']) {
      assert.equal(decideConversationCapture(s, 'zh-CN').capture, true, `「${s}」是陈述，应沉淀`);
    }
  });

  it('句尾疑问词的句子按疑问处理（鲁棒按句尾，不靠脆弱句首例外）', () => {
    /* 「我起的名字叫什么」句尾「什么」→ 疑问，不沉淀（即便句首是「我」）。 */
    assert.equal(decideConversationCapture('我给你起的名字叫什么', 'zh-CN').capture, false);
    assert.equal(decideConversationCapture('你住在哪里', 'zh-CN').capture, false);
    assert.equal(decideConversationCapture('这是怎么回事呢', 'zh-CN').capture, false);
    /* 句尾确认助词的「陈述+确认」句也按疑问保守处理（用户会单独陈述一次，避免误捕反问/命令）。 */
    assert.equal(decideConversationCapture('我叫你张三，记住了吗', 'zh-CN').capture, false);
  });

  it('确定性：相同输入 → 相同输出', () => {
    const a = decideConversationCapture('我最近在思考怎么带团队', 'zh-CN');
    const b = decideConversationCapture('我最近在思考怎么带团队', 'zh-CN');
    assert.deepEqual(a, b);
  });

  it('超长输入 → 截断（单条记忆不被撑爆）', () => {
    const long = '我'.repeat(500);
    const d = decideConversationCapture(long, 'zh-CN');
    assert.equal(d.capture, true);
    /* 前缀 + 截断到 280 → 总长受控（前缀约 5 字 + ≤280）。 */
    assert.ok(d.content.length <= 300, `沉淀正文应被截断，实得 ${d.content.length}`);
  });

  it('沉淀记忆为低显著、中性情感（不盖过老师教的知识）', () => {
    assert.ok(CONVERSATION_MEMORY_SALIENCE < 0.5, '对话记忆应低显著');
    assert.equal(CONVERSATION_MEMORY_VALENCE, 0, '对话记忆情感中性');
  });

  /* ── 英文（en locale）── */

  it('英文陈述句 → 沉淀；英文问句 → 不沉淀', () => {
    assert.equal(decideConversationCapture('I started learning guitar this week', 'en').capture, true);
    assert.equal(decideConversationCapture('what is the weather today?', 'en').capture, false);
    assert.equal(decideConversationCapture('how do you make a flat white', 'en').capture, false);
  });

  it('英文助动词开头的陈述句（Codex 复审）→ 沉淀（不误当疑问）', () => {
    /* Will/May/Can/Do 开头但接专名/系动词（非代词）→ 陈述，应沉淀。 */
    for (const s of ['Will Smith is my favorite actor', 'May is my birth month', 'Can opener broke today', 'Do not disturb after 9pm']) {
      assert.equal(decideConversationCapture(s, 'en').capture, true, `「${s}」是陈述应沉淀`);
    }
  });

  it('英文无问号的助动词倒装疑问（Codex 复审 2）→ 不沉淀', () => {
    /* do you…/can you…/are you… 即使省略问号也是疑问，不沉淀（防英文用户省略问号污染记忆）。 */
    for (const s of ['do you remember me', 'can you help me with Python', 'would you keep this in mind', 'are you online']) {
      assert.equal(decideConversationCapture(s, 'en').capture, false, `「${s}」是疑问不应沉淀`);
    }
  });

  it('英文寒暄（含句尾标点，Codex 复审）→ 不沉淀', () => {
    for (const s of ['hi', 'hello!', 'thanks.', 'thank you!', 'got it.', 'ok', 'bye']) {
      assert.equal(decideConversationCapture(s, 'en').capture, false, `「${s}」是寒暄不应沉淀`);
    }
  });
});
