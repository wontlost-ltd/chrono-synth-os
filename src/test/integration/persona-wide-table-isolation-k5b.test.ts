/**
 * K5b（ADR-0056）宽表 per-persona 隔离——core_values / memory_nodes / memory_edges / survival_anchors
 * 从 tenant 键扩成 (tenant, persona) 隔离。至此认知核心**全维度** per-persona（三件套 K2 + 宽表 K5b）。
 *
 * 验证：同一 os（同租户）下两个 persona core，各自的价值/记忆/记忆边/生存锚点互不可见、互不覆盖；
 * 编译失败/恢复语义不受影响。隔离机制 = 写 persona_id + 读按 persona 过滤（主键仍 id，tenant_id 由
 * TenantDatabase 自动注入）。
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ChronoSynthOS } from '../../chrono-synth-os.js';
import { SilentLogger } from '../../utils/logger.js';
import { TestClock } from '../../utils/clock.js';

describe('K5b ADR-0056 宽表 per-persona 隔离（values/memories/edges/anchors）', () => {
  let os: ChronoSynthOS;

  beforeEach(() => {
    os = new ChronoSynthOS({ clock: new TestClock(1000), logger: new SilentLogger(), tenantId: 't1' });
    os.start();
  });
  afterEach(() => os.close());

  it('★价值隔离★：alice 的价值 bob/default 看不到', () => {
    const va = os.getCore('p-alice').addValue('探索', 0.9);
    const vb = os.getCore('p-bob').addValue('稳健', 0.8);
    /* 各自只见自己的价值。 */
    assert.equal(os.getCore('p-alice').values.getById(va.id)?.label, '探索');
    assert.equal(os.getCore('p-alice').values.getById(vb.id), undefined, 'alice 看不到 bob 的价值');
    assert.equal(os.getCore('p-bob').values.getById(va.id), undefined, 'bob 看不到 alice 的价值');
    assert.equal(os.getCore('default').values.getById(va.id), undefined, 'default 看不到 alice 的价值');
    /* getAll 按 persona 过滤。 */
    assert.deepEqual([...os.getCore('p-alice').values.getAll().values()].map((v) => v.label), ['探索']);
    assert.deepEqual([...os.getCore('p-bob').values.getAll().values()].map((v) => v.label), ['稳健']);
  });

  it('★记忆隔离★：alice 的记忆 bob 看不到，getAllMemories 按 persona 过滤', () => {
    const ma = os.getCore('p-alice').addMemory('episodic', 'alice 的经历', 0.5, 0.8);
    os.getCore('p-bob').addMemory('episodic', 'bob 的经历', 0.5, 0.8);
    /* alice 的记忆只在 alice 可见。 */
    assert.equal(os.getCore('p-alice').accessMemory(ma.id)?.content, 'alice 的经历');
    assert.equal(os.getCore('p-bob').accessMemory(ma.id), undefined, 'bob 看不到 alice 的记忆');
    /* getAllMemories 按 persona 过滤。 */
    const aliceMems = [...os.getCore('p-alice').memories.getAllMemories().values()].map((m) => m.content);
    const bobMems = [...os.getCore('p-bob').memories.getAllMemories().values()].map((m) => m.content);
    assert.deepEqual(aliceMems, ['alice 的经历']);
    assert.deepEqual(bobMems, ['bob 的经历']);
  });

  it('★记忆边隔离★：alice 的记忆边 bob 看不到', () => {
    const a1 = os.getCore('p-alice').addMemory('episodic', 'A1', 0.5, 0.8);
    const a2 = os.getCore('p-alice').addMemory('semantic', 'A2', 0.3, 0.6);
    os.getCore('p-alice').linkMemories(a1.id, a2.id, 'relates_to', 0.7);
    /* alice 看到自己的边；bob 的边集为空。 */
    assert.ok(os.getCore('p-alice').memories.getAllEdges().some((e) => e.source === a1.id && e.target === a2.id));
    assert.equal(os.getCore('p-bob').memories.getAllEdges().length, 0, 'bob 无记忆边');
    /* getEdgesFor 也按 persona（bob 查 alice 的节点 → 空）。 */
    assert.equal(os.getCore('p-bob').memories.getEdgesFor(a1.id).length, 0, 'bob 查不到 alice 节点的边');
  });

  it('★生存锚点隔离★：alice 的锚点 bob 看不到', () => {
    const anchorA = os.getCore('p-alice').addSurvivalAnchor('诚信', 'threshold', { min: 0.8 }, 4);
    os.getCore('p-bob').addSurvivalAnchor('效率', 'threshold', { min: 0.5 }, 3);
    assert.equal(os.getCore('p-alice').survival.getById(anchorA.id)?.label, '诚信');
    assert.equal(os.getCore('p-bob').survival.getById(anchorA.id), undefined, 'bob 看不到 alice 的锚点');
    assert.deepEqual(os.getCore('p-alice').survival.getAll().map((a) => a.label), ['诚信']);
    assert.deepEqual(os.getCore('p-bob').survival.getAll().map((a) => a.label), ['效率']);
  });

  it('★全维度状态隔离★：getState 完整覆盖各自 persona 的 7 维（不串）', () => {
    /* alice 写满各维度。 */
    const c = os.getCore('p-alice');
    c.addValue('探索', 0.9);
    const m1 = c.addMemory('episodic', 'A', 0.5, 0.8);
    const m2 = c.addMemory('semantic', 'B', 0.3, 0.6);
    c.linkMemories(m1.id, m2.id, 'relates_to', 0.7);
    c.addSurvivalAnchor('诚信', 'threshold', { min: 0.8 }, 4);
    c.updateNarrative('我是 alice');
    c.setDecisionStyle({ riskAppetite: 0.77 });

    const aState = os.getCore('p-alice').getState();
    const bState = os.getCore('p-bob').getState();
    /* alice 满，bob 空（各维度都不串）。 */
    assert.equal(aState.values.size, 1);
    assert.equal(aState.memories.size, 2);
    assert.equal(aState.edges.length, 1);
    assert.equal(aState.survivalAnchors.length, 1);
    assert.equal(aState.narrative, '我是 alice');
    assert.equal(aState.decisionStyle.riskAppetite, 0.77);
    /* bob 全空。 */
    assert.equal(bState.values.size, 0, 'bob 价值空');
    assert.equal(bState.memories.size, 0, 'bob 记忆空');
    assert.equal(bState.edges.length, 0, 'bob 记忆边空');
    assert.equal(bState.survivalAnchors.length, 0, 'bob 锚点空');
    assert.notEqual(bState.narrative, '我是 alice', 'bob 叙事不串');
    assert.notEqual(bState.decisionStyle.riskAppetite, 0.77, 'bob 决策风格不串');
  });

  it('★restore 按 persona★：恢复 alice 快照不影响 bob 的宽表状态', () => {
    os.getCore('p-alice').addValue('探索', 0.9);
    os.getCore('p-bob').addValue('稳健', 0.8);
    const snap = os.createSnapshot('manual', 'p-alice');
    /* 快照后两 persona 都改。 */
    os.getCore('p-alice').addValue('新价值', 0.5);
    os.getCore('p-bob').addValue('bob新价值', 0.5);
    assert.equal(os.getCore('p-alice').values.getAll().size, 2);
    assert.equal(os.getCore('p-bob').values.getAll().size, 2);
    /* 恢复 alice → alice 回到 1 个价值；bob 不受影响（仍 2 个）。 */
    os.restoreFromSnapshot(snap.id, { coreSelfOnly: true });
    assert.equal(os.getCore('p-alice').values.getAll().size, 1, 'alice 价值恢复到快照点');
    assert.deepEqual([...os.getCore('p-alice').values.getAll().values()].map((v) => v.label), ['探索']);
    assert.equal(os.getCore('p-bob').values.getAll().size, 2, 'bob 宽表不被 alice 回滚误伤');
  });

  it('★跨 persona 不能改写★：bob 用 alice 的 value id 做 update/delete 均不触及 alice（Codex 建议）', () => {
    const va = os.getCore('p-alice').addValue('探索', 0.9);
    /* bob 用 alice 的 id 尝试 update → 不命中（bob 无此 persona 的该行），alice 不变。 */
    const updated = os.getCore('p-bob').values.update(va.id, { weight: 0.1 });
    assert.equal(updated, undefined, 'bob update alice 的 id 不命中');
    assert.equal(os.getCore('p-alice').values.getById(va.id)?.weight, 0.9, 'alice 价值未被 bob 改');
    /* bob delete alice 的 id → 不命中，alice 仍在。 */
    assert.equal(os.getCore('p-bob').values.delete(va.id), false, 'bob delete alice 的 id 不命中');
    assert.equal(os.getCore('p-alice').values.getById(va.id)?.label, '探索', 'alice 价值仍在');
    /* bob 新建价值 → 落 bob 自己的 persona；alice 看不到。 */
    const vb = os.getCore('p-bob').addValue('稳健', 0.8);
    assert.equal(os.getCore('p-alice').values.getById(vb.id), undefined, 'alice 看不到 bob 新建的价值');
  });

  it('★确定性可复现★：同序列写入 → 同内容投影（非仅 size）', () => {
    const seed = (o: ChronoSynthOS): void => {
      o.getCore('p-x').addValue('探索', 0.9);
      o.getCore('p-x').addValue('稳健', 0.8);
      const m1 = o.getCore('p-x').addMemory('episodic', 'A', 0.5, 0.8);
      const m2 = o.getCore('p-x').addMemory('semantic', 'B', 0.3, 0.6);
      o.getCore('p-x').linkMemories(m1.id, m2.id, 'relates_to', 0.7);
      o.getCore('p-x').addSurvivalAnchor('诚信', 'threshold', { min: 0.8 }, 4);
    };
    /* 稳定内容投影：不含随机 UUID，只比对内容/权重/关系等确定性字段。 */
    const project = (o: ChronoSynthOS): string => {
      const s = o.getCore('p-x').getState();
      return JSON.stringify({
        values: [...s.values.values()].map((v) => [v.label, v.weight]).sort(),
        memories: [...s.memories.values()].map((m) => [m.kind, m.content, m.valence, m.salience]).sort(),
        edges: s.edges.map((e) => e.relation).sort(),
        anchors: s.survivalAnchors.map((a) => [a.label, a.kind, a.severity]).sort(),
      });
    };
    seed(os);
    const p1 = project(os);

    const os2 = new ChronoSynthOS({ clock: new TestClock(1000), logger: new SilentLogger(), tenantId: 't1' });
    os2.start();
    try {
      seed(os2);
      assert.equal(project(os2), p1, '同序列写入 → 同内容投影（确定性可复现）');
    } finally { os2.close(); }
  });
});
