import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseMetrics,
  resolutionStep,
  pickMetrics,
  downsampleTimeline,
  computeStats,
  extractMilestones,
  computePivotYear,
  CORE_METRICS,
  ALL_METRICS,
  METRIC_META,
  type MetricKey,
} from '../../simulation/visualization-helpers.js';
import type { YearState } from '../../types/life-simulation.js';

function makeYearState(year: number, overrides: Partial<YearState> = {}): YearState {
  return {
    year,
    wealth: 500000 + year * 10000,
    healthIndex: 0.9 - year * 0.01,
    overallScore: 0.7 + year * 0.01,
    emotionalState: { valence: 0.5, stress: 0.3, fulfillment: 0.6, regret: 0.1 },
    familyState: { spouseSecurity: 0.7, childCost: 50000, familyPressure: 0.2 },
    valueWeights: {},
    ...overrides,
  };
}

describe('parseMetrics', () => {
  it('空参数返回核心指标', () => {
    const result = parseMetrics();
    assert.deepStrictEqual(result, [...CORE_METRICS]);
  });

  it('空字符串返回核心指标', () => {
    assert.deepStrictEqual(parseMetrics(''), [...CORE_METRICS]);
  });

  it('有效指标正确解析', () => {
    const result = parseMetrics('wealth,healthIndex,emotionalState.stress');
    assert.deepStrictEqual(result, ['wealth', 'healthIndex', 'emotionalState.stress']);
  });

  it('无效指标抛 ValidationError', () => {
    assert.throws(
      () => parseMetrics('wealth,invalidMetric'),
      (err: Error) => err.message.includes('无效指标'),
    );
  });

  it('重复指标自动去重', () => {
    const result = parseMetrics('wealth,wealth,healthIndex');
    assert.deepStrictEqual(result, ['wealth', 'healthIndex']);
  });
});

describe('METRIC_META', () => {
  it('每个 ALL_METRICS 指标都有元数据', () => {
    for (const key of ALL_METRICS) {
      const meta = METRIC_META.get(key);
      assert.ok(meta, `缺少 ${key} 的元数据`);
      assert.ok(meta!.label, `${key} 缺少 label`);
      assert.ok(Array.isArray(meta!.range), `${key} 缺少 range`);
    }
  });
});

describe('resolutionStep', () => {
  it('year → 1', () => assert.strictEqual(resolutionStep('year'), 1));
  it('2y → 2', () => assert.strictEqual(resolutionStep('2y'), 2));
  it('5y → 5', () => assert.strictEqual(resolutionStep('5y'), 5));
});

describe('pickMetrics', () => {
  it('提取顶层字段', () => {
    const state = makeYearState(1);
    const values = pickMetrics(state, ['wealth', 'healthIndex']);
    assert.strictEqual(values.wealth, state.wealth);
    assert.strictEqual(values.healthIndex, state.healthIndex);
  });

  it('提取嵌套字段', () => {
    const state = makeYearState(1);
    const values = pickMetrics(state, ['emotionalState.valence', 'familyState.spouseSecurity']);
    assert.strictEqual(values['emotionalState.valence'], 0.5);
    assert.strictEqual(values['familyState.spouseSecurity'], 0.7);
  });

  it('不存在的字段忽略', () => {
    const state = makeYearState(1);
    const values = pickMetrics(state, ['wealth']);
    assert.strictEqual(Object.keys(values).length, 1);
  });
});

describe('downsampleTimeline', () => {
  const timeline: YearState[] = Array.from({ length: 10 }, (_, i) => makeYearState(i + 1));

  it('step=1 不下采样', () => {
    const points = downsampleTimeline(timeline, ['wealth'], 1);
    assert.strictEqual(points.length, 10);
    assert.strictEqual(points[0].year, 1);
    assert.strictEqual(points[9].year, 10);
  });

  it('step=2 下采样为 5 个桶', () => {
    const points = downsampleTimeline(timeline, ['wealth'], 2);
    assert.strictEqual(points.length, 5);
    assert.strictEqual(points[0].year, 1);
    assert.strictEqual(points[4].year, 9);
  });

  it('step=5 下采样为 2 个桶', () => {
    const points = downsampleTimeline(timeline, ['wealth'], 5);
    assert.strictEqual(points.length, 2);
    assert.strictEqual(points[0].year, 1);
  });

  it('桶内取平均', () => {
    const points = downsampleTimeline(timeline, ['wealth'], 2);
    /* 第一个桶：year 1 (510000) + year 2 (520000) = 515000 */
    assert.strictEqual(points[0].values.wealth, 515000);
  });

  it('空时间线返回空', () => {
    assert.deepStrictEqual(downsampleTimeline([], ['wealth'], 1), []);
  });
});

describe('computeStats', () => {
  it('计算 min/max/avg/last', () => {
    const points = [
      { year: 1, values: { wealth: 100 } },
      { year: 2, values: { wealth: 300 } },
      { year: 3, values: { wealth: 200 } },
    ];
    const stats = computeStats(points, ['wealth' as MetricKey]);
    assert.strictEqual(stats.min.wealth, 100);
    assert.strictEqual(stats.max.wealth, 300);
    assert.strictEqual(stats.avg.wealth, 200);
    assert.strictEqual(stats.last.wealth, 200);
  });

  it('空 points 返回空对象', () => {
    const stats = computeStats([], ['wealth' as MetricKey]);
    assert.strictEqual(stats.min.wealth, undefined);
  });

  it('多指标独立统计', () => {
    const points = [
      { year: 1, values: { wealth: 100, healthIndex: 0.9 } },
      { year: 2, values: { wealth: 200, healthIndex: 0.7 } },
    ];
    const stats = computeStats(points, ['wealth' as MetricKey, 'healthIndex' as MetricKey]);
    assert.strictEqual(stats.min.wealth, 100);
    assert.strictEqual(stats.max.healthIndex, 0.9);
    assert.strictEqual(stats.last.healthIndex, 0.7);
  });
});

describe('extractMilestones', () => {
  it('提取峰值和谷值', () => {
    const timeline: YearState[] = [
      makeYearState(1, { wealth: 100 }),
      makeYearState(2, { wealth: 500 }),
      makeYearState(3, { wealth: 200 }),
    ];
    const events = extractMilestones(timeline, ['wealth']);
    const peak = events.find(e => e.kind === 'peak');
    const trough = events.find(e => e.kind === 'trough');
    assert.ok(peak);
    assert.strictEqual(peak.year, 2);
    assert.strictEqual(peak.value, 500);
    assert.ok(trough);
    assert.strictEqual(trough.year, 1);
    assert.strictEqual(trough.value, 100);
  });

  it('健康指数低于 0.6 触发 cross_down', () => {
    const timeline: YearState[] = [
      makeYearState(1, { healthIndex: 0.7 }),
      makeYearState(2, { healthIndex: 0.55 }),
    ];
    const events = extractMilestones(timeline, ['healthIndex']);
    const cross = events.find(e => e.kind === 'cross_down');
    assert.ok(cross, '应检测到 healthIndex cross_down');
    assert.strictEqual(cross.threshold, 0.6);
  });

  it('压力超过 0.7 触发 cross_up', () => {
    const timeline: YearState[] = [
      makeYearState(1, { emotionalState: { valence: 0.5, stress: 0.6, fulfillment: 0.6, regret: 0.1 } }),
      makeYearState(2, { emotionalState: { valence: 0.5, stress: 0.8, fulfillment: 0.6, regret: 0.1 } }),
    ];
    const events = extractMilestones(timeline, ['emotionalState.stress']);
    const cross = events.find(e => e.kind === 'cross_up');
    assert.ok(cross, '应检测到 stress cross_up');
    assert.strictEqual(cross.threshold, 0.7);
  });

  it('空时间线返回空', () => {
    assert.deepStrictEqual(extractMilestones([], ['wealth']), []);
  });

  it('单值序列只有 peak 无 trough', () => {
    const timeline: YearState[] = [makeYearState(1, { wealth: 100 })];
    const events = extractMilestones(timeline, ['wealth']);
    assert.strictEqual(events.filter(e => e.kind === 'peak').length, 1);
    assert.strictEqual(events.filter(e => e.kind === 'trough').length, 0);
  });

  it('全值相同只有 peak 无 trough', () => {
    const timeline: YearState[] = [
      makeYearState(1, { wealth: 200 }),
      makeYearState(2, { wealth: 200 }),
      makeYearState(3, { wealth: 200 }),
    ];
    const events = extractMilestones(timeline, ['wealth']);
    /* peakIdx === troughIdx === 0 → 只产生 peak */
    assert.strictEqual(events.filter(e => e.kind === 'peak').length, 1);
    assert.strictEqual(events.filter(e => e.kind === 'trough').length, 0);
  });
});

describe('computePivotYear', () => {
  it('正常反推', () => {
    assert.strictEqual(computePivotYear(10, 5), 5);
  });

  it('分支时间线为 0 → 返回 horizonYears', () => {
    assert.strictEqual(computePivotYear(10, 0), 10);
  });

  it('分支时间线等于 horizonYears → pivotYear = 1', () => {
    /* 10 - 10 = 0 → Math.max(1, 0) = 1 */
    assert.strictEqual(computePivotYear(10, 10), 1);
  });
});
