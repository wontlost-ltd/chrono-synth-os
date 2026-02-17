/**
 * 人生模拟引擎类型定义
 * 支持多路径、多年时间序列、家庭系统耦合、概率分支、压力测试
 */

/** 情绪状态 */
export interface EmotionalState {
  readonly valence: number;     // -1..1
  readonly stress: number;      // 0..1
  readonly fulfillment: number; // 0..1
  readonly regret: number;      // 0..1
}

/** 家庭状态 */
export interface FamilyState {
  readonly spouseSecurity: number;  // 0..1
  readonly childCost: number;       // 绝对值（年支出）
  readonly familyPressure: number;  // 0..1
}

/** 财务状态 */
export interface FinanceState {
  readonly income: number;
  readonly savings: number;
  readonly wealth: number;
}

/** 年度状态快照 */
export interface YearState {
  readonly year: number;
  readonly wealth: number;
  readonly emotionalState: EmotionalState;
  readonly familyState: FamilyState;
  readonly healthIndex: number;
  readonly overallScore: number;
  readonly valueWeights: Record<string, number>;
}

/** 路径内分支定义 */
export interface LifePathBranch {
  readonly label: string;
  readonly probability: number;    // 0..1
  readonly conditions: Record<string, unknown>;
}

/** 路径定义 */
export interface LifePath {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly initialConditions: Record<string, unknown>;
  readonly branches: readonly LifePathBranch[];
}

/** 压力测试配置 */
export interface StressTestConfig {
  readonly enabled: boolean;
  readonly incomeFreezeYears: number;
  readonly marketDownturnFactor: number;
  readonly healthShock: number;
}

/** 模拟配置 */
export interface LifeSimulationConfig {
  readonly horizonYears: number;
  readonly paths: readonly LifePath[];
  readonly stressTestConfig?: StressTestConfig;
  readonly age?: number;
}

/** 分支结果 */
export interface BranchResult {
  readonly label: string;
  readonly probability: number;
  readonly timeline: readonly YearState[];
  readonly compositeScore: number;
}

/** 回顾式评估 */
export interface RetrospectiveScore {
  readonly summary: string;
  readonly confidence: number;
  readonly regretByPath: Record<string, number>;
}

/** 路径结果 */
export interface LifePathResult {
  readonly pathId: string;
  readonly label: string;
  readonly timeline: readonly YearState[];
  readonly branches: readonly BranchResult[];
  readonly compositeScore: number;
  readonly regretProbability: number;
}

/** 模拟结果 */
export interface LifeSimulationResult {
  readonly simulationId: string;
  readonly paths: readonly LifePathResult[];
  readonly retrospective: RetrospectiveScore;
  readonly recommendedPathId: string;
  readonly completedAt: number;
}

/** 模拟进度 */
export interface SimulationProgress {
  readonly simulationId: string;
  readonly pathId: string;
  readonly year: number;
  readonly percent: number;
  readonly stage: string;
}

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
