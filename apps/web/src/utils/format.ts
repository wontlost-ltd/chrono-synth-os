/** 格式化数字为中文万/亿单位 */
export function formatCurrency(value: number): string {
  if (Math.abs(value) >= 1_0000_0000) return `${(value / 1_0000_0000).toFixed(2)}亿`;
  if (Math.abs(value) >= 1_0000) return `${(value / 1_0000).toFixed(1)}万`;
  return value.toLocaleString('zh-CN');
}

/** 格式化小数为百分比 */
export function formatPercent(value: number, digits = 1): string {
  return `${(value * 100).toFixed(digits)}%`;
}

/** 格式化 0-1 的指标值 */
export function formatMetricValue(value: number, unit: string): string {
  if (value == null || Number.isNaN(value)) return '-';
  if (unit === '¥' || unit === '¥/年') return `¥${formatCurrency(value)}`;
  if (value >= -1 && value <= 1 && !unit) return value.toFixed(3);
  return value.toLocaleString('zh-CN');
}

/** 趋势方向 */
export function trendDirection(current: number, previous: number): 'up' | 'down' | 'flat' {
  const delta = current - previous;
  if (Math.abs(delta) < 0.001) return 'flat';
  return delta > 0 ? 'up' : 'down';
}
