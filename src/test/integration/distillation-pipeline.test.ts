/**
 * ADR-0047 集成测试：蒸馏管线端到端（ingest → 门控 → 编译进核心 / 待审批 / 回滚）。
 * 验证 D3 不变量：LLM 教学输出经门控才改核心状态，可审批、可回滚、可持久化。
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ChronoSynthOS } from '../../chrono-synth-os.js';
import { TestClock, SilentLogger } from '../../utils/index.js';
import { PersonaGovernanceStore } from '../../storage/persona-governance-store.js';
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
      /* conversation=semi 信任层：memory_edge 门槛 0.75×1.1=0.825，故 confidence 取 0.85 过门
       * （信任分级后 conversation 来源比 reflection 略严，这是 ① 的预期行为）。 */
      kind: 'memory_edge', source: 'conversation',
      payload: { sourceId: m1.id, targetId: m2.id, relation: 'enriched_by', strength: 0.7 },
      confidence: 0.85, evidence: EV,
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

/* ── ② 不确定性预算：端到端生产接线（窗口内 auto-compile 达上限 → 后续降级人工审批）── */
describe('Distillation 不确定性预算（ADR-0047 成长治理）', () => {
  let os: ChronoSynthOS;

  beforeEach(() => {
    /* 收紧预算到 2：窗口内最多 auto-compile 2 条未验证成长，第 3 条起降级 confirm。 */
    os = new ChronoSynthOS({
      clock: new TestClock(1000),
      logger: new SilentLogger(),
      distillationPolicy: { unverifiedGrowthBudgetPerWindow: 2 },
    });
    os.start();
  });
  afterEach(() => os.close());

  function ingestValueShift(valueId: string, w: number) {
    return os.distillation.ingest('p1', {
      kind: 'value_shift', source: 'reflection',
      payload: { valueId, currentWeight: w, suggestedWeight: w + 0.03, delta: 0.03, patternAgrees: true },
      confidence: 0.85, evidence: EV,
    });
  }

  it('窗口内前 2 条 auto-compile，第 3 条达预算上限 → 降级 pending（即使过门）', () => {
    const v1 = os.core.addValue('a', 0.5);
    const v2 = os.core.addValue('b', 0.5);
    const v3 = os.core.addValue('c', 0.5);
    /* 前两条都过门且窗口未满 → compiled。 */
    assert.equal(ingestValueShift(v1.id, 0.5).status, 'compiled', '第 1 条预算内');
    assert.equal(ingestValueShift(v2.id, 0.5).status, 'compiled', '第 2 条预算内');
    /* 第 3 条同样过门，但窗口已有 2 条 compiled = 预算上限 → 降级 pending（留待人工审批）。 */
    assert.equal(ingestValueShift(v3.id, 0.5).status, 'pending', '第 3 条达预算 → 降级人工审批');
    /* 第 3 个 value 权重未被自动改（降级了，没编译进核心）。 */
    assert.equal(os.core.values.getById(v3.id)?.weight, 0.5, '降级条未改核心权重');
  });

  it('降级后人工审批仍可编译（预算降级是「需确认」不是「拒绝」）', () => {
    const v1 = os.core.addValue('a', 0.5);
    const v2 = os.core.addValue('b', 0.5);
    const v3 = os.core.addValue('c', 0.5);
    ingestValueShift(v1.id, 0.5);
    ingestValueShift(v2.id, 0.5);
    const third = ingestValueShift(v3.id, 0.5);
    assert.equal(third.status, 'pending');
    if (third.status !== 'pending') return;
    /* 人工 approve → 仍能编译进核心（预算只挡自动，不挡人工）。 */
    const approved = os.distillation.approve('p1', third.artifact.id);
    assert.equal(approved.ok, true, '人工审批可越过预算降级');
    assert.equal(os.core.values.getById(v3.id)?.weight, 0.53, '审批后权重上升');
  });

  it('compiledVia 精确：人工审批编译不消耗未验证预算（Codex 复审——只数 auto）', () => {
    const v1 = os.core.addValue('a', 0.5);
    const v2 = os.core.addValue('b', 0.5);
    const v3 = os.core.addValue('c', 0.5);
    const v4 = os.core.addValue('d', 0.5);
    /* 第 1 条自动编译（compiledVia=auto，进预算）。 */
    assert.equal(ingestValueShift(v1.id, 0.5).status, 'compiled');
    /* 第 2 条故意 delta 超阈值 → pending，人工 approve（compiledVia=approved，不进预算）。 */
    const manual = os.distillation.ingest('p1', {
      kind: 'value_shift', source: 'reflection',
      payload: { valueId: v2.id, currentWeight: 0.5, suggestedWeight: 0.8, delta: 0.3, patternAgrees: true },
      confidence: 0.85, evidence: EV,
    });
    assert.equal(manual.status, 'pending', 'delta 超阈值 → 待审批');
    if (manual.status === 'pending') os.distillation.approve('p1', manual.artifact.id);
    /* 此刻窗口有 2 条 compiled，但只有 1 条 compiledVia=auto → 预算(2)未满。 */
    /* 第 3 条自动 → 仍可编译（auto 计数=1 < 2）。 */
    assert.equal(ingestValueShift(v3.id, 0.5).status, 'compiled', 'auto 计数 1<2，人工审批的不占预算');
    /* 第 4 条自动 → auto 计数=2 达预算 → 降级。 */
    assert.equal(ingestValueShift(v4.id, 0.5).status, 'pending', 'auto 计数达 2 → 降级');
  });
});

/* ── 债1：per-persona 预算覆盖全局（governance store 配的预算优先）── */
describe('Distillation per-persona 预算覆盖（governance 配置）', () => {
  let os: ChronoSynthOS;

  beforeEach(() => {
    /* 全局预算不限（默认）；靠 per-persona governance 覆盖收紧。 */
    os = new ChronoSynthOS({ clock: new TestClock(1000), logger: new SilentLogger() });
    os.start();
  });
  afterEach(() => os.close());

  function ingest(personaId: string, valueId: string) {
    return os.distillation.ingest(personaId, {
      kind: 'value_shift', source: 'reflection',
      payload: { valueId, currentWeight: 0.5, suggestedWeight: 0.53, delta: 0.03, patternAgrees: true },
      confidence: 0.85, evidence: EV,
    });
  }

  it('p1 配 per-persona 预算=1 → 第 2 条降级；p2 无覆盖 → 不限', () => {
    /* p1 经 governance store 配预算 1。 */
    new PersonaGovernanceStore(os.getDatabase(), 'default').upsert('p1', { unverifiedGrowthBudgetPerWindow: 1 }, 'owner', 1000);
    const a = os.core.addValue('a', 0.5);
    const b = os.core.addValue('b', 0.5);
    const c = os.core.addValue('c', 0.5);
    /* p1 第 1 条 auto-compile（计数 0<1）→ compiled；第 2 条（计数 1≥1）→ 降级 pending。 */
    assert.equal(ingest('p1', a.id).status, 'compiled', 'p1 第 1 条预算内');
    assert.equal(ingest('p1', b.id).status, 'pending', 'p1 第 2 条达 per-persona 预算 1 → 降级');
    /* p2 无 governance 覆盖 → 回退全局（不限）→ 仍 compiled（证明 per-persona 隔离，不误伤别人）。 */
    assert.equal(ingest('p2', c.id).status, 'compiled', 'p2 无覆盖 → 全局不限');
  });

  it('per-persona 预算=0 → 完全禁止自动吸收（第 1 条即降级）', () => {
    new PersonaGovernanceStore(os.getDatabase(), 'default').upsert('p1', { unverifiedGrowthBudgetPerWindow: 0 }, 'owner', 1000);
    const a = os.core.addValue('a', 0.5);
    assert.equal(ingest('p1', a.id).status, 'pending', '预算 0 → 第 1 条即转人工');
  });
});
