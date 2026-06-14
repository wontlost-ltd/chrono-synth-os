/**
 * LLM 感官老师（LlmPerceptionProvider）：用 stub LLM 验证 JSON 解析 + 硬校验 + 畸形降级。
 *
 * 论点：LLM 输出整体不可信——provider 解析 + 校验，畸形条目丢弃；LLM 错/JSON 畸形抛错（由
 * PerceptionDistiller.analyzeSafe 降级）。身份层提案仍交蒸馏门（distiller 保证 pending）。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { LlmPerceptionProvider } from '../../perception/sources/llm-perception-provider.js';
import type { LLMProvider, ChatResponse } from '../../intelligence/llm-provider.js';
import type { PerceptionInput } from '../../perception/perception-provider.js';

/** stub LLM：chat 返回预设 content；embed 不用。 */
function stubLlm(content: string): LLMProvider {
  return { chat: async (): Promise<ChatResponse> => ({ content }), embed: async () => [] };
}

const MEDIA: PerceptionInput = { modality: 'audio', mediaSha256: 'a'.repeat(64), durationMs: 0, representation: '今天开会很累' };

describe('LLM 感官老师（LlmPerceptionProvider）', () => {
  it('解析合法 LLM JSON → 结构化 PerceptionAnalysis', async () => {
    const json = JSON.stringify({
      facts: [{ summary: '我听到：今天开会很累', memoryKind: 'episodic', valence: -0.3, salience: 0.7 }],
      identityHints: [{ kind: 'value_shift', valueId: 'val-1', delta: 0.03, reason: '反复压力' }],
      confidence: 0.8,
    });
    const provider = new LlmPerceptionProvider(stubLlm(json));
    const analysis = await provider.analyze(MEDIA);
    assert.equal(analysis.facts.length, 1);
    assert.equal(analysis.facts[0].summary, '我听到：今天开会很累');
    assert.equal(analysis.facts[0].memoryKind, 'episodic');
    assert.equal(analysis.identityHints?.length, 1);
    assert.equal(analysis.identityHints?.[0].kind, 'value_shift');
    assert.equal(analysis.confidence, 0.8);
  });

  it('硬校验：畸形 fact 条目（越界 valence/缺 summary）被丢弃', async () => {
    const json = JSON.stringify({
      facts: [
        { summary: '合法', memoryKind: 'episodic', valence: 0, salience: 0.5 },
        { summary: '越界 valence', memoryKind: 'episodic', valence: 5, salience: 0.5 },   // 丢
        { memoryKind: 'episodic', valence: 0, salience: 0.5 },                              // 缺 summary 丢
        { summary: 'x'.repeat(600), memoryKind: 'episodic', valence: 0, salience: 0.5 },    // 超长丢
      ],
      confidence: 0.7,
    });
    const provider = new LlmPerceptionProvider(stubLlm(json));
    const analysis = await provider.analyze(MEDIA);
    assert.equal(analysis.facts.length, 1, '只保留合法 fact');
    assert.equal(analysis.facts[0].summary, '合法');
  });

  it('硬校验：非法 memoryKind 丢弃整条（不洗白成 episodic）', async () => {
    const json = JSON.stringify({
      facts: [
        { summary: '合法 episodic', memoryKind: 'episodic', valence: 0, salience: 0.5 },
        { summary: '非法 kind', memoryKind: 'procedural', valence: 0, salience: 0.5 },   // 丢弃（不洗白）
        { summary: '缺 kind', valence: 0, salience: 0.5 },                                 // 丢弃
        { summary: 'kind 是数字', memoryKind: 123, valence: 0, salience: 0.5 },            // 丢弃
      ],
      confidence: 0.7,
    });
    const provider = new LlmPerceptionProvider(stubLlm(json));
    const analysis = await provider.analyze(MEDIA);
    assert.equal(analysis.facts.length, 1, '非法 memoryKind 整条丢弃，不洗白');
    assert.equal(analysis.facts[0].summary, '合法 episodic');
  });

  it('硬校验：畸形 identityHint（缺 valueId/缺 narrative）被丢弃', async () => {
    const json = JSON.stringify({
      facts: [{ summary: 'x', memoryKind: 'episodic', valence: 0, salience: 0.5 }],
      identityHints: [
        { kind: 'value_shift', delta: 0.03, reason: 'r' },               // 缺 valueId 丢
        { kind: 'narrative_patch', reason: 'r' },                         // 缺 narrative 丢
        { kind: 'value_shift', valueId: 'v1', delta: 0.02, reason: 'r' }, // 合法
      ],
      confidence: 0.7,
    });
    const provider = new LlmPerceptionProvider(stubLlm(json));
    const analysis = await provider.analyze(MEDIA);
    assert.equal(analysis.identityHints?.length, 1, '只保留合法 hint');
    assert.equal(analysis.identityHints?.[0].kind, 'value_shift');
  });

  it('LLM 返回非 JSON → 抛错（由 distiller 降级）', async () => {
    const provider = new LlmPerceptionProvider(stubLlm('这不是 JSON 只是闲聊'));
    await assert.rejects(() => provider.analyze(MEDIA), /非法 JSON/);
  });

  it('confidence 缺失/非法 → 缺省 0.6', async () => {
    const json = JSON.stringify({ facts: [{ summary: 'x', memoryKind: 'episodic', valence: 0, salience: 0.5 }] });
    const provider = new LlmPerceptionProvider(stubLlm(json));
    const analysis = await provider.analyze(MEDIA);
    assert.equal(analysis.confidence, 0.6);
  });

  it('maxFacts 截断', async () => {
    const facts = Array.from({ length: 10 }, (_, i) => ({ summary: `f${i}`, memoryKind: 'episodic', valence: 0, salience: 0.5 }));
    const provider = new LlmPerceptionProvider(stubLlm(JSON.stringify({ facts, confidence: 0.7 })));
    const analysis = await provider.analyze(MEDIA, { maxFacts: 3 });
    assert.equal(analysis.facts.length, 3);
  });
});
