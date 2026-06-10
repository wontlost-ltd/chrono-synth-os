/**
 * 真实形态 provider 输出 — 畸形输入 regression corpus（WP-3 T3.1）。
 *
 * 命名诚实（Codex WP-3 复审）：这是**分支导向的畸形样例表（branch-oriented fuzz corpus）**，
 * 不是随机/property-based fuzz。validateArtifact 是有限分支纯函数，手写 corpus 在此更可读、可诊断、
 * 稳定；逐条对准它的每个校验分支 + 每个 artifact kind 的 payload 形态。
 *
 * LLM 教师输出是**不可信输入**：可能畸形 JSON、缺字段、幻觉 evidence、越界数值、schema 漂移。
 * 不变量（ADR-0047 D3）：这些输入经 DistillationService.ingest 的 validateArtifact 门后，
 * 必须**优雅降级**（status='rejected'），且**绝不把脏数据写进确定性内核**——这里用 core.getState()
 * 全量指纹（values/memories/edges/narrative/decisionStyle/cognitiveModel）断言零脏写，覆盖所有内核落点，
 * 而非仅 value store（Codex WP-3 复审：patch 类 kind 落 narrative/认知模型等其他面）。
 *
 * 本测试走真实 ChronoSynthOS（真实 DB、真实门控、真实 compiler），不是 mock——以贴近真实形态。
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ChronoSynthOS } from '../../chrono-synth-os.js';
import { TestClock, SilentLogger } from '../../utils/index.js';
import type { CandidateInput } from '../../intelligence/distillation-service.js';
import { deepStringify } from '../../storage/serialization.js';
import type { ArtifactEvidence } from '@chrono/kernel';

const PERSONA = 'default';
const goodEvidence: ArtifactEvidence[] = [{ type: 'memory', id: 'm1', score: 0.9 }];

/** 一批畸形/恶意候选（覆盖：缺字段、越界、幻觉类型、错配 delta、空 evidence、错 payload 形态）。
 * 每条都应被门拒绝（rejected），且不改内核。`as` 故意绕过类型以模拟运行期不可信输入。 */
const MALFORMED_CANDIDATES: Array<{ name: string; input: CandidateInput }> = [
  {
    name: 'confidence 越界 (>1)',
    input: { kind: 'value_shift', source: 'conversation', confidence: 1.7, evidence: goodEvidence,
      payload: { valueId: 'v', currentWeight: 0.5, suggestedWeight: 0.55, delta: 0.05, patternAgrees: true } },
  },
  {
    name: 'confidence NaN',
    input: { kind: 'value_shift', source: 'conversation', confidence: NaN, evidence: goodEvidence,
      payload: { valueId: 'v', currentWeight: 0.5, suggestedWeight: 0.55, delta: 0.05, patternAgrees: true } },
  },
  {
    name: 'evidence 为空数组（无证据的幻觉）',
    input: { kind: 'value_shift', source: 'conversation', confidence: 0.9, evidence: [],
      payload: { valueId: 'v', currentWeight: 0.5, suggestedWeight: 0.55, delta: 0.05, patternAgrees: true } },
  },
  {
    name: 'evidence score 越界',
    input: { kind: 'value_shift', source: 'conversation', confidence: 0.9,
      evidence: [{ type: 'memory', id: 'm', score: 9 } as ArtifactEvidence],
      payload: { valueId: 'v', currentWeight: 0.5, suggestedWeight: 0.55, delta: 0.05, patternAgrees: true } },
  },
  {
    name: 'evidence 幻觉类型',
    input: { kind: 'value_shift', source: 'conversation', confidence: 0.9,
      evidence: [{ type: 'hallucination', id: 'm', score: 0.5 } as unknown as ArtifactEvidence],
      payload: { valueId: 'v', currentWeight: 0.5, suggestedWeight: 0.55, delta: 0.05, patternAgrees: true } },
  },
  {
    name: 'kind 漂移（未知 kind）',
    input: { kind: 'totally_new_kind' as unknown as CandidateInput['kind'], source: 'conversation', confidence: 0.9,
      evidence: goodEvidence, payload: {} },
  },
  {
    name: 'value_shift delta 与权重不一致（数学错配）',
    input: { kind: 'value_shift', source: 'conversation', confidence: 0.9, evidence: goodEvidence,
      payload: { valueId: 'v', currentWeight: 0.5, suggestedWeight: 0.9, delta: 0.05, patternAgrees: true } },
  },
  {
    name: 'value_shift suggestedWeight 越界 (>1)',
    input: { kind: 'value_shift', source: 'conversation', confidence: 0.9, evidence: goodEvidence,
      payload: { valueId: 'v', currentWeight: 0.5, suggestedWeight: 1.5, delta: 1.0, patternAgrees: true } },
  },
  {
    name: 'value_shift 缺 valueId',
    input: { kind: 'value_shift', source: 'conversation', confidence: 0.9, evidence: goodEvidence,
      payload: { currentWeight: 0.5, suggestedWeight: 0.55, delta: 0.05, patternAgrees: true } as unknown },
  },
  {
    name: 'payload 为 null',
    input: { kind: 'value_shift', source: 'conversation', confidence: 0.9, evidence: goodEvidence, payload: null },
  },
  {
    name: 'payload 为数组（类型混淆）',
    input: { kind: 'value_shift', source: 'conversation', confidence: 0.9, evidence: goodEvidence, payload: [1, 2, 3] },
  },
  {
    name: 'memory_edge source==target（自环）',
    input: { kind: 'memory_edge', source: 'conversation', confidence: 0.9, evidence: goodEvidence,
      payload: { sourceId: 'x', targetId: 'x', relation: 'rel', strength: 0.5 } },
  },
  {
    name: 'decision_style_patch 无任何字段（空 patch）',
    input: { kind: 'decision_style_patch', source: 'conversation', confidence: 0.9, evidence: goodEvidence, payload: {} },
  },
  {
    name: 'decision_style_patch lossAversion 越界 (<1)',
    input: { kind: 'decision_style_patch', source: 'conversation', confidence: 0.9, evidence: goodEvidence,
      payload: { lossAversion: 0.5 } },
  },
  /* ── 以下为 Codex WP-3 复审补全：顶层字段 + 各 kind 缺字段/越界 + 对抗形态 ── */
  {
    name: 'source 非法（幻觉来源）',
    input: { kind: 'value_shift', source: 'hallucinated_source' as unknown as CandidateInput['source'], confidence: 0.9,
      evidence: goodEvidence,
      payload: { valueId: 'v', currentWeight: 0.5, suggestedWeight: 0.55, delta: 0.05, patternAgrees: true } },
  },
  {
    name: 'evidence 非数组',
    input: { kind: 'value_shift', source: 'conversation', confidence: 0.9,
      evidence: { type: 'memory', id: 'm', score: 0.5 } as unknown as ArtifactEvidence[],
      payload: { valueId: 'v', currentWeight: 0.5, suggestedWeight: 0.55, delta: 0.05, patternAgrees: true } },
  },
  {
    name: 'evidence 元素为 null',
    input: { kind: 'value_shift', source: 'conversation', confidence: 0.9,
      evidence: [null as unknown as ArtifactEvidence],
      payload: { valueId: 'v', currentWeight: 0.5, suggestedWeight: 0.55, delta: 0.05, patternAgrees: true } },
  },
  {
    name: 'evidence 缺 id',
    input: { kind: 'value_shift', source: 'conversation', confidence: 0.9,
      evidence: [{ type: 'memory', score: 0.5 } as unknown as ArtifactEvidence],
      payload: { valueId: 'v', currentWeight: 0.5, suggestedWeight: 0.55, delta: 0.05, patternAgrees: true } },
  },
  {
    name: 'value_shift currentWeight 越界 (>1)',
    input: { kind: 'value_shift', source: 'conversation', confidence: 0.9, evidence: goodEvidence,
      payload: { valueId: 'v', currentWeight: 1.5, suggestedWeight: 0.55, delta: -0.95, patternAgrees: true } },
  },
  {
    name: 'value_shift delta 非 finite (Infinity)',
    input: { kind: 'value_shift', source: 'conversation', confidence: 0.9, evidence: goodEvidence,
      payload: { valueId: 'v', currentWeight: 0.5, suggestedWeight: 0.55, delta: Infinity, patternAgrees: true } },
  },
  {
    name: 'value_shift patternAgrees 非 boolean',
    input: { kind: 'value_shift', source: 'conversation', confidence: 0.9, evidence: goodEvidence,
      payload: { valueId: 'v', currentWeight: 0.5, suggestedWeight: 0.55, delta: 0.05, patternAgrees: 'yes' as unknown as boolean } },
  },
  {
    name: 'memory_edge 缺 targetId',
    input: { kind: 'memory_edge', source: 'conversation', confidence: 0.9, evidence: goodEvidence,
      payload: { sourceId: 'a', relation: 'rel', strength: 0.5 } as unknown },
  },
  {
    name: 'memory_edge relation 空',
    input: { kind: 'memory_edge', source: 'conversation', confidence: 0.9, evidence: goodEvidence,
      payload: { sourceId: 'a', targetId: 'b', relation: '', strength: 0.5 } },
  },
  {
    name: 'memory_edge strength 越界',
    input: { kind: 'memory_edge', source: 'conversation', confidence: 0.9, evidence: goodEvidence,
      payload: { sourceId: 'a', targetId: 'b', relation: 'rel', strength: 9 } },
  },
  {
    name: 'cognitive_model_patch 空 patch（无字段）',
    input: { kind: 'cognitive_model_patch', source: 'conversation', confidence: 0.9, evidence: goodEvidence, payload: {} },
  },
  {
    name: 'cognitive_model_patch map 字段为数组（类型混淆）',
    input: { kind: 'cognitive_model_patch', source: 'conversation', confidence: 0.9, evidence: goodEvidence,
      payload: { beliefs: [1, 2, 3] } },
  },
  {
    name: 'cognitive_model_patch map value 越界',
    input: { kind: 'cognitive_model_patch', source: 'conversation', confidence: 0.9, evidence: goodEvidence,
      payload: { beliefs: { k: 9 } } },
  },
  {
    name: 'response_template intent 空',
    input: { kind: 'response_template', source: 'conversation', confidence: 0.9, evidence: goodEvidence,
      payload: { intent: '  ', template: 'hi' } },
  },
  {
    name: 'narrative_patch narrative 空',
    input: { kind: 'narrative_patch', source: 'conversation', confidence: 0.9, evidence: goodEvidence,
      payload: { narrative: '   ' } },
  },
  {
    name: '对抗形态：__proto__ 污染 payload',
    input: { kind: 'value_shift', source: 'conversation', confidence: 0.9, evidence: goodEvidence,
      payload: JSON.parse('{"__proto__":{"polluted":true},"valueId":"v","currentWeight":0.5,"suggestedWeight":1.5,"delta":1,"patternAgrees":true}') },
  },
];

/** 全量内核状态指纹：覆盖所有 artifact kind 可能写入的落点（Codex WP-3 复审：扩大零脏写断言）。 */
function kernelFingerprint(os: ChronoSynthOS): string {
  const s = os.core.getState();
  return deepStringify({
    values: s.values,
    memoryCount: s.memories.size,
    edgeCount: s.edges.length,
    narrative: os.core.narrative.get(),
    decisionStyle: os.core.decisionStyle.get(),
    cognitiveModel: os.core.cognitiveModel.get(),
  });
}

describe('provider 输出畸形 corpus：不崩、不写脏数据进内核（WP-3 T3.1）', () => {
  let os: ChronoSynthOS;

  beforeEach(() => {
    os = new ChronoSynthOS({ clock: new TestClock(1000), logger: new SilentLogger() });
    os.start();
  });
  afterEach(() => os.close());

  for (const tc of MALFORMED_CANDIDATES) {
    it(`畸形候选「${tc.name}」→ rejected，内核零脏写（全量指纹）`, () => {
      /* 种一个真实价值后取全量内核指纹，fuzz 后校验指纹纹丝不动（覆盖所有内核落点）。 */
      os.core.addValue('守门', 0.42);
      const before = kernelFingerprint(os);

      /* 不抛错（优雅降级）。 */
      const result = os.distillation.ingest(PERSONA, tc.input);

      /* 畸形输入一律 rejected（绝不 compiled/pending 穿透门）。 */
      assert.equal(result.status, 'rejected', `「${tc.name}」应被拒绝，实际 ${result.status}`);

      /* 内核零脏写：全量指纹（values/memories/edges/narrative/decisionStyle/cognitiveModel）不变。 */
      assert.equal(kernelFingerprint(os), before, '内核全量状态不应被脏写');

      /* 不应有任何 compiled 工件落库（被拒的候选不进持久状态机的 compiled 终态）。 */
      const compiled = os.distillation.listByPersona(PERSONA).filter((a) => a.status === 'compiled');
      assert.equal(compiled.length, 0, '不应有畸形候选被编译');
    });
  }

  it('对照：合法 value_shift 候选确实能编译（证明门不是「全拒」的死门）', () => {
    const seeded = os.core.addValue('探索', 0.5);
    const result = os.distillation.ingest(PERSONA, {
      kind: 'value_shift', source: 'conversation', confidence: 0.85,
      evidence: goodEvidence,
      payload: { valueId: seeded.id, currentWeight: 0.5, suggestedWeight: 0.55, delta: 0.05, patternAgrees: true },
    });
    assert.equal(result.status, 'compiled', '合法候选应能通过门并编译');
    assert.equal(os.core.values.getAll().get(seeded.id)!.weight, 0.55, '合法编译应抬升权重');
  });
});
