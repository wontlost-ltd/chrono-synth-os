/**
 * 蒸馏编译器补全（WP-1）：decision_style_patch / cognitive_model_patch 经审批编译进 L2/L3 内核；
 * rule 显式拒绝（不静默）。锁住「老师产出能完整蒸馏进确定性内核」。
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

  it('decision_style_patch 非法 payload（越界）→ ingest 拒绝（校验拦截）', () => {
    const ing = os.distillation.ingest('p1', {
      kind: 'decision_style_patch', source: 'reflection',
      payload: { riskAppetite: 1.5 }, // 越界
      confidence: 0.9, evidence: EV,
    });
    assert.equal(ing.status, 'rejected', '越界 payload 应被 schema 校验拒绝');
  });

  it('decision_style_patch 空 payload（无字段）→ 拒绝', () => {
    const ing = os.distillation.ingest('p1', {
      kind: 'decision_style_patch', source: 'reflection',
      payload: {}, confidence: 0.9, evidence: EV,
    });
    assert.equal(ing.status, 'rejected', '无校准字段应被拒绝');
  });

  it('rule kind → 编译显式拒绝（rule store 未落地，不静默）', () => {
    /* rule 校验通过（default 放行），但编译器显式拒绝。走 approve 触发编译。 */
    const ing = os.distillation.ingest('p1', {
      kind: 'rule', source: 'reflection',
      payload: { if: 'x', then: 'y' }, confidence: 0.9, evidence: EV,
    });
    assert.equal(ing.status, 'pending', 'rule 不 auto-compile → pending');
    if (ing.status !== 'pending') return;
    const ap = os.distillation.approve('p1', ing.artifact.id);
    /* 编译失败 → approve 返回 ok:false（或 artifact 非 compiled），rule 不进内核。 */
    if (ap.ok) {
      assert.notEqual(ap.artifact.status, 'compiled', 'rule 不应被编译进内核');
    }
  });
});
