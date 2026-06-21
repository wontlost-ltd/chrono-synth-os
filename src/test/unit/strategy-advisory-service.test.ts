import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { StrategyAdvisoryService, type StrategyInput, type StrategicInitiative } from '../../workforce/strategy-advisory-service.js';

/* M7 战略辅助层：人类战略输入 → 确定性多视角备选 → 恒需人类批准。零-LLM,非自动 CEO。 */
describe('StrategyAdvisoryService（M7 战略辅助层）', () => {
  const svc = new StrategyAdvisoryService();

  function ini(id: string, p: number, impact: number, feas: number, risk: StrategicInitiative['riskLevel'], cost: number): StrategicInitiative {
    return { id, title: id, goalType: 'content_piece', priority: p, impact, feasibility: feas, riskLevel: risk, estimatedCost: cost };
  }

  function input(overrides: Partial<StrategyInput> = {}): StrategyInput {
    return {
      objective: '本季度增长', budgetCap: 100, riskTolerance: 'medium',
      initiatives: [
        ini('a', 5, 5, 2, 'high', 40),   /* 高影响高优先但高风险低可行 */
        ini('b', 3, 3, 5, 'low', 30),    /* 中等但低风险高可行(速赢) */
        ini('c', 2, 4, 4, 'medium', 30), /* 中等 */
      ],
      ...overrides,
    };
  }

  it('★恒需人类批准★：requiresHumanApproval 永远 true（M7 不决策不自动执行）', () => {
    const r = svc.advise(input());
    assert.equal(r.requiresHumanApproval, true);
  });

  it('★三视角备选★：产出 impact_first / risk_averse / quick_wins 三个备选', () => {
    const r = svc.advise(input());
    assert.equal(r.alternatives.length, 3);
    assert.deepEqual(r.alternatives.map((a) => a.lens), ['impact_first', 'risk_averse', 'quick_wins']);
    assert.equal(r.objective, '本季度增长');
  });

  it('★不同透镜不同排序★：impact_first 把高影响 a 排前；risk_averse 把低风险 b 排前', () => {
    const r = svc.advise(input());
    const impactFirst = r.alternatives.find((a) => a.lens === 'impact_first')!;
    const riskAverse = r.alternatives.find((a) => a.lens === 'risk_averse')!;
    /* 影响优先：a(高影响高优先)应排第一。 */
    assert.equal(impactFirst.rankedInitiatives[0]!.initiative.id, 'a');
    /* 风险规避：高风险 a 被罚,低风险高可行 b 应排第一。 */
    assert.equal(riskAverse.rankedInitiatives[0]!.initiative.id, 'b');
  });

  it('★预算贪心纳入★：budgetCap 100，3 个各 30-40 → 按排序累加,超预算的不纳入', () => {
    /* budgetCap=70：只能纳入前两个（按排序，累计成本≤70）。 */
    const r = svc.advise(input({ budgetCap: 70 }));
    const alt = r.alternatives[0]!;
    assert.ok(alt.totalCost <= 70, '总成本不超预算');
    assert.ok(alt.includedCount < 3, '超预算的举措未纳入');
    /* 未纳入的仍在列表(included=false)供人类看。 */
    assert.equal(alt.rankedInitiatives.length, 3);
  });

  it('★风险升级标记★：超 riskTolerance 的举措 needsEscalation（即便纳入也单独批）', () => {
    /* riskTolerance=low → high(a)/medium(c) 都超 → needsEscalation。 */
    const r = svc.advise(input({ riskTolerance: 'low', budgetCap: 1000 }));
    const alt = r.alternatives[0]!;
    const a = alt.rankedInitiatives.find((x) => x.initiative.id === 'a')!;
    const b = alt.rankedInitiatives.find((x) => x.initiative.id === 'b')!;
    assert.equal(a.needsEscalation, true, 'high 超 low 容忍 → 升级');
    assert.equal(b.needsEscalation, false, 'low 不超 → 不升级');
    assert.ok(alt.escalationCount >= 1, '统计含升级举措数');
  });

  it('★确定性可复现★：相同输入 → 相同备选', () => {
    assert.deepEqual(svc.advise(input()), svc.advise(input()));
  });

  it('★并列得分稳定★：同分举措按 id 字典序兜底（确定性，不依赖 sort 稳定性）', () => {
    const tie: StrategyInput = {
      objective: 'x', budgetCap: 1000, riskTolerance: 'high',
      /* 两个完全同分举措 z 和 a → 排序应 a 在前（字典序）。 */
      initiatives: [ini('z', 3, 3, 3, 'low', 10), ini('a', 3, 3, 3, 'low', 10)],
    };
    const r = svc.advise(tie);
    assert.equal(r.alternatives[0]!.rankedInitiatives[0]!.initiative.id, 'a', '并列字典序 a 在前');
  });

  it('空举措 → 三个空备选,仍需人类批准', () => {
    const r = svc.advise(input({ initiatives: [] }));
    assert.equal(r.alternatives.length, 3);
    assert.ok(r.alternatives.every((a) => a.rankedInitiatives.length === 0 && a.totalCost === 0));
    assert.equal(r.requiresHumanApproval, true);
  });

  it('★不自动执行★：advise 只返回 proposal,不创建任何目标/不落库（纯函数无副作用）', () => {
    /* service 无 store 依赖 → 结构上不可能落库/执行,这是 M7「只建议不决策」的硬保证。 */
    const r = svc.advise(input());
    /* 返回的是 proposal 数据,没有 goalId/执行句柄。 */
    assert.ok(!('goalId' in r), '不产生可执行目标');
    assert.equal(r.requiresHumanApproval, true);
  });
});
