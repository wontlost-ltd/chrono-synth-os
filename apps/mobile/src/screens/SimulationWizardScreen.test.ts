/**
 * SimulationWizardScreen payload 构造单测（修死链回归）。
 *
 * 背景：原向导打 POST /api/v1/decisions/simulate（无 :id）→ 404 死链，且 payload {horizonYears,values} 与
 * 后端 decisions 域不符。修复：改打 POST /api/v1/simulations/life，payload 转成后端 CreateLifeSimulationSchema
 * 要的 paths[]（≥2 条候选路径，权重进 initialConditions）。本测试锁住转换正确性。
 */

import { buildLifeSimulationPayload } from './SimulationWizardScreen';

describe('buildLifeSimulationPayload（life-simulation 请求构造）', () => {
  it('全部模板作候选路径，满足后端 paths ≥2 条', () => {
    const payload = buildLifeSimulationPayload('career', [{ dimension: 'career_growth', weight: 0.5 }], 10);
    expect(payload.paths.length).toBeGreaterThanOrEqual(2);
    expect(payload.horizonYears).toBe(10);
  });

  it('选中模板用当前调整后的权重覆盖 initialConditions', () => {
    const tweaked = [{ dimension: 'career_growth', weight: 0.9 }, { dimension: 'financial_stability', weight: 0.1 }];
    const payload = buildLifeSimulationPayload('career', tweaked, 15);
    const career = payload.paths.find(p => p.id === 'career');
    expect(career?.initialConditions).toEqual({ career_growth: 0.9, financial_stability: 0.1 });
  });

  it('未选中的模板用其默认权重（不受当前 values 影响）', () => {
    const payload = buildLifeSimulationPayload('career', [{ dimension: 'x', weight: 1 }], 10);
    const family = payload.paths.find(p => p.id === 'family');
    /* family 非选中 → 用其 defaults，不含选中模板的 values。 */
    expect(family?.initialConditions).not.toHaveProperty('x');
    expect(Object.keys(family?.initialConditions ?? {}).length).toBeGreaterThan(0);
  });

  it('每条 path 结构完整（id/label/description/initialConditions/空 branches）', () => {
    const payload = buildLifeSimulationPayload(null, [], 10);
    for (const p of payload.paths) {
      expect(typeof p.id).toBe('string');
      expect(typeof p.label).toBe('string');
      expect(typeof p.description).toBe('string');
      expect(typeof p.initialConditions).toBe('object');
      expect(p.branches).toEqual([]);
    }
  });
});
