/**
 * 更新闸门 — 纯领域类型与决策逻辑
 * L0/L1 更新确认机制
 * 零 node:* 依赖
 */

export type UpdateTrigger = 'emotional_event' | 'statistical_drift' | 'user_confirmation' | 'system_integration';

export interface UpdateGateConfig {
  l0RequiresConfirmation: boolean;
  l1ConfirmationThreshold: number;
  driftWindowMs: number;
  driftSignificanceThreshold: number;
}

export interface PendingUpdate {
  readonly id: string;
  readonly layer: 'L0' | 'L1';
  readonly trigger: UpdateTrigger;
  readonly targetId: string;
  readonly currentValue: string;
  readonly proposedValue: string;
  readonly delta: number;
  readonly reason: string;
  readonly createdAt: number;
  status: 'pending' | 'approved' | 'rejected';
}

export const DEFAULT_UPDATE_GATE_CONFIG: UpdateGateConfig = {
  l0RequiresConfirmation: true,
  l1ConfirmationThreshold: 0.15,
  driftWindowMs: 86_400_000,
  driftSignificanceThreshold: 0.3,
};

/**
 * 判断指定层级和变更幅度是否需要人工确认（纯函数）
 */
export function requiresConfirmation(
  config: UpdateGateConfig,
  layer: 'L0' | 'L1',
  delta: number,
): boolean {
  if (layer === 'L0') return config.l0RequiresConfirmation;
  return Math.abs(delta) > config.l1ConfirmationThreshold;
}
