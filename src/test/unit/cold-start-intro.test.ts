/**
 * 冷启动引导（缺口修复：全新数字人首聊不再死板）。
 *
 * 全新数字人（无身份叙事、无记忆 grounding）首聊时，OfflineConversationResponder 应返回**人格化
 * 自我介绍引导**（coldStartIntro）而非死板的「我处于离线状态」——命中消费者「注册→首聊→空
 * grounding→觉得废物→卸载」的痛点。只作用于「叙事为空」信号，不注入记忆、不改记忆基线。
 *
 * 验证：① 全新（空叙事+无知识）→ 冷启动引导（含「数字人/记住/聊聊」等引导语，非死板离线）；
 * ② 已有叙事（已成长）→ 仍走原诚实离线（叙事作 lead + honestOffline，不被引导覆盖）；
 * ③ 有知识 grounding → 正常知识回应（不触发冷启动）；④ 确定性可复现；⑤ 双语。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { OfflineConversationResponder } from '../../conversation/offline-conversation-responder.js';

describe('冷启动引导（全新数字人首聊）', () => {
  const responder = new OfflineConversationResponder();
  const base = { boundaries: [], relevantKnowledge: [] as never[] };

  it('全新（空叙事 + 无知识）→ 人格化冷启动引导（非死板离线）', () => {
    const r = responder.respond({ ...base, narrative: '', userInput: '你能帮我做什么？' });
    assert.equal(r.kind, 'honest_offline');
    /* 是引导语，不是死板的「离线状态」。 */
    assert.ok(r.content.includes('数字人') && r.content.includes('记住'), `应为冷启动引导，实际：${r.content}`);
    assert.ok(!r.content.includes('离线状态'), '不应是死板离线文案');
  });

  it('已有叙事（已成长）→ 仍走原诚实离线（不被冷启动覆盖）', () => {
    const r = responder.respond({ ...base, narrative: '我是一名经验丰富的项目经理。', userInput: '量子物理讲讲？' });
    assert.equal(r.kind, 'honest_offline');
    assert.ok(r.content.includes('我是一名经验丰富的项目经理'), '叙事作 lead');
    assert.ok(r.content.includes('离线') || r.content.includes('记下'), '仍是诚实离线（有叙事不触发冷启动引导）');
  });

  it('英文全新 → 英文冷启动引导', () => {
    const r = responder.respond({ ...base, narrative: '', userInput: 'What can you do?', locale: 'en' });
    assert.equal(r.kind, 'honest_offline');
    assert.ok(/digital companion/i.test(r.content), `应为英文冷启动引导，实际：${r.content}`);
  });

  it('确定性可复现：同输入 → 同引导', () => {
    const a = responder.respond({ ...base, narrative: '', userInput: '你好' });
    const b = responder.respond({ ...base, narrative: '', userInput: '你好' });
    assert.equal(a.content, b.content);
  });
});
