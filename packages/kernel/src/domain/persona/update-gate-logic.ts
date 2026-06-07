/**
 * 更新闸门 — 纯领域类型与决策逻辑
 * L0/L1 更新确认机制
 * 零 node:* 依赖
 */

import {
  decideCoreUpdateGate,
  DEFAULT_CORE_UPDATE_GATE_POLICY,
} from '../core-self/core-update-gate.js';

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
  /* L0/L1 阈值从统一门控 policy 派生（单一事实来源），杜绝与 distillation 门控漂移。
   * driftWindow/driftSignificance 是 UpdateGate 专属（当前未被判定使用），保留本地默认。 */
  l0RequiresConfirmation: DEFAULT_CORE_UPDATE_GATE_POLICY.deterministicL0RequiresConfirmation,
  l1ConfirmationThreshold: DEFAULT_CORE_UPDATE_GATE_POLICY.deterministicL1MaxAutoDelta,
  driftWindowMs: 86_400_000,
  driftSignificanceThreshold: 0.3,
};

/**
 * 判断指定层级和变更幅度是否需要人工确认（纯函数）。
 *
 * 判定委托给统一共享门控层 decideCoreUpdateGate（deterministic 来源——UpdateGate 的
 * 触发都是确定性可信流程，非 LLM），把本 config 的阈值适配进统一 policy。这样 UpdateGate
 * 与 distillation 的门控阈值同源，杜绝漂移。行为与旧实现等价（L0 看开关；L1 看 |delta| 阈值）。
 */
export function requiresConfirmation(
  config: UpdateGateConfig,
  layer: 'L0' | 'L1',
  delta: number,
): boolean {
  const result = decideCoreUpdateGate(
    { layer, sourceClass: 'deterministic', delta },
    {
      ...DEFAULT_CORE_UPDATE_GATE_POLICY,
      deterministicL0RequiresConfirmation: config.l0RequiresConfirmation,
      deterministicL1MaxAutoDelta: config.l1ConfirmationThreshold,
    },
  );
  return result.decision === 'confirm';
}
