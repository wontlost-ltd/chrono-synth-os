/**
 * 蒸馏编译器补全（WP-1）：decision_style_patch / cognitive_model_patch 经审批编译进 L2/L3 内核；
 * rule 经审批编译进版本化规则库。锁住「老师产出能完整蒸馏进确定性内核」。
 *
 * 这两类 kind 不在 auto-compile 范围（只 value_shift/memory_edge 自动编），故走 ingest→approve→compile。
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ChronoSynthOS } from '../../chrono-synth-os.js';
import { TestClock, SilentLogger } from '../../utils/index.js';
import type { ArtifactEvidence } from '@chrono/kernel';

const EV: ArtifactEvidence[] = [
  { type: 'memory', id: 'm1', score: 0.9 },
  { type: 'pattern', id: 'p1', score: 0.85 },
];

describe('artifact 编译器补全 decision_style / cognitive_model（WP-1）', () => {
  let os: ChronoSynthOS;

  beforeEach(() => {
    os = new ChronoSynthOS({ clock: new TestClock(1000), logger: new SilentLogger() });
    os.start();
  });
  afterEach(() => os.close());

  it('decision_style_patch → 审批编译 → L2 决策风格字段改变', () => {
    const before = os.core.decisionStyle.get();
    const ing = os.distillation.ingest('p1', {
      kind: 'decision_style_patch', source: 'reflection',
      payload: { riskAppetite: 0.8, explorationBias: 0.7 },
      confidence: 0.9, evidence: EV,
    });
    assert.equal(ing.status, 'pending', '非 auto-compile kind 应待审');
    if (ing.status !== 'pending') return;

    const ap = os.distillation.approve('p1', ing.artifact.id);
    assert.ok(ap.ok, `审批应成功: ${ap.ok ? '' : ap.reason}`);
    assert.equal(ap.artifact.status, 'compiled', `审批后应编译，实际 ${ap.artifact.status}`);

    const after = os.core.decisionStyle.get();
    assert.equal(after.riskAppetite, 0.8, 'riskAppetite 应被校准');
    assert.equal(after.explorationBias, 0.7, 'explorationBias 应被校准');
    /* 未提供的字段不变。 */
    assert.equal(after.timeHorizon, before.timeHorizon, '未提供字段不应变');
  });

  it('cognitive_model_patch → 审批编译 → L3 认知模型 scalar + map 改变', () => {
    const ing = os.distillation.ingest('p1', {
      kind: 'cognitive_model_patch', source: 'reflection',
      payload: { growthMindset: 0.9, beliefs: { 'world-is-learnable': 0.85 } },
      confidence: 0.9, evidence: EV,
    });
    assert.equal(ing.status, 'pending');
    if (ing.status !== 'pending') return;

    const ap = os.distillation.approve('p1', ing.artifact.id);
    assert.ok(ap.ok, `审批应成功: ${ap.ok ? '' : ap.reason}`);
    assert.equal(ap.artifact.status, 'compiled', `审批后应编译，实际 ${ap.artifact.status}`);

    const after = os.core.cognitiveModel.get();
    assert.equal(after.growthMindset, 0.9, 'growthMindset 应被校准');
    assert.equal(after.beliefs.get('world-is-learnable'), 0.85, 'beliefs map 应被合并');
  });

  it('cognitive_model_patch → ④ L3 扩展维度（模糊容忍 / 直觉↔分析）经成长管线学习落地', () => {
    /* Codex 退回核心：新维度若不接入 patch payload + 编译器，就是只能内部手写的半死字段。
     * 此处证明蒸馏成长管线（ingest→审批→编译）能真正学习并落地这两个维度。 */
    const before = os.core.cognitiveModel.get();
    assert.equal(before.ambiguityTolerance, 0.5, '初始模糊容忍应为中性 0.5');
    assert.equal(before.analyticalIntuitive, 0.5, '初始直觉↔分析应为中性 0.5');

    const ing = os.distillation.ingest('p1', {
      kind: 'cognitive_model_patch', source: 'reflection',
      payload: { ambiguityTolerance: 0.85, analyticalIntuitive: 0.2 },
      confidence: 0.9, evidence: EV,
    });
    assert.equal(ing.status, 'pending');
    if (ing.status !== 'pending') return;

    const ap = os.distillation.approve('p1', ing.artifact.id);
    assert.ok(ap.ok, `审批应成功: ${ap.ok ? '' : ap.reason}`);
    assert.equal(ap.artifact.status, 'compiled', `审批后应编译，实际 ${ap.artifact.status}`);

    const after = os.core.cognitiveModel.get();
    assert.equal(after.ambiguityTolerance, 0.85, '模糊容忍应被成长管线校准');
    assert.equal(after.analyticalIntuitive, 0.2, '直觉↔分析应被成长管线校准');
    /* 未提供的旧字段不变（部分更新语义）。 */
    assert.equal(after.growthMindset, before.growthMindset, '未提供字段不应变');
  });

  it('cognitive_model_patch ④ 新维度 [0,1] 越界 → ingest 拒绝', () => {
    const ing = os.distillation.ingest('p1', {
      kind: 'cognitive_model_patch', source: 'reflection',
      payload: { ambiguityTolerance: 1.5 }, confidence: 0.9, evidence: EV,
    });
    assert.equal(ing.status, 'rejected', '越界新维度应被 schema 校验拒绝');
  });

  it('decision_style_patch 领域字段约束：lossAversion≥1 + deliberationDepth 1..5 整数（编译不抛）', () => {
    /* Codex WP-1 Critical：lossAversion/deliberationDepth 不是 [0,1]。合法值应编译成功不抛 RangeError。 */
    const ing = os.distillation.ingest('p1', {
      kind: 'decision_style_patch', source: 'reflection',
      payload: { lossAversion: 2.5, deliberationDepth: 4 },
      confidence: 0.9, evidence: EV,
    });
    assert.equal(ing.status, 'pending');
    if (ing.status !== 'pending') return;
    const ap = os.distillation.approve('p1', ing.artifact.id);
    assert.ok(ap.ok, `应编译成功（领域合法值）: ${ap.ok ? '' : ap.reason}`);
    const after = os.core.decisionStyle.get();
    assert.equal(after.lossAversion, 2.5);
    assert.equal(after.deliberationDepth, 4);
  });

  it('decision_style_patch [0,1] 字段越界 → ingest 拒绝', () => {
    const ing = os.distillation.ingest('p1', {
      kind: 'decision_style_patch', source: 'reflection',
      payload: { riskAppetite: 1.5 }, confidence: 0.9, evidence: EV,
    });
    assert.equal(ing.status, 'rejected', '越界 payload 应被 schema 校验拒绝');
  });

  it('decision_style_patch deliberationDepth 非整数 / lossAversion<1 → 拒绝', () => {
    const a = os.distillation.ingest('p1', { kind: 'decision_style_patch', source: 'reflection', payload: { deliberationDepth: 3.5 }, confidence: 0.9, evidence: EV });
    assert.equal(a.status, 'rejected', 'deliberationDepth 必须整数');
    const b = os.distillation.ingest('p1', { kind: 'decision_style_patch', source: 'reflection', payload: { lossAversion: 0.5 }, confidence: 0.9, evidence: EV });
    assert.equal(b.status, 'rejected', 'lossAversion 必须 ≥1');
  });

  it('cognitive_model_patch beliefs → entry 级合并（保留旧 key，不覆盖整张）', () => {
    const ing1 = os.distillation.ingest('p1', { kind: 'cognitive_model_patch', source: 'reflection', payload: { beliefs: { 'belief-A': 0.7 } }, confidence: 0.9, evidence: EV });
    if (ing1.status === 'pending') os.distillation.approve('p1', ing1.artifact.id);
    const ing2 = os.distillation.ingest('p1', { kind: 'cognitive_model_patch', source: 'reflection', payload: { beliefs: { 'belief-B': 0.8 } }, confidence: 0.9, evidence: EV });
    if (ing2.status === 'pending') os.distillation.approve('p1', ing2.artifact.id);
    const m = os.core.cognitiveModel.get();
    assert.equal(m.beliefs.get('belief-A'), 0.7, 'belief-A 应被保留（merge 非替换）');
    assert.equal(m.beliefs.get('belief-B'), 0.8, 'belief-B 应被新增');
  });

  it('decision_style_patch 空 payload（无字段）→ 拒绝', () => {
    const ing = os.distillation.ingest('p1', {
      kind: 'decision_style_patch', source: 'reflection',
      payload: {}, confidence: 0.9, evidence: EV,
    });
    assert.equal(ing.status, 'rejected', '无校准字段应被拒绝');
  });

  it('rule kind → 审批编译 → 版本化规则库', () => {
    /* rule 不在 auto-compile 白名单，走 approve 后落 persona_rules。 */
    const ing = os.distillation.ingest('p1', {
      kind: 'rule', source: 'reflection',
      payload: {
        ruleId: 'prefer_quality',
        condition: '质量',
        action: 'prefer',
        weight: 0.8,
        description: '遇到质量选项时优先',
      },
      confidence: 0.9, evidence: EV,
    });
    assert.equal(ing.status, 'pending', 'rule 不 auto-compile → pending');
    if (ing.status !== 'pending') return;
    const ap = os.distillation.approve('p1', ing.artifact.id);
    assert.ok(ap.ok, `审批应成功: ${ap.ok ? '' : ap.reason}`);
    assert.equal(ap.artifact.status, 'compiled');

    const rules = os.rules.getActiveRules('p1');
    assert.deepEqual(rules, [{
      ruleId: 'prefer_quality',
      condition: '质量',
      action: 'prefer',
      weight: 0.8,
      description: '遇到质量选项时优先',
    }]);
  });
});
