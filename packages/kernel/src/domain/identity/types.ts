/**
 * 身份与分身系统类型定义
 */

/** 身份 */
export interface Identity {
  readonly id: string;
  readonly userId: string;
  readonly tenantId: string;
  displayName: string;
  bio: string | null;
  readonly createdAt: number;
  updatedAt: number;
}

/** 分身类型 */
export type AvatarKind = 'general' | 'work' | 'social' | 'family' | 'creative';

/** 行为覆盖参数 */
export interface BehaviorOverrides {
  /** L1 价值权重偏移，值域 -0.3 ~ +0.3 */
  valueWeightAdjustments?: Record<string, number>;
  /** L2 决策风格覆盖 */
  decisionStyleOverrides?: {
    riskAppetite?: number;
    timeHorizon?: number;
    explorationBias?: number;
  };
  /** L3 场景特定信念 */
  contextBeliefs?: Record<string, number>;
  /** L4 记忆过滤 */
  memoryFilter?: {
    kinds?: Array<'episodic' | 'semantic' | 'procedural'>;
    minSalience?: number;
  };
}

/** 分身 */
export interface Avatar {
  readonly id: string;
  readonly identityId: string;
  label: string;
  kind: AvatarKind;
  behaviorOverrides: BehaviorOverrides | null;
  isDefault: boolean;
  isActive: boolean;
  readonly createdAt: number;
  updatedAt: number;
}

/** 设备-分身绑定 */
export interface DeviceAvatar {
  readonly id: string;
  readonly deviceId: string;
  readonly avatarId: string;
  isActive: boolean;
  readonly installedAt: number;
}
