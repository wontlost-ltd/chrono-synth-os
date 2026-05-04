/**
 * 单元测试：PersonaPromptBuilder（P1-C）
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PersonaPromptBuilder } from '../../conversation/persona-prompt-builder.js';

const builder = new PersonaPromptBuilder();

describe('PersonaPromptBuilder', () => {
  it('build 拼装 system 包含 narrative + 输出要求', () => {
    const out = builder.build({
      narrative: '我是客服',
      boundaries: [],
      relevantKnowledge: [],
      history: [],
      userInput: '你好',
    });
    assert.match(out.system, /# 角色\n+我是客服/);
    assert.match(out.system, /# 输出要求/);
  });

  it('build narrative 为空时使用默认值', () => {
    const out = builder.build({
      narrative: '   ',
      boundaries: [],
      relevantKnowledge: [],
      history: [],
      userInput: 'x',
    });
    assert.match(out.system, /我是一个企业岗位人格/);
  });

  it('build 按 rule 分组渲染 boundaries', () => {
    const out = builder.build({
      narrative: '客服',
      boundaries: [
        { rule: 'never_discuss', topic: '竞品价格' },
        { rule: 'always_escalate', topic: '退款超过 ¥5000' },
        { rule: 'require_confirmation', topic: '修改账户' },
        { rule: 'never_discuss', topic: '内部架构' },
      ],
      relevantKnowledge: [],
      history: [],
      userInput: 'x',
    });
    assert.match(out.system, /绝不讨论以下主题：.*"竞品价格".*"内部架构"/s);
    assert.match(out.system, /立即升级人工：.*"退款超过 ¥5000"/);
    assert.match(out.system, /必须先获得人类确认：.*"修改账户"/);
  });

  it('build 包含相关知识片段且截断超长内容', () => {
    const longContent = 'A'.repeat(3000);
    const out = builder.build({
      narrative: 'engineer',
      boundaries: [],
      relevantKnowledge: [
        { id: 'k1', title: 'Runbook A', content: longContent, relevance: 0.9 },
      ],
      history: [],
      userInput: 'x',
    });
    assert.match(out.system, /# 可参考的知识/);
    assert.match(out.system, /\[Runbook A\]/);
    /* 截断到 2000 字符 + 标题等结构 */
    const knowledgeSection = out.system.split('# 可参考的知识')[1];
    assert.ok(knowledgeSection.length < longContent.length);
  });

  it('build 把 history 转为 messages，user 输入追加在末尾', () => {
    const out = builder.build({
      narrative: 'x',
      boundaries: [],
      relevantKnowledge: [],
      history: [
        { role: 'user', content: '上一个问题' },
        { role: 'assistant', content: '上一个回答' },
      ],
      userInput: '新问题',
    });
    assert.equal(out.messages.length, 3);
    assert.equal(out.messages[0].role, 'user');
    assert.equal(out.messages[0].content, '上一个问题');
    assert.equal(out.messages[2].role, 'user');
    assert.equal(out.messages[2].content, '新问题');
  });

  it('build 没有 boundaries 时不输出该段落', () => {
    const out = builder.build({
      narrative: 'x',
      boundaries: [],
      relevantKnowledge: [],
      history: [],
      userInput: 'y',
    });
    assert.doesNotMatch(out.system, /# 行为约束/);
  });
});
