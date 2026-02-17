/**
 * 数学工具函数
 */

/** 将值限制在 [min, max] 范围内，非有限值返回 min */
export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

/** 将值限制在 [0, 1] 范围内 */
export function clamp01(value: number): number {
  return clamp(value, 0, 1);
}
