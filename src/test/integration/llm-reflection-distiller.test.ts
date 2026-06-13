/**
 * LLM 反思蒸馏器（ADR-0047 growth 档）：让人格不靠 marketplace 也能成长。
 *
 * 走真实 ChronoSynthOS 的 DistillationService（真实门 + compiler），用 stub LLM 注入提案。
 * 证明：合法提案过门产候选；幻觉提案（不存在 valueId/memoryId、越界 delta）被硬校验丢弃，
 * 绝不污染内核。
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ChronoSynthOS } from '../../chrono-synth-os.js';
import { TestClock, SilentLogger } from '../../utils/index.js';
import { LlmReflectionDistiller, type ReflectMemory, type ReflectValue } from '../../intelligence/llm-reflection-distiller.js';
import type { LLMProvider, ChatResponse } from '../../intelligence/llm-provider.js';

/** stub LLM：chat 返回预设 JSON；embed 不用。 */
function stubLlm(json: unknown): LLMProvider {
  return {
    chat: async (): Promise<ChatResponse> => ({ content: JSON.stringify(json) }),
    embed: async () => [],
  };
}

describe('LLM 反思蒸馏器（ADR-0047 growth 档）', () => {
  let os: ChronoSynthOS;

  beforeEach(() => {
    os = new ChronoSynthOS({ clock: new TestClock(1000), logger: new SilentLogger() });
    os.start();
  });
  afterEach(() => os.close());

  function seed(): { values: ReflectValue[]; memories: ReflectMemory[] } {
    const v = os.core.addValue('探索', 0.5);
    const m1 = os.core.addMemory('episodic', '读了一篇关于持续学习的文章', 0.6, 0.9);
    const m2 = os.core.addMemory('episodic', '完成了一次有挑战的分析', 0.7, 0.8);
    return {
      values: [{ id: v.id, label: '探索', weight: 0.5 }],
      memories: [
        { id: m1.id, content: '读了一篇关于持续学习的文章', salience: 0.9, valence: 0.6 },
        { id: m2.id, content: '完成了一次有挑战的分析', salience: 0.8, valence: 0.7 },
      ],
    };
  }

  it('合法提案：value_shift（valueId 真实、delta ≤0.05）过门产候选', async () => {
    const { values, memories } = seed();
    const llm = stubLlm({ valueShift: { valueId: values[0].id, delta: 0.04, reason: '持续学习强化探索' } });
    const distiller = new LlmReflectionDistiller(os.distillation, llm, new SilentLogger());

    const res = await distiller.distill({ personaId: 'default', narrative: '我在探索', values, memories });
    assert.ok(res.candidatesIngested >= 1, '应产出 value_shift 候选');
    const vs = res.results.find((r) => r.status === 'compiled' || r.status === 'pending');
    assert.ok(vs, 'value_shift 应进门（compiled 或 pending）');
  });

  it('幻觉防护：不存在的 valueId → 丢弃，不产候选', async () => {
    const { values, memories } = seed();
    const llm = stubLlm({ valueShift: { valueId: 'val_does_not_exist', delta: 0.04, reason: 'x' } });
    const distiller = new LlmReflectionDistiller(os.distillation, llm, new SilentLogger());
    const res = await distiller.distill({ personaId: 'default', narrative: 'n', values, memories });
    assert.equal(res.candidatesIngested, 0, '幻觉 valueId 应被硬校验丢弃');
  });

  it('幻觉防护：越界 delta（>0.05）被封顶到 0.05（不被原样放大）', async () => {
    const { values, memories } = seed();
    /* LLM 提一个夸张 delta=0.5；distiller 应封顶到 0.05。 */
    const llm = stubLlm({ valueShift: { valueId: values[0].id, delta: 0.5, reason: 'x' } });
    const distiller = new LlmReflectionDistiller(os.distillation, llm, new SilentLogger());
    const res = await distiller.distill({ personaId: 'default', narrative: 'n', values, memories });
    /* 候选产出了（封顶后 delta=0.05 合法），但权重只升了 0.05 而非 0.5。 */
    assert.ok(res.candidatesIngested >= 1);
    const w = os.core.values.getAll().get(values[0].id)!.weight;
    assert.ok(w <= 0.55 + 1e-9, `权重最多升到 0.55（封顶），实际 ${w}`);
  });

  it('幻觉防护：memory_edge 指向不存在记忆 → 丢弃', async () => {
    const { values, memories } = seed();
    const llm = stubLlm({ memoryLink: { sourceId: memories[0].id, targetId: 'mem_ghost', relation: 'related' } });
    const distiller = new LlmReflectionDistiller(os.distillation, llm, new SilentLogger());
    const res = await distiller.distill({ personaId: 'default', narrative: 'n', values, memories });
    assert.equal(res.candidatesIngested, 0, '指向幻觉记忆的边应被丢弃');
  });

  it('合法 memory_edge（两端真实且不同）→ 过门编译（confidence 0.8≥0.75 ∧ 3 证据≥2 满足自动编译门）', async () => {
    const { values, memories } = seed();
    const llm = stubLlm({ memoryLink: { sourceId: memories[0].id, targetId: memories[1].id, relation: '关联' } });
    const distiller = new LlmReflectionDistiller(os.distillation, llm, new SilentLogger());
    const res = await distiller.distill({ personaId: 'default', narrative: 'n', values, memories });
    assert.equal(res.candidatesIngested, 1);
    /* memory_edge 自动编译门 = confidence≥0.75 ∧ evidenceCount≥2；本例 0.8 + 3 证据满足 → compiled。
     * 仅链接两条真实记忆，安全可自动应用（与 narrative/rule 这类改「我是谁」的保守审批不同）。 */
    assert.equal(res.results[0].status, 'compiled', '充分证据的 memory_edge 满足自动编译门');
  });

  it('安全降级：LLM 抛错 / JSON 畸形 → 未产候选，不抛进主流程', async () => {
    const { values, memories } = seed();
    const throwing: LLMProvider = { chat: async () => { throw new Error('llm down'); }, embed: async () => [] };
    const d1 = new LlmReflectionDistiller(os.distillation, throwing, new SilentLogger());
    assert.equal((await d1.distill({ personaId: 'default', narrative: 'n', values, memories })).candidatesIngested, 0);

    /* JSON 畸形 content */
    const badLlm: LLMProvider = { chat: async () => ({ content: '{not valid' }), embed: async () => [] };
    const d2 = new LlmReflectionDistiller(os.distillation, badLlm, new SilentLogger());
    assert.equal((await d2.distill({ personaId: 'default', narrative: 'n', values, memories })).candidatesIngested, 0);
  });

  it('空记忆/空价值 → 跳过（不强行成长）', async () => {
    const llm = stubLlm({ valueShift: { valueId: 'v', delta: 0.04 } });
    const distiller = new LlmReflectionDistiller(os.distillation, llm, new SilentLogger());
    const res = await distiller.distill({ personaId: 'default', narrative: 'n', values: [], memories: [] });
    assert.equal(res.candidatesIngested, 0);
  });
});
