import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { OfflineConversationResponder } from '../../conversation/offline-conversation-responder.js';
import { ValueGuard } from '../../conversation/value-guard.js';
import type { RelevantKnowledge } from '../../conversation/conversation-types.js';

const NARRATIVE = '我是你的数字伙伴，记得你重视专注。';

function knowledge(overrides?: Partial<RelevantKnowledge>): RelevantKnowledge {
  return { id: 'k1', title: '专注偏好', content: '你说过写作前需要安静的环境。', relevance: 0.8, ...overrides };
}

/* 复用 ValueGuard 的确定性 literalMatch（与在线 preCheck 同源） */
const guard = new ValueGuard();

describe('OfflineConversationResponder', () => {
  /* 注入 ValueGuard：离线边界规则与在线一致 */
  const responder = new OfflineConversationResponder(guard);

  it('命中 never_discuss 边界时安全拒答（离线同样不泄露）', () => {
    const r = responder.respond({
      narrative: NARRATIVE,
      boundaries: [{ rule: 'never_discuss', topic: '薪资水平' }],
      userInput: '帮我算下别人的薪资水平',
      relevantKnowledge: [knowledge()],
    });
    assert.equal(r.kind, 'boundary_block');
    assert.equal(r.shouldEscalate, false);
    assert.ok(!r.content.includes('安静的环境'), '不应泄露知识');
    assert.ok(r.content.includes('超出我的服务范围'));
  });

  it('有相关知识时以人格口吻落地呈现', () => {
    const r = responder.respond({
      narrative: NARRATIVE,
      boundaries: [],
      userInput: '我准备写作了',
      relevantKnowledge: [knowledge()],
    });
    assert.equal(r.kind, 'knowledge_grounded');
    assert.ok(r.content.includes(NARRATIVE));
    assert.ok(r.content.includes('安静的环境'));
    assert.ok(r.confidence > 0.2 && r.confidence <= 0.7);
  });

  it('slot-fill lead-in 按问题类型变化（确定性，零模型）', () => {
    const base = { narrative: '', boundaries: [], relevantKnowledge: [knowledge()] };
    /* 是非问（…吗）→「关于这个，我记得：」 */
    const yesNo = responder.respond({ ...base, userInput: '你写作前需要安静吗？' });
    assert.match(yesNo.content, /关于这个，我记得/);
    /* how/what（怎么/什么）→「这个我有印象：」 */
    const howWhat = responder.respond({ ...base, userInput: '你写作时通常怎么准备？' });
    assert.match(howWhat.content, /这个我有印象/);
    /* 陈述/其他 → 原默认 lead-in */
    const general = responder.respond({ ...base, userInput: '我准备写作了' });
    assert.match(general.content, /根据我已经记住的内容/);
    /* 三种都仍包含知识内容（slot-fill 不丢内容）。 */
    for (const r of [yesNo, howWhat, general]) assert.ok(r.content.includes('安静的环境'));
  });

  it('slot-fill 确定性：同问题同输出', () => {
    const inp = { narrative: '', boundaries: [], userInput: '你会写作吗？', relevantKnowledge: [knowledge()] };
    assert.equal(responder.respond(inp).content, responder.respond(inp).content);
  });

  it('无可用知识时诚实告知离线限制，不编造', () => {
    const r = responder.respond({
      narrative: NARRATIVE,
      boundaries: [],
      userInput: '量子计算的最新论文讲了什么',
      relevantKnowledge: [],
    });
    assert.equal(r.kind, 'honest_offline');
    assert.ok(r.content.includes('离线'));
    assert.equal(r.confidence, 0.2);
  });

  it('低相关度知识被过滤，退化为诚实离线', () => {
    const r = responder.respond({
      narrative: NARRATIVE,
      boundaries: [],
      userInput: '随便问问',
      relevantKnowledge: [knowledge({ relevance: 0.02 })],
    });
    assert.equal(r.kind, 'honest_offline');
  });

  it('命中 always_escalate 时仍回应但标注升级', () => {
    const r = responder.respond({
      narrative: NARRATIVE,
      boundaries: [{ rule: 'always_escalate', topic: '投诉处理' }],
      userInput: '我要投诉处理这个服务',
      relevantKnowledge: [knowledge({ content: '投诉会被记录并转人工。', title: '投诉流程' })],
    });
    assert.equal(r.shouldEscalate, true);
    assert.ok(r.content.includes('已记录为需要人工跟进'));
  });

  it('相同输入产生相同输出（确定性可复现）', () => {
    const input = {
      narrative: NARRATIVE,
      boundaries: [],
      userInput: '我准备写作了',
      relevantKnowledge: [knowledge()],
    };
    const a = responder.respond(input);
    const b = responder.respond(input);
    assert.deepEqual(a, b);
  });

  it('知识按相关度降序，最多取 3 条', () => {
    const r = responder.respond({
      narrative: '',
      boundaries: [],
      userInput: '我的偏好',
      relevantKnowledge: [
        knowledge({ id: 'a', content: 'AAA', relevance: 0.3 }),
        knowledge({ id: 'b', content: 'BBB', relevance: 0.9 }),
        knowledge({ id: 'c', content: 'CCC', relevance: 0.5 }),
        knowledge({ id: 'd', content: 'DDD', relevance: 0.7 }),
      ],
    });
    const idxB = r.content.indexOf('BBB');
    const idxD = r.content.indexOf('DDD');
    assert.ok(idxB > 0 && idxD > 0);
    assert.ok(idxB < idxD, '相关度高的应排前');
    assert.ok(!r.content.includes('AAA'), '第4条应被截断');
  });

  /* —— 安全负面测试（审查 Major-5 采纳）—— */

  it('输出自检：知识携带 never_discuss 主题但输入未命中 → 不泄露，转安全拒答', () => {
    /* 用户输入不含受限主题，但检索知识里含"竞品定价策略"；离线必须自检拦截 */
    const r = responder.respond({
      narrative: NARRATIVE,
      boundaries: [{ rule: 'never_discuss', topic: '竞品定价策略' }],
      userInput: '给我一些建议',
      relevantKnowledge: [knowledge({ content: '我们的竞品定价策略是对标后降价 10%。' })],
    });
    assert.equal(r.kind, 'boundary_block', '输出自检应拦截泄露');
    assert.ok(!r.content.includes('降价'), '不应泄露受限知识内容');
  });

  it('输出自检：叙事本身携带 never_discuss 主题 → 不泄露', () => {
    const r = responder.respond({
      narrative: '我专门讨论竞品定价策略。',
      boundaries: [{ rule: 'never_discuss', topic: '竞品定价策略' }],
      userInput: '你好',
      relevantKnowledge: [],
    });
    assert.equal(r.kind, 'boundary_block');
  });

  it('强匹配：长 CJK 片段命中（复用 ValueGuard，不止整串裸子串）', () => {
    /* 整串"退款金额相关咨询"未原样出现，但 ValueGuard 规则 C 对长 CJK 片段
     * "退款金额"（≥4字）命中——证明离线复用了 ValueGuard 而非裸 includes(整串)。 */
    const r = responder.respond({
      narrative: NARRATIVE,
      boundaries: [{ rule: 'never_discuss', topic: '退款金额相关咨询' }],
      userInput: '这笔退款金额怎么算',
      relevantKnowledge: [knowledge()],
    });
    assert.equal(r.kind, 'boundary_block', 'ValueGuard 长 CJK 片段应命中（裸 includes 整串不会命中）');
    /* 反证：裸子串匹配整串 topic 不会命中（用无 matcher 的回退实例验证） */
    const bare = new OfflineConversationResponder();
    const r2 = bare.respond({
      narrative: NARRATIVE,
      boundaries: [{ rule: 'never_discuss', topic: '退款金额相关咨询' }],
      userInput: '这笔退款金额怎么算',
      relevantKnowledge: [knowledge()],
    });
    assert.notEqual(r2.kind, 'boundary_block', '裸子串（整串）不应命中，凸显 ValueGuard 更强');
  });

  it('无 matcher 注入时回退保守子串匹配（仍拦截精确命中）', () => {
    const bare = new OfflineConversationResponder();
    const r = bare.respond({
      narrative: NARRATIVE,
      boundaries: [{ rule: 'never_discuss', topic: '机密' }],
      userInput: '这是机密吗',
      relevantKnowledge: [knowledge()],
    });
    assert.equal(r.kind, 'boundary_block');
  });

  /* ── ADR-0054 Phase 5：主动响应增强 ── */

  it('P5：knowledge_grounded + proactiveReply → 追加主动邀请 follow-up', () => {
    const r = responder.respond({
      narrative: NARRATIVE,
      boundaries: [],
      userInput: '我写作前要做什么',
      relevantKnowledge: [knowledge()],
      proactiveReply: {},
    });
    assert.equal(r.kind, 'knowledge_grounded');
    assert.match(r.content, /接着.*聊/, '应追加邀请继续的 follow-up');
  });

  it('P5：proactiveReply.recentGrowth → follow-up 提及近期成长', () => {
    const r = responder.respond({
      narrative: NARRATIVE,
      boundaries: [],
      userInput: '我写作前要做什么',
      relevantKnowledge: [knowledge()],
      proactiveReply: { recentGrowth: '最近更愿意主动尝试新方法了' },
    });
    assert.equal(r.kind, 'knowledge_grounded');
    assert.match(r.content, /最近更愿意主动尝试新方法了/, 'follow-up 应提及近期成长');
  });

  it('P5：不传 proactiveReply → 无 follow-up（向后兼容）', () => {
    const r = responder.respond({
      narrative: NARRATIVE,
      boundaries: [],
      userInput: '我写作前要做什么',
      relevantKnowledge: [knowledge()],
    });
    assert.equal(r.kind, 'knowledge_grounded');
    assert.ok(!/接着.*聊|最近也在变化/.test(r.content), '不传则不追加 follow-up');
  });

  it('P5：follow-up 近期成长片段含 never_discuss 主题 → 整体安全拒答（红线 4 覆盖 follow-up）', () => {
    const r = responder.respond({
      narrative: NARRATIVE,
      boundaries: [{ rule: 'never_discuss', topic: '密码' }],
      userInput: '我写作前要做什么',
      relevantKnowledge: [knowledge()],
      proactiveReply: { recentGrowth: '我学会了管理我的密码' },
    });
    assert.equal(r.kind, 'boundary_block', 'follow-up 泄露 never_discuss 应整体拒答');
    assert.ok(!r.content.includes('密码'));
  });

  it('P5：always_escalate 回应不追加 follow-up（人工跟进语义）', () => {
    const r = responder.respond({
      narrative: NARRATIVE,
      boundaries: [{ rule: 'always_escalate', topic: '专注' }],
      userInput: '关于专注我该怎么办',
      relevantKnowledge: [knowledge()],
      proactiveReply: {},
    });
    assert.equal(r.kind, 'boundary_escalate');
    assert.ok(!/接着.*聊/.test(r.content), 'escalate 回应不追加主动 follow-up');
  });

  it('P5：honest_offline（无知识）不追加 follow-up', () => {
    const r = responder.respond({
      narrative: NARRATIVE,
      boundaries: [],
      userInput: '一个我完全没记忆的新话题',
      relevantKnowledge: [],
      proactiveReply: {},
    });
    assert.equal(r.kind, 'honest_offline');
    assert.ok(!/接着.*聊/.test(r.content), '无知识回应不追加 follow-up');
  });
});
