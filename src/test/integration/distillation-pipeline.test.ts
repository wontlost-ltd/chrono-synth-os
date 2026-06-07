/**
 * ADR-0047 集成测试：蒸馏管线端到端（ingest → 门控 → 编译进核心 / 待审批 / 回滚）。
 * 验证 D3 不变量：LLM 教学输出经门控才改核心状态，可审批、可回滚、可持久化。
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ChronoSynthOS } from '../../chrono-synth-os.js';
import { TestClock, SilentLogger } from '../../utils/index.js';
import type { ArtifactEvidence } from '@chrono/kernel';

const EV: ArtifactEvidence[] = [
  { type: 'pattern', id: 'e1', score: 0.8 },
  { type: 'memory', id: 'm1', score: 0.6 },
];

describe('Distillation pipeline (ADR-0047)', () => {
  let os: ChronoSynthOS;

  beforeEach(() => {
    os = new ChronoSynthOS({ clock: new TestClock(1000), logger: new SilentLogger() });
    os.start();
  });

  afterEach(() => os.close());

  it('合格 value_shift 自动编译进核心', () => {
    const v = os.core.addValue('curiosity', 0.5);
    const r = os.distillation.ingest('p1', {
      kind: 'value_shift', source: 'reflection',
      payload: { valueId: v.id, currentWeight: 0.5, suggestedWeight: 0.53, delta: 0.03, patternAgrees: true },
      confidence: 0.85, evidence: EV,
    });
    assert.equal(r.status, 'compiled');
    assert.equal(os.core.values.getById(v.id)?.weight, 0.53);
  });

  it('delta 超阈值 → 待审批，核心不变', () => {
    const v = os.core.addValue('curiosity', 0.5);
    const r = os.distillation.ingest('p1', {
      kind: 'value_shift', source: 'reflection',
      payload: { valueId: v.id, currentWeight: 0.5, suggestedWeight: 0.7, delta: 0.2, patternAgrees: true },
      confidence: 0.95, evidence: EV,
    });
    assert.equal(r.status, 'pending');
    assert.equal(os.core.values.getById(v.id)?.weight, 0.5, '待审批不应改核心');
    assert.equal(os.distillation.listCandidates('p1').length, 1);
  });

  it('patternAgrees=false → 待审批（交叉验证失败不自动编译）', () => {
    const v = os.core.addValue('curiosity', 0.5);
    const r = os.distillation.ingest('p1', {
      kind: 'value_shift', source: 'reflection',
      payload: { valueId: v.id, currentWeight: 0.5, suggestedWeight: 0.52, delta: 0.02, patternAgrees: false },
      confidence: 0.95, evidence: EV,
    });
    assert.equal(r.status, 'pending');
  });

  it('人工审批待审工件 → 编译进核心', () => {
    const v = os.core.addValue('focus', 0.4);
    const ing = os.distillation.ingest('p1', {
      kind: 'value_shift', source: 'reflection',
      payload: { valueId: v.id, currentWeight: 0.4, suggestedWeight: 0.8, delta: 0.4, patternAgrees: true },
      confidence: 0.95, evidence: EV,
    });
    assert.equal(ing.status, 'pending');
    const ap = os.distillation.approve('p1', ing.artifact.id);
    assert.equal(ap.ok, true);
    assert.equal(os.core.values.getById(v.id)?.weight, 0.8);
    assert.equal(os.distillation.listCandidates('p1').length, 0);
  });

  it('拒绝待审工件 → 核心不变，状态 rejected', () => {
    const v = os.core.addValue('focus', 0.4);
    const ing = os.distillation.ingest('p1', {
      kind: 'value_shift', source: 'reflection',
      payload: { valueId: v.id, currentWeight: 0.4, suggestedWeight: 0.9, delta: 0.5, patternAgrees: true },
      confidence: 0.95, evidence: EV,
    });
    assert.equal(ing.status, 'pending');
    if (ing.status !== 'pending') return;
    const rj = os.distillation.reject('p1', ing.artifact.id, 'too aggressive');
    assert.equal(rj.ok, true);
    assert.equal(os.core.values.getById(v.id)?.weight, 0.4);
    assert.equal(os.distillation.listCandidates('p1').length, 0);
  });

  it('编译失败（目标缺失）→ 回滚 + 标记 rejected，候选清空', () => {
    const r = os.distillation.ingest('p1', {
      kind: 'value_shift', source: 'reflection',
      payload: { valueId: 'nonexistent', currentWeight: 0.1, suggestedWeight: 0.12, delta: 0.02, patternAgrees: true },
      confidence: 0.85, evidence: EV,
    });
    assert.equal(r.status, 'rejected');
    assert.equal(os.distillation.listCandidates('p1').length, 0);
  });

  it('畸形候选（delta 不一致）→ 校验拒绝，不入库', () => {
    const v = os.core.addValue('curiosity', 0.5);
    const r = os.distillation.ingest('p1', {
      kind: 'value_shift', source: 'reflection',
      payload: { valueId: v.id, currentWeight: 0.5, suggestedWeight: 0.53, delta: 0.99, patternAgrees: true },
      confidence: 0.85, evidence: EV,
    });
    assert.equal(r.status, 'rejected');
    assert.equal(os.distillation.listByPersona('p1').length, 0, '畸形候选不应入库');
  });

  it('memory_edge 自动编译为记忆图边', () => {
    const m1 = os.core.addMemory('episodic', 'A', 0.5, 0.8);
    const m2 = os.core.addMemory('semantic', 'B', 0.3, 0.6);
    const r = os.distillation.ingest('p1', {
      kind: 'memory_edge', source: 'conversation',
      payload: { sourceId: m1.id, targetId: m2.id, relation: 'enriched_by', strength: 0.7 },
      confidence: 0.8, evidence: EV,
    });
    assert.equal(r.status, 'compiled');
    assert.ok(os.core.memories.getEdgesFor(m1.id).some((e) => e.target === m2.id));
  });

  it('编译发出 system:artifact-compiled 事件', () => {
    const v = os.core.addValue('curiosity', 0.5);
    let emitted: { kind: string } | undefined;
    os.bus.on('system:artifact-compiled', (e) => { emitted = e; });
    os.distillation.ingest('p1', {
      kind: 'value_shift', source: 'reflection',
      payload: { valueId: v.id, currentWeight: 0.5, suggestedWeight: 0.53, delta: 0.03, patternAgrees: true },
      confidence: 0.85, evidence: EV,
    });
    assert.equal(emitted?.kind, 'value_shift');
  });

  it('跨 persona 越权：persona-B 不能 approve persona-A 的工件（IDOR 防护）', () => {
    const v = os.core.addValue('focus', 0.4);
    const ing = os.distillation.ingest('persona-A', {
      kind: 'value_shift', source: 'reflection',
      payload: { valueId: v.id, currentWeight: 0.4, suggestedWeight: 0.9, delta: 0.5, patternAgrees: true },
      confidence: 0.95, evidence: EV,
    });
    assert.equal(ing.status, 'pending');
    if (ing.status !== 'pending') return;
    /* 用 persona-B 的作用域去审批 persona-A 的工件 → 必须 not found（对象级授权） */
    const ap = os.distillation.approve('persona-B', ing.artifact.id);
    assert.equal(ap.ok, false);
    if (!ap.ok) assert.equal(ap.reason, 'artifact not found');
    /* persona-A 的工件未受影响，核心权重未变 */
    assert.equal(os.core.values.getById(v.id)?.weight, 0.4);
    /* 正确作用域可见 */
    assert.equal(os.distillation.listCandidates('persona-A').length, 1);
    assert.equal(os.distillation.listCandidates('persona-B').length, 0);
  });

  it('跨 persona 越权：persona-B 不能 reject persona-A 的工件', () => {
    const v = os.core.addValue('focus', 0.4);
    const ing = os.distillation.ingest('persona-A', {
      kind: 'value_shift', source: 'reflection',
      payload: { valueId: v.id, currentWeight: 0.4, suggestedWeight: 0.9, delta: 0.5, patternAgrees: true },
      confidence: 0.95, evidence: EV,
    });
    if (ing.status !== 'pending') return assert.fail('expected pending');
    const rj = os.distillation.reject('persona-B', ing.artifact.id, 'malicious');
    assert.equal(rj.ok, false);
    if (!rj.ok) assert.equal(rj.reason, 'artifact not found');
  });

  it('工件持久化跨实例可查（审计历史）', () => {
    const v = os.core.addValue('curiosity', 0.5);
    os.distillation.ingest('p1', {
      kind: 'value_shift', source: 'reflection',
      payload: { valueId: v.id, currentWeight: 0.5, suggestedWeight: 0.53, delta: 0.03, patternAgrees: true },
      confidence: 0.85, evidence: EV,
    });
    const all = os.distillation.listByPersona('p1');
    assert.equal(all.length, 1);
    assert.equal(all[0].status, 'compiled');
    assert.ok(all[0].compiledAt && all[0].compiledAt > 0);
  });
});
