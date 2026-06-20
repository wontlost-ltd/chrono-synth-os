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
import { archetypeDecisionStyle } from '@chrono/kernel';

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
    /* 收紧预算到 2：窗口内最多 auto-compile 2 条未验证成长，第 3 条起降级 confirm。
     * 关动态成长预算——本组测**全局静态 policy 旧行为**（动态另有 policy-min 行为单独测）。 */
    os = new ChronoSynthOS({
      clock: new TestClock(1000),
      logger: new SilentLogger(),
      distillationPolicy: { unverifiedGrowthBudgetPerWindow: 2 },
      dynamicGrowthBudgetEnabled: false,
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
    /* 全局预算不限（默认）；靠 per-persona governance 覆盖收紧。关动态预算——本组测 per-persona
     * override 语义（无覆盖应回退全局不限），dynamic 开启会让无覆盖人格走动态有界（ADR-0048）。 */
    os = new ChronoSynthOS({ clock: new TestClock(1000), logger: new SilentLogger(), dynamicGrowthBudgetEnabled: false });
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

/* ── ADR-0048 动态成长预算（默认开）：无 override 的人格按核心成熟度 U 形自适应 ── */
describe('Distillation 动态成长预算（ADR-0048，默认开）', () => {
  let os: ChronoSynthOS;

  beforeEach(() => {
    /* 动态预算默认开（不传 dynamicGrowthBudgetEnabled）；无 per-persona override。 */
    os = new ChronoSynthOS({ clock: new TestClock(1000), logger: new SilentLogger() });
    os.start();
  });
  afterEach(() => os.close());

  function ingest(personaId: string, valueId: string) {
    return os.distillation.ingest(personaId, {
      kind: 'value_shift', source: 'reflection',
      payload: { valueId, currentWeight: 0.5, suggestedWeight: 0.53, delta: 0.03, patternAgrees: true },
      confidence: 0.85, evidence: [{ type: 'memory', id: 'm', score: 0.9 }, { type: 'memory', id: 'm2', score: 0.8 }],
    });
  }

  it('婴儿期（记忆少）→ 动态预算=floor(3)：前 3 条自动，第 4 条降级', () => {
    /* core 无记忆 → computeDynamicGrowthBudget(0)=floor=3。 */
    const vals = ['a', 'b', 'c', 'd'].map((l) => os.core.addValue(l, 0.5));
    /* personaId='default'：与 os.core 同一人格（动态预算读 os.core 记忆数=0→3）。 */
    assert.equal(ingest('default', vals[0].id).status, 'compiled', '第 1 条 (0<3)');
    assert.equal(ingest('default', vals[1].id).status, 'compiled', '第 2 条 (1<3)');
    assert.equal(ingest('default', vals[2].id).status, 'compiled', '第 3 条 (2<3)');
    assert.equal(ingest('default', vals[3].id).status, 'pending', '第 4 条 (3≥3) → 动态预算降级');
  });

  it('性格调激进度：explorer 风格人格比 guardian 风格自动吸收更多（同记忆数）', () => {
    /* 起两个 OS，分别设 explorer / guardian 真原型决策风格，喂同样多的成长候选，比 compiled 数。 */
    function countCompiled(archetype: 'explorer' | 'guardian'): number {
      const o = new ChronoSynthOS({ clock: new TestClock(1000), logger: new SilentLogger() });
      o.start();
      try {
        /* 用真原型风格（合法 6 维：lossAversion≥1、deliberationDepth 整数等）。exists()=true → resolver
         * 据 explorationBias/riskAppetite 派生激进度。 */
        o.core.setDecisionStyle(archetypeDecisionStyle(archetype, 1000));
        /* 加 100 条记忆 → M=100，此时 ceil 差异（explorer 40 vs guardian 15）才显现（M=0 都是 floor）。 */
        for (let i = 0; i < 100; i++) o.core.memories.addMemory('semantic', `mem ${i}`, 0, 0.5);
        let compiled = 0;
        /* 喂 50 条成长候选——explorer ceil 高会比 guardian 多自动编译。 */
        for (let i = 0; i < 50; i++) {
          const v = o.core.addValue(`v${i}`, 0.5);
          const r = o.distillation.ingest('default', {
            kind: 'value_shift', source: 'reflection',
            payload: { valueId: v.id, currentWeight: 0.5, suggestedWeight: 0.53, delta: 0.03, patternAgrees: true },
            confidence: 0.85, evidence: [{ type: 'memory', id: 'm', score: 0.9 }, { type: 'memory', id: 'm2', score: 0.8 }],
          });
          if (r.status === 'compiled') compiled++;
        }
        return compiled;
      } finally { o.close(); }
    }
    const explorerCompiled = countCompiled('explorer');
    const guardianCompiled = countCompiled('guardian');
    assert.ok(explorerCompiled > guardianCompiled,
      `explorer 自动吸收(${explorerCompiled}) > guardian(${guardianCompiled})`);
  });

  it('动态开启时全局 policy 上限仍生效（取 min，Codex 复审）：policy=1 → 第 2 条降级', () => {
    /* 运维设全局上限 1（比动态 floor 3 更紧）→ 动态与 policy 取 min=1。 */
    const capped = new ChronoSynthOS({
      clock: new TestClock(1000), logger: new SilentLogger(),
      distillationPolicy: { unverifiedGrowthBudgetPerWindow: 1 },
      /* dynamicGrowthBudgetEnabled 默认开 */
    });
    capped.start();
    try {
      const vals = ['a', 'b'].map((l) => capped.core.addValue(l, 0.5));
      const mk = (vid: string) => capped.distillation.ingest('default', {
        kind: 'value_shift', source: 'reflection',
        payload: { valueId: vid, currentWeight: 0.5, suggestedWeight: 0.53, delta: 0.03, patternAgrees: true },
        confidence: 0.85, evidence: [{ type: 'memory', id: 'm', score: 0.9 }, { type: 'memory', id: 'm2', score: 0.8 }],
      });
      assert.equal(mk(vals[0].id).status, 'compiled', '第 1 条 (0<min(动态,1)=1)');
      assert.equal(mk(vals[1].id).status, 'pending', '第 2 条 (1≥1) → 全局上限生效，动态不绕过');
    } finally { capped.close(); }
  });

  it('关动态预算 → 无 override 回退全局不限（旧行为，可逃生）', () => {
    const off = new ChronoSynthOS({ clock: new TestClock(1000), logger: new SilentLogger(), dynamicGrowthBudgetEnabled: false });
    off.start();
    try {
      const vals = ['a', 'b', 'c', 'd', 'e'].map((l) => off.core.addValue(l, 0.5));
      for (let i = 0; i < 5; i++) {
        const r = off.distillation.ingest('default', {
          kind: 'value_shift', source: 'reflection',
          payload: { valueId: vals[i].id, currentWeight: 0.5, suggestedWeight: 0.53, delta: 0.03, patternAgrees: true },
          confidence: 0.85, evidence: [{ type: 'memory', id: 'm', score: 0.9 }, { type: 'memory', id: 'm2', score: 0.8 }],
        });
        assert.equal(r.status, 'compiled', `关动态后第 ${i + 1} 条仍自动（不限）`);
      }
    } finally { off.close(); }
  });
});
