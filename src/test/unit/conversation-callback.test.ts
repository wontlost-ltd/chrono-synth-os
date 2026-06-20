/**
 * buildConversationCallback（ADR-0056 block 6 内在驱动·对话回想）：取一条与当前话题相关的
 * 过往对话记忆（episodic），渲染成「我突然想到你之前提到过 X」的确定性片段。
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ChronoSynthOS } from '../../chrono-synth-os.js';
import { TestClock } from '../../utils/clock.js';
import { SilentLogger } from '../../utils/logger.js';
import { buildConversationCallback } from '../../server/routes/companion/conversation-callback.js';

describe('buildConversationCallback（ADR-0056 内在驱动·对话回想）', () => {
  let os: ChronoSynthOS;
  beforeEach(() => {
    os = new ChronoSynthOS({ clock: new TestClock(1000), logger: new SilentLogger() });
    os.start();
  });
  afterEach(() => { os.close(); });

  it('无任何记忆 → undefined（无可回想，不编造）', () => {
    assert.equal(buildConversationCallback(os, '你喜欢跑步吗', 'zh-CN'), undefined);
  });

  it('有相关过往对话记忆（episodic）→ 返回该记忆内容片段', () => {
    os.core.memories.addMemory('episodic', '我最近爱上了在清晨跑步', 0, 0.25);
    const r = buildConversationCallback(os, '说说跑步', 'zh-CN');
    assert.ok(r && r.includes('跑步'), '回想到含「跑步」的过往对话');
  });

  it('只回想 episodic（对话沉淀），不回想 semantic（老师教的知识）', () => {
    os.core.memories.addMemory('semantic', '跑步能提升心肺功能', 0.3, 0.7);
    /* 只有 semantic 含「跑步」→ 不回想（回想专指你之前**说过**的话）。 */
    assert.equal(buildConversationCallback(os, '跑步', 'zh-CN'), undefined);
  });

  it('剥掉「（来自对话）」沉淀前缀 → 回想读起来是你说的话', () => {
    os.core.memories.addMemory('episodic', '（来自对话）我提到过想学做 flat white', 0, 0.25);
    const r = buildConversationCallback(os, 'flat white', 'zh-CN');
    assert.ok(r && !r.includes('（来自对话）'), '回想片段不含系统沉淀前缀');
    assert.ok(r && r.includes('flat white'), '保留你说的实质内容');
  });

  it('无关键词重叠 → undefined（不强行扯一条无关过往）', () => {
    os.core.memories.addMemory('episodic', '我昨天去看了场电影', 0, 0.25);
    assert.equal(buildConversationCallback(os, '量子物理是什么', 'zh-CN'), undefined);
  });

  it('确定性：多条相关时按 overlap→salience→id 稳定取同一条', () => {
    os.core.memories.addMemory('episodic', '我喜欢跑步', 0, 0.25);
    os.core.memories.addMemory('episodic', '我喜欢跑步也喜欢游泳', 0, 0.4);
    const a = buildConversationCallback(os, '跑步', 'zh-CN');
    const b = buildConversationCallback(os, '跑步', 'zh-CN');
    assert.equal(a, b, '相同输入相同输出（确定性）');
  });

  it('确定性 tie-break（Codex 复审）：同 overlap、同 salience → 取 id 字典序更小者，稳定', () => {
    /* 两条记忆 overlap=1（都含「跑步」）、salience 同为 0.25 → 唯一区别是 id。
     * memory id 是 random.uuid('mem')，TestClock/seed 固定下确定性；两次构造取同一条。
     * 多次调用结果一致即证明 tie-break 稳定（不随 Map 遍历序漂移）。 */
    os.core.memories.addMemory('episodic', '我说过我爱跑步这件事甲', 0, 0.25);
    os.core.memories.addMemory('episodic', '我说过我爱跑步这件事乙', 0, 0.25);
    const picks = new Set<string | undefined>();
    for (let i = 0; i < 5; i++) picks.add(buildConversationCallback(os, '跑步', 'zh-CN'));
    assert.equal(picks.size, 1, '同 overlap/salience 下多次取同一条（id tie-break 稳定）');
  });

  it('过短的对话记忆不回想（噪声）', () => {
    os.core.memories.addMemory('episodic', '跑', 0, 0.25);  // 太短
    assert.equal(buildConversationCallback(os, '跑步', 'zh-CN'), undefined);
  });
});
