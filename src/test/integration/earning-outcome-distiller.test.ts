/**
 * ADR-0048 D5：收益蒸馏器集成测试。
 * 任务收益 → 蒸馏候选 → 经 ADR-0047 门编译进核心（闭合 earn→grow 飞轮）。
 * 验证：高质量自动成长、低质量不奖励、无映射跳过、强信号自动编译改核心权重。
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ChronoSynthOS } from '../../chrono-synth-os.js';
import { TestClock, SilentLogger } from '../../utils/index.js';

describe('EarningOutcomeDistiller (ADR-0048 D5)', () => {
  let os: ChronoSynthOS;

  beforeEach(() => {
    os = new ChronoSynthOS({ clock: new TestClock(1000), logger: new SilentLogger() });
    os.start();
  });
  afterEach(() => os.close());

  it('高质量任务（强信号）→ value_shift 自动编译，核心权重上升', () => {
    const v = os.core.addValue('diligence', 0.5);
    const r = os.earningDistiller.distill({
      tenantId: 'default', personaId: 'p1', taskId: 'mkt_1', category: 'research',
      qualityScore: 0.9, payout: 40,
      targetValue: { valueId: v.id, currentWeight: 0.5 },
    });
    assert.equal(r.candidatesIngested, 1);
    assert.equal(r.results[0].status, 'compiled');
    /* 强信号 delta = 0.05*0.9 = 0.045 ≤ 0.05 且 patternAgrees → 自动编译 */
    assert.ok((os.core.values.getById(v.id)?.weight ?? 0) > 0.5);
  });

  it('中等质量（弱信号）→ value_shift 待人工审批，核心不变', () => {
    const v = os.core.addValue('diligence', 0.5);
    const r = os.earningDistiller.distill({
      tenantId: 'default', personaId: 'p1', taskId: 'mkt_2', category: 'research',
      qualityScore: 0.6, payout: 20,
      targetValue: { valueId: v.id, currentWeight: 0.5 },
    });
    assert.equal(r.candidatesIngested, 1);
    assert.equal(r.results[0].status, 'pending'); /* conf 0.7 < 0.8 → 不自动编译 */
    assert.equal(os.core.values.getById(v.id)?.weight, 0.5, '待审批不改核心');
  });

  it('低质量（<0.5）→ 不产成长候选（不奖励烂活）', () => {
    const v = os.core.addValue('diligence', 0.5);
    const r = os.earningDistiller.distill({
      tenantId: 'default', personaId: 'p1', taskId: 'mkt_3', category: 'research',
      qualityScore: 0.3, payout: 10,
      targetValue: { valueId: v.id, currentWeight: 0.5 },
    });
    assert.equal(r.candidatesIngested, 0);
    assert.equal(os.distillation.listByPersona('p1').length, 0);
  });

  it('无 category→value 映射 → 跳过（不产 value_shift）', () => {
    const r = os.earningDistiller.distill({
      tenantId: 'default', personaId: 'p1', taskId: 'mkt_4', category: 'coding',
      qualityScore: 0.95, payout: 50,
    });
    assert.equal(r.candidatesIngested, 0);
  });

  it('提供 linkMemory → 额外产 memory_edge 候选（ADR D5）', () => {
    const v = os.core.addValue('diligence', 0.5);
    const m1 = os.core.addMemory('episodic', 'task A', 0.5, 0.7);
    const m2 = os.core.addMemory('semantic', 'skill B', 0.3, 0.6);
    const r = os.earningDistiller.distill({
      tenantId: 'default', personaId: 'p1', taskId: 'mkt_e', category: 'research',
      qualityScore: 0.9, payout: 40,
      targetValue: { valueId: v.id, currentWeight: 0.5 },
      linkMemory: { sourceId: m1.id, targetId: m2.id, relation: 'reinforced_by' },
    });
    /* value_shift + memory_edge 两个候选 */
    assert.equal(r.candidatesIngested, 2);
    const kinds = os.distillation.listByPersona('p1').map((a) => a.kind).sort();
    assert.deepEqual(kinds, ['memory_edge', 'value_shift']);
  });

  it('无 value 映射但有 linkMemory → 仅产 memory_edge', () => {
    const m1 = os.core.addMemory('episodic', 'A', 0.5, 0.7);
    const m2 = os.core.addMemory('semantic', 'B', 0.3, 0.6);
    const r = os.earningDistiller.distill({
      tenantId: 'default', personaId: 'p1', taskId: 'mkt_e2', category: 'coding',
      qualityScore: 0.9, payout: 30,
      linkMemory: { sourceId: m1.id, targetId: m2.id, relation: 'reinforced_by' },
    });
    assert.equal(r.candidatesIngested, 1);
    assert.equal(os.distillation.listByPersona('p1')[0].kind, 'memory_edge');
  });

  it('收益蒸馏候选进入审计历史', () => {
    const v = os.core.addValue('diligence', 0.5);
    os.earningDistiller.distill({
      tenantId: 'default', personaId: 'p1', taskId: 'mkt_5', category: 'research',
      qualityScore: 0.9, payout: 40,
      targetValue: { valueId: v.id, currentWeight: 0.5 },
    });
    const all = os.distillation.listByPersona('p1');
    assert.equal(all.length, 1);
    assert.equal(all[0].kind, 'value_shift');
    /* source=reflection：收益学习是 persona 对自己任务结果的 internal 反思（信任分级修正了旧的
     * conversation 误标，见 EarningOutcomeDistiller 注释）。 */
    assert.equal(all[0].source, 'reflection');
  });
});
