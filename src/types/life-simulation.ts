/**
 * 人生模拟引擎类型定义
 * 核心类型 re-export 自 kernel，DB 记录类型为应用层
 */

export type {
  EmotionalState,
  FamilyState,
  FinanceState,
  YearState,
  LifePathBranch,
  LifePath,
  StressTestConfig,
  LifeSimulationConfig,
  BranchResult,
  RetrospectiveScore,
  LifePathResult,
  LifeSimulationResult,
  SimulationProgress,
} from '@chrono/kernel';

/** 数据库记录：模拟任务 */
export interface LifeSimulationRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly taskId: string;
  readonly baseSimulationId: string | null;
  readonly configJson: string;
  readonly status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  readonly summaryJson: string | null;
  readonly progressJson: string | null;
  readonly error: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly completedAt: number | null;
}

/** 数据库记录：模拟路径 */
export interface LifeSimulationPathRecord {
  readonly id: string;
  readonly simulationId: string;
  readonly pathId: string;
  readonly label: string;
  readonly status: 'pending' | 'running' | 'completed' | 'failed';
  readonly summaryJson: string | null;
  readonly timelineJson: string | null;
  readonly branchesJson: string | null;
  readonly retrospectiveJson: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}
