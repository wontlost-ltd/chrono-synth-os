/**
 * 可视化纯函数 — 指标解析、时间线下采样、统计聚合、里程碑提取
 * 零 node:* 依赖
 */

import type { YearState } from './life-simulation-types.js';
import { ValidationError, ErrorCode } from '../errors.js';

/** 可视化支持的指标键（含嵌套路径） */
export type MetricKey =
  | 'wealth' | 'healthIndex' | 'overallScore'
  | 'emotionalState.valence' | 'emotionalState.stress'
  | 'emotionalState.fulfillment' | 'emotionalState.regret'
  | 'familyState.spouseSecurity' | 'familyState.childCost'
  | 'familyState.familyPressure';

export type Resolution = 'year' | '2y' | '5y';

export interface MetricPoint {
  readonly year: number;
  readonly values: Partial<Record<MetricKey, number>>;
}

export interface SeriesStats {
  readonly min: Partial<Record<MetricKey, number>>;
  readonly max: Partial<Record<MetricKey, number>>;
  readonly avg: Partial<Record<MetricKey, number>>;
  readonly last: Partial<Record<MetricKey, number>>;
}

export interface MilestoneEvent {
  readonly year: number;
  readonly metric: MetricKey;
  readonly kind: 'peak' | 'trough' | 'cross_up' | 'cross_down';
  readonly value: number;
  readonly threshold?: number;
}

/** 指标元数据（label + unit + range，用于前端展示和可访问性） */
export interface MetricMeta {
  readonly key: MetricKey;
  readonly label: string;
  readonly unit: string;
  readonly range: readonly [number, number];
}

export const METRIC_META: ReadonlyMap<MetricKey, MetricMeta> = new Map<MetricKey, MetricMeta>([
  ['wealth', { key: 'wealth', label: '财富', unit: '¥', range: [0, Infinity] }],
  ['healthIndex', { key: 'healthIndex', label: '健康指数', unit: '', range: [0, 1] }],
  ['overallScore', { key: 'overallScore', label: '综合评分', unit: '', range: [0, 1] }],
  ['emotionalState.valence', { key: 'emotionalState.valence', label: '情绪效价', unit: '', range: [-1, 1] }],
  ['emotionalState.stress', { key: 'emotionalState.stress', label: '压力', unit: '', range: [0, 1] }],
  ['emotionalState.fulfillment', { key: 'emotionalState.fulfillment', label: '成就感', unit: '', range: [0, 1] }],
  ['emotionalState.regret', { key: 'emotionalState.regret', label: '后悔', unit: '', range: [0, 1] }],
  ['familyState.spouseSecurity', { key: 'familyState.spouseSecurity', label: '配偶安全感', unit: '', range: [0, 1] }],
  ['familyState.childCost', { key: 'familyState.childCost', label: '育儿成本', unit: '¥/年', range: [0, Infinity] }],
  ['familyState.familyPressure', { key: 'familyState.familyPressure', label: '家庭压力', unit: '', range: [0, 1] }],
]);

/** 默认核心指标（前端仪表盘最常用） */
export const CORE_METRICS: readonly MetricKey[] = [
  'wealth', 'healthIndex', 'overallScore', 'emotionalState.valence',
];

/** 全量指标集 */
export const ALL_METRICS: ReadonlySet<MetricKey> = new Set<MetricKey>([
  'wealth', 'healthIndex', 'overallScore',
  'emotionalState.valence', 'emotionalState.stress',
  'emotionalState.fulfillment', 'emotionalState.regret',
  'familyState.spouseSecurity', 'familyState.childCost',
  'familyState.familyPressure',
]);

/** 阈值穿越检测配置 */
const THRESHOLDS: ReadonlyArray<{ metric: MetricKey; value: number; direction: 'cross_down' | 'cross_up' }> = [
  { metric: 'healthIndex', value: 0.6, direction: 'cross_down' },
  { metric: 'emotionalState.stress', value: 0.7, direction: 'cross_up' },
  { metric: 'emotionalState.regret', value: 0.6, direction: 'cross_up' },
  { metric: 'familyState.familyPressure', value: 0.7, direction: 'cross_up' },
];

/** 解析嵌套指标路径（如 'emotionalState.valence'） */
function resolveMetric(state: YearState, key: MetricKey): number | undefined {
  const dotIdx = key.indexOf('.');
  if (dotIdx === -1) {
    const v = (state as unknown as Record<string, unknown>)[key];
    return typeof v === 'number' ? v : undefined;
  }
  const [parent, child] = [key.slice(0, dotIdx), key.slice(dotIdx + 1)];
  const nested = (state as unknown as Record<string, unknown>)[parent];
  if (nested && typeof nested === 'object') {
    const v = (nested as Record<string, unknown>)[child];
    return typeof v === 'number' ? v : undefined;
  }
  return undefined;
}

/**
 * 解析 metrics 查询参数
 * 空/undefined → 返回 CORE_METRICS；无效指标 → 抛 ValidationError
 */
export function parseMetrics(raw?: string): MetricKey[] {
  if (!raw || raw.trim() === '') return [...CORE_METRICS];
  const keys = raw.split(',').map(k => k.trim()).filter(Boolean);
  const invalid = keys.filter(k => !ALL_METRICS.has(k as MetricKey));
  if (invalid.length > 0) {
    throw new ValidationError(
      `无效指标: ${invalid.join(', ')}`,
      ErrorCode.VALIDATION_FORMAT,
    );
  }
  return [...new Set(keys)] as MetricKey[];
}

/** Resolution → 步长年数 */
export function resolutionStep(res: Resolution): number {
  switch (res) {
    case 'year': return 1;
    case '2y': return 2;
    case '5y': return 5;
  }
}

/** 从 YearState 提取指定指标值 */
export function pickMetrics(state: YearState, metrics: MetricKey[]): MetricPoint['values'] {
  const values: Record<string, number> = {};
  for (const key of metrics) {
    const v = resolveMetric(state, key);
    if (v !== undefined) values[key] = v;
  }
  return values as MetricPoint['values'];
}

/** 下采样时间线：按步长分桶取平均 */
export function downsampleTimeline(
  timeline: readonly YearState[],
  metrics: MetricKey[],
  step: number,
): MetricPoint[] {
  if (timeline.length === 0 || step < 1) return [];
  if (step === 1) {
    return timeline.map(s => ({ year: s.year, values: pickMetrics(s, metrics) }));
  }

  const points: MetricPoint[] = [];
  for (let i = 0; i < timeline.length; i += step) {
    const bucket = timeline.slice(i, i + step);
    const avgValues: Record<string, number> = {};
    for (const key of metrics) {
      let sum = 0;
      let count = 0;
      for (const s of bucket) {
        const v = resolveMetric(s, key);
        if (v !== undefined) { sum += v; count++; }
      }
      if (count > 0) avgValues[key] = sum / count;
    }
    points.push({ year: bucket[0].year, values: avgValues as MetricPoint['values'] });
  }
  return points;
}

/** 计算 SeriesStats */
export function computeStats(points: readonly MetricPoint[], metrics: MetricKey[]): SeriesStats {
  const min: Record<string, number> = {};
  const max: Record<string, number> = {};
  const sum: Record<string, number> = {};
  const count: Record<string, number> = {};

  for (const p of points) {
    for (const key of metrics) {
      const v = p.values[key];
      if (v === undefined) continue;
      if (min[key] === undefined || v < min[key]) min[key] = v;
      if (max[key] === undefined || v > max[key]) max[key] = v;
      sum[key] = (sum[key] ?? 0) + v;
      count[key] = (count[key] ?? 0) + 1;
    }
  }

  const avg: Record<string, number> = {};
  for (const key of metrics) {
    if (count[key]) avg[key] = sum[key] / count[key];
  }

  const last: Record<string, number> = {};
  if (points.length > 0) {
    const lastPoint = points[points.length - 1];
    for (const key of metrics) {
      const v = lastPoint.values[key];
      if (v !== undefined) last[key] = v;
    }
  }

  return {
    min: min as SeriesStats['min'],
    max: max as SeriesStats['max'],
    avg: avg as SeriesStats['avg'],
    last: last as SeriesStats['last'],
  };
}

/** 从时间线提取里程碑（峰值/谷值/阈值穿越） */
export function extractMilestones(
  timeline: readonly YearState[],
  metrics: MetricKey[],
): MilestoneEvent[] {
  if (timeline.length === 0) return [];

  const events: MilestoneEvent[] = [];

  for (const metric of metrics) {
    const series = timeline.map(s => ({ year: s.year, value: resolveMetric(s, metric) }))
      .filter((p): p is { year: number; value: number } => p.value !== undefined);
    if (series.length === 0) continue;

    /* 全局峰值和谷值 */
    let peakIdx = 0;
    let troughIdx = 0;
    for (let i = 1; i < series.length; i++) {
      if (series[i].value > series[peakIdx].value) peakIdx = i;
      if (series[i].value < series[troughIdx].value) troughIdx = i;
    }
    events.push({ year: series[peakIdx].year, metric, kind: 'peak', value: series[peakIdx].value });
    if (peakIdx !== troughIdx) {
      events.push({ year: series[troughIdx].year, metric, kind: 'trough', value: series[troughIdx].value });
    }

    /* 阈值穿越检测 */
    for (const th of THRESHOLDS) {
      if (th.metric !== metric) continue;
      for (let i = 1; i < series.length; i++) {
        const prev = series[i - 1].value;
        const curr = series[i].value;
        if (th.direction === 'cross_down' && prev >= th.value && curr < th.value) {
          events.push({ year: series[i].year, metric, kind: 'cross_down', value: curr, threshold: th.value });
        } else if (th.direction === 'cross_up' && prev <= th.value && curr > th.value) {
          events.push({ year: series[i].year, metric, kind: 'cross_up', value: curr, threshold: th.value });
        }
      }
    }
  }

  return events;
}

/** 计算分支 pivotYear（从 branchTimeline 长度反推） */
export function computePivotYear(horizonYears: number, branchTimelineLength: number): number {
  if (branchTimelineLength <= 0) return horizonYears;
  return Math.max(1, horizonYears - branchTimelineLength);
}
