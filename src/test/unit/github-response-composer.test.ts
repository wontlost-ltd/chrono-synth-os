/**
 * 单元测试：GitHubResponseComposer（Plan 3 唯一的新领域逻辑）。
 *
 * 起草段：基于数字人已学的 GitHub 记忆 + 一个 issue/PR 上下文，零-LLM 确定性
 * 起草一条评论/review 草稿。复用 OfflineConversationResponder 的拼装模式
 * （narrative lead + top-3 grounded 记忆 + issue 上下文当 userInput）。
 *
 * 断言四条不变式：
 *   1. 有相关记忆 → knowledge_grounded，草稿含记忆内容 + issue 标题呼应；
 *   2. 无相关记忆 → honest_offline（不编造 review，数字人没学过就诚实说不知道）；
 *   3. 零-LLM 确定性：同输入跑两次 body 完全相同（纯函数，无 IO/无模型）；
 *   4. groundedCount 反映实际用到（拼进草稿）的记忆条数。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { composeGithubReply, type DraftInput } from '../../integrations/github/github-response-composer.js';
import type { RelevantKnowledge } from '../../conversation/conversation-types.js';

const NARRATIVE = '我是这个仓库的数字维护者，熟悉它的测试约定与错误处理风格。';

function knowledge(overrides?: Partial<RelevantKnowledge>): RelevantKnowledge {
  return {
    id: 'k1',
    title: '错误处理约定',
    content: '本仓库约定：所有对外接口在失败时返回结构化错误对象，禁止裸抛字符串。',
    relevance: 0.8,
    ...overrides,
  };
}

function baseInput(overrides?: Partial<DraftInput>): DraftInput {
  return {
    narrative: NARRATIVE,
    targetTitle: '接口失败时应如何返回错误？',
    targetBody: '我在实现新端点，不确定错误返回应该用什么格式。',
    targetType: 'issue',
    relevantKnowledge: [knowledge()],
    ...overrides,
  };
}

describe('GitHubResponseComposer', () => {
  it('有相关记忆 → knowledge_grounded，草稿含记忆内容 + issue 标题呼应', () => {
    const r = composeGithubReply(baseInput());
    assert.equal(r.kind, 'knowledge_grounded');
    /* 草稿落地已学记忆内容（不空泛）。 */
    assert.ok(r.body.includes('结构化错误对象'), '草稿应含记忆内容');
    /* 呼应 issue 标题（把标题当 userInput 拼进 lead-in / 上下文）。 */
    assert.ok(r.body.includes('接口失败时应如何返回错误'), '草稿应呼应 issue 标题');
    assert.ok(r.groundedCount >= 1);
  });

  it('无相关记忆 → honest_offline（不编造 review）', () => {
    const r = composeGithubReply(baseInput({ relevantKnowledge: [] }));
    assert.equal(r.kind, 'honest_offline');
    assert.equal(r.groundedCount, 0);
    /* 不编造记忆内容——诚实说没学过，不瞎写 review。 */
    assert.ok(!r.body.includes('结构化错误对象'), '无记忆时不应凭空出现记忆内容');
  });

  it('低相关度记忆被过滤 → honest_offline（不拿弱猜测当记忆）', () => {
    const r = composeGithubReply(
      baseInput({ relevantKnowledge: [knowledge({ relevance: 0.05 })] }),
    );
    assert.equal(r.kind, 'honest_offline');
    assert.equal(r.groundedCount, 0);
  });

  it('零-LLM 确定性：同输入跑两次 body 完全相同', () => {
    const input = baseInput({
      relevantKnowledge: [
        knowledge(),
        knowledge({ id: 'k2', title: '测试约定', content: '新增功能必须先写失败测试再实现。', relevance: 0.6 }),
      ],
    });
    const first = composeGithubReply(input);
    const second = composeGithubReply(input);
    assert.equal(first.body, second.body);
    assert.equal(first.kind, second.kind);
    assert.equal(first.groundedCount, second.groundedCount);
  });

  it('groundedCount 反映实际用到的记忆条数（达标计入，弱相关不计）', () => {
    const r = composeGithubReply(
      baseInput({
        relevantKnowledge: [
          knowledge({ id: 'a', relevance: 0.9 }),
          knowledge({ id: 'b', title: '测试约定', content: '新增功能必须先写失败测试再实现。', relevance: 0.7 }),
          knowledge({ id: 'c', title: '弱相关', content: '仓库里有一份历史迁移文档。', relevance: 0.03 }),
        ],
      }),
    );
    /* 两条达标（0.9/0.7）计入，弱相关 0.03 被过滤 → groundedCount=2。 */
    assert.equal(r.kind, 'knowledge_grounded');
    assert.equal(r.groundedCount, 2);
  });

  it('pull 类型同样能起草（targetType=pull 走同一确定性路径）', () => {
    const r = composeGithubReply(baseInput({ targetType: 'pull', targetTitle: '重构错误返回' }));
    assert.equal(r.kind, 'knowledge_grounded');
    assert.ok(r.body.includes('重构错误返回'));
  });
});
