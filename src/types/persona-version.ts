/**
 * 人格版本（快层）类型定义
 * 处理并行模拟、实验和自适应模型
 */

/** 人格版本唯一标识 */
export type PersonaVersionId = string;

/** 人格版本运行状态 */
export type PersonaStatus = 'active' | 'paused' | 'completed' | 'failed';

/** 模拟场景定义 */
export interface SimulationScenario {
  readonly id: string;
  readonly description: string;
  /** 场景参数：键值对 */
  readonly params: ReadonlyMap<string, unknown>;
}

/** 模拟结果 */
export interface SimulationResult {
  readonly scenarioId: string;
  readonly personaVersionId: PersonaVersionId;
  /** 适应度评分 0-1 */
  readonly fitnessScore: number;
  /** 建议的价值目标权重（绝对值 0-1，由 IntegrationEngine.apply 限幅后应用） */
  readonly valueAdjustments: ReadonlyMap<string, number>;
  /** 新发现的记忆或洞察 */
  readonly insights: readonly string[];
  readonly completedAt: number;
}

/** 人格版本定义 */
export interface PersonaVersion {
  readonly id: PersonaVersionId;
  readonly label: string;
  /** 从核心自我分叉时的价值权重副本 */
  readonly values: ReadonlyMap<string, number>;
  status: PersonaStatus;
  /** 该版本产生的模拟结果 */
  readonly results: SimulationResult[];
  /** 资源消耗配额 0-1 */
  resourceQuota: number;
  readonly createdAt: number;
  updatedAt: number;
}
