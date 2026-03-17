/**
 * 健康衰减子模型 — 薄适配器，re-export kernel 领域逻辑
 */

export {
  DEFAULT_HEALTH_CONFIG,
  nextHealthIndex,
} from '@chrono/kernel';
export type { HealthConfig, HealthInputs } from '@chrono/kernel';
