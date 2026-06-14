/**
 * 感知蒸馏器（ADR-0051 Phase 1）：多模态「感官老师」作为不可信输入，经硬校验后沉淀为记忆/成长候选。
 *
 * 走真实 ChronoSynthOS 的 memory graph + DistillationService（真实门 + compiler），用 mock/scripted
 * PerceptionProvider 注入老师分析。证明：
 *   - 正常音频感知 → 事实进 memory graph（人格「听懂并记住」）；
 *   - 相邻事实 → memory_edge 候选过门；
 *   - 畸形老师分析（越界 valence/超长摘要/非法 kind）被丢弃，不污染记忆；
 *   - 身份层提案（value_shift / narrative_patch）→ 默认 pending 人工审批，绝不自动改核；
 *   - 老师抛错 / 空表征 → 安全降级，不抛进主流程；
 *   - 运行时仍 zero-LLM：感知只在摄取阶段调老师，沉淀后对话检索这些记忆不再调老师。
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ChronoSynthOS } from '../../chrono-synth-os.js';
import { TestClock, SilentLogger } from '../../utils/index.js';
import { PerceptionDistiller } from '../../perception/perception-distiller.js';
import { MockPerceptionProvider } from '../../perception/sources/mock-perception-provider.js';
import type { PerceptionProvider, PerceptionInput, PerceptionAnalysis } from '../../perception/perception-provider.js';

const MEDIA: PerceptionInput = {
  modality: 'audio',
  mediaSha256: 'a'.repeat(64),
  durationMs: 45_000,
  representation: '今天开会很累。但我没和别人说。回家路上想安静一会。',
};

/** scripted 老师：原样返回给定分析（驱动各分支）。 */
function scriptedProvider(analysis: PerceptionAnalysis): PerceptionProvider {
  return new MockPerceptionProvider({ scriptedAnalysis: analysis });
}

describe('感知蒸馏器（ADR-0051 Phase 1）', () => {
  let os: ChronoSynthOS;

  beforeEach(() => {
    os = new ChronoSynthOS({ clock: new TestClock(1000), logger: new SilentLogger() });
    os.start();
  });
  afterEach(() => os.close());

  it('正常音频感知：事实进 memory graph，人格「听懂并记住」', async () => {
    const before = os.core.memories.getMemoryCount();
    const distiller = new PerceptionDistiller(new MockPerceptionProvider(), os.core.memories, os.distillation, new SilentLogger());

    const res = await distiller.perceive({ personaId: 'default', tenantId: 'default', media: MEDIA });

    assert.ok(res.memoryIds.length >= 2, '应沉淀多条事实记忆');
    assert.equal(os.core.memories.getMemoryCount(), before + res.memoryIds.length, '记忆数应增加');
    /* 记忆内容是「人格视角」的事实摘要，不是冷标签。 */
    const node = os.core.memories.getMemory(res.memoryIds[0]);
    assert.ok(node && node.content.includes('我听到'), '记忆应是人格第一人称感知');
  });

  it('相邻事实 → memory_edge 候选过门（链接真实记忆）', async () => {
    const distiller = new PerceptionDistiller(new MockPerceptionProvider(), os.core.memories, os.distillation, new SilentLogger());
    const res = await distiller.perceive({ personaId: 'default', tenantId: 'default', media: MEDIA });
    const edges = res.candidates.filter((c) => c.status === 'compiled' || c.status === 'pending');
    assert.ok(edges.length >= 1, '应产出 memory_edge 候选并进门');
  });

  it('畸形老师分析：越界 valence / 超长摘要 / 非法 kind 被丢弃', async () => {
    const before = os.core.memories.getMemoryCount();
    const bad = scriptedProvider({
      confidence: 0.7,
      facts: [
        { summary: 'valence 越界', memoryKind: 'episodic', valence: 5, salience: 0.5 },          // valence>1 丢弃
        { summary: 'x'.repeat(600), memoryKind: 'episodic', valence: 0, salience: 0.5 },          // 超长丢弃
        // @ts-expect-error 故意非法 kind 测畸形
        { summary: '非法 kind', memoryKind: 'procedural', valence: 0, salience: 0.5 },             // kind 非法丢弃
        { summary: '唯一合法事实', memoryKind: 'episodic', valence: 0, salience: 0.5 },             // 仅此条入图
      ],
    });
    const distiller = new PerceptionDistiller(bad, os.core.memories, os.distillation, new SilentLogger());
    const res = await distiller.perceive({ personaId: 'default', tenantId: 'default', media: MEDIA });
    assert.equal(res.memoryIds.length, 1, '只有合法事实入图');
    assert.equal(os.core.memories.getMemoryCount(), before + 1);
  });

  it('身份提案 value_shift：默认 pending，绝不自动改核（感知单源 patternAgrees=false）', async () => {
    const v = os.core.addValue('独处', 0.5);
    const hinted = scriptedProvider({
      confidence: 0.9,
      facts: [{ summary: '我听到：想安静一会', memoryKind: 'episodic', valence: -0.2, salience: 0.6 }],
      identityHints: [{ kind: 'value_shift', valueId: v.id, delta: 0.5, reason: '反复在压力后需要独处' }],
    });
    const distiller = new PerceptionDistiller(hinted, os.core.memories, os.distillation, new SilentLogger());
    const res = await distiller.perceive({ personaId: 'default', tenantId: 'default', media: MEDIA });

    const vs = res.candidates.find((c) => (c.status === 'pending' || c.status === 'compiled'));
    assert.ok(vs && vs.status === 'pending', 'value_shift 必须 pending（感知单源不自动改核）');
    /* 核心 value 权重未变（没被自动编译）。 */
    assert.equal(os.core.values.getAll().get(v.id)!.weight, 0.5, '感知绝不自动改 value 权重');
  });

  it('身份提案 narrative_patch：默认 pending 人工审批', async () => {
    const hinted = scriptedProvider({
      confidence: 0.9,
      facts: [{ summary: '我听到：在弹钢琴', memoryKind: 'episodic', valence: 0.3, salience: 0.6 }],
      identityHints: [{ kind: 'narrative_patch', narrative: '我开始把自己看作一个会用音乐疗愈的人', reason: 'x' }],
    });
    const distiller = new PerceptionDistiller(hinted, os.core.memories, os.distillation, new SilentLogger());
    const res = await distiller.perceive({ personaId: 'default', tenantId: 'default', media: MEDIA });
    const np = res.candidates.find((c) => c.status === 'pending');
    assert.ok(np, 'narrative_patch 应 pending（改「我是谁」必人工审批）');
  });

  it('幻觉防护：value_shift（含不存在的 valueId）一律不自动编译进核', async () => {
    const hinted = scriptedProvider({
      confidence: 0.9,
      facts: [{ summary: '我听到：一些话', memoryKind: 'episodic', valence: 0, salience: 0.5 }],
      identityHints: [{ kind: 'value_shift', valueId: 'val_does_not_exist', delta: 0.03, reason: 'x' }],
    });
    const distiller = new PerceptionDistiller(hinted, os.core.memories, os.distillation, new SilentLogger());
    const res = await distiller.perceive({ personaId: 'default', tenantId: 'default', media: MEDIA });
    /* 感知 value_shift 因 patternAgrees=false 永不满足自动门 → 必 pending，绝不自动编译进核；
     * 幻觉 valueId 的最终拒绝发生在人工审批的 compiler 校验阶段（不在自动路径）。 */
    const compiled = res.candidates.find((c) => c.status === 'compiled');
    assert.equal(compiled, undefined, '感知 value_shift 绝不被自动编译进核（幻觉 valueId 也停在 pending）');
  });

  it('老师抛错 / 空表征：安全降级为空结果，不抛进主流程', async () => {
    const throwing: PerceptionProvider = {
      name: 'throwing',
      analyze: async () => { throw new Error('teacher down'); },
    };
    const d1 = new PerceptionDistiller(throwing, os.core.memories, os.distillation, new SilentLogger());
    const r1 = await d1.perceive({ personaId: 'default', tenantId: 'default', media: MEDIA });
    assert.deepEqual(r1.memoryIds, [], '老师抛错 → 空结果');
    assert.equal(r1.teacherFailed, true, '老师抛错 → teacherFailed=true（供审计记 failed 事件）');

    const d2 = new PerceptionDistiller(new MockPerceptionProvider(), os.core.memories, os.distillation, new SilentLogger());
    const r2 = await d2.perceive({ personaId: 'default', tenantId: 'default', media: { ...MEDIA, representation: '   ' } });
    assert.deepEqual(r2.memoryIds, [], '空表征 → 空结果');
    assert.equal(r2.teacherFailed, false, '空表征是正常无输入，非老师失败 → teacherFailed=false');
  });

  it('正常感知 → teacherFailed=false（即使没沉淀记忆也不算老师失败）', async () => {
    /* 老师成功返回但无有效事实：teacherFailed=false（区别于老师挂了）。 */
    const emptyFacts = new MockPerceptionProvider({ scriptedAnalysis: { confidence: 0.5, facts: [] } });
    const distiller = new PerceptionDistiller(emptyFacts, os.core.memories, os.distillation, new SilentLogger());
    const res = await distiller.perceive({ personaId: 'default', tenantId: 'default', media: MEDIA });
    assert.deepEqual(res.memoryIds, []);
    assert.equal(res.teacherFailed, false, '老师成功但无事实 → 非失败');
  });

  it('运行时 zero-LLM：感知沉淀后，记忆可被读取而无需再调老师', async () => {
    let analyzeCalls = 0;
    const counting: PerceptionProvider = {
      name: 'counting',
      analyze: async (input) => { analyzeCalls++; return new MockPerceptionProvider().analyze(input); },
    };
    const distiller = new PerceptionDistiller(counting, os.core.memories, os.distillation, new SilentLogger());
    const res = await distiller.perceive({ personaId: 'default', tenantId: 'default', media: MEDIA });
    assert.equal(analyzeCalls, 1, '感知阶段调老师一次');

    /* 之后读记忆（模拟对话检索引用）不再调老师。 */
    for (const id of res.memoryIds) os.core.memories.getMemory(id);
    assert.equal(analyzeCalls, 1, '读取已沉淀记忆不再调多模态老师（zero-LLM 运行时）');
  });
});
