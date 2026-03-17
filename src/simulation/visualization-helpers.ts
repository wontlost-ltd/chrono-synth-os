/**
 * 可视化纯函数 — 薄适配器，re-export kernel 领域逻辑
 */

export type { MetricKey, Resolution, MetricPoint, SeriesStats, MilestoneEvent, MetricMeta } from '@chrono/kernel';
export {
  METRIC_META,
  CORE_METRICS,
  ALL_METRICS,
  parseMetrics,
  resolutionStep,
  pickMetrics,
  downsampleTimeline,
  computeStats,
  extractMilestones,
  computePivotYear,
} from '@chrono/kernel';
