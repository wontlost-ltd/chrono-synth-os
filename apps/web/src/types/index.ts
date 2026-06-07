/** 可视化指标键 */
export type MetricKey =
  | 'wealth' | 'healthIndex' | 'overallScore'
  | 'emotionalState.valence' | 'emotionalState.stress'
  | 'emotionalState.fulfillment' | 'emotionalState.regret'
  | 'familyState.spouseSecurity' | 'familyState.childCost'
  | 'familyState.familyPressure';

export type Resolution = 'year' | '2y' | '5y';

export interface MetricMeta {
  readonly key: MetricKey;
  readonly label: string;
  readonly unit: string;
  readonly range: readonly [number, number];
}

export interface MetricPoint {
  readonly year: number;
  readonly values: Partial<Record<MetricKey, number>>;
}

export interface SeriesStats {
  readonly min: Partial<Record<MetricKey, number>>;
  readonly max: Partial<Record<MetricKey, number>>;
  readonly avg: Partial<Record<MetricKey, number>>;
  readonly last: Partial<Record<MetricKey, number>>;
}

export interface PathSeries {
  readonly pathId: string;
  readonly label: string;
  readonly points: MetricPoint[];
  readonly stats: SeriesStats;
}

export interface MilestoneEvent {
  readonly year: number;
  readonly metric: MetricKey;
  readonly kind: 'peak' | 'trough' | 'cross_up' | 'cross_down';
  readonly value: number;
  readonly threshold?: number;
}

export interface PathMilestones {
  readonly pathId: string;
  readonly label: string;
  readonly events: MilestoneEvent[];
  readonly summary: {
    readonly startSnapshot: Partial<Record<MetricKey, number>>;
    readonly endSnapshot: Partial<Record<MetricKey, number>>;
  };
}

/** overview 端点返回 */
export interface OverviewData {
  simulationId: string;
  status: 'completed';
  recommendedPathId: string;
  retrospective: string | { summary: string; confidence: number; regretByPath: Record<string, number> };
  paths: Array<{
    pathId: string;
    label: string;
    compositeScore: number;
    regretProbability: number;
  }>;
  meta: {
    horizonYears: number;
    baseSimulationId: string | null;
    completedAt: number;
  };
}

/** paths 端点返回 */
export interface PathsData {
  simulationId: string;
  metrics: MetricKey[];
  metricMeta: MetricMeta[];
  resolution: Resolution;
  series: PathSeries[];
}

/** branches 端点返回 */
export interface BranchesData {
  simulationId: string;
  pathId: string;
  label: string;
  horizonYears: number;
  pivotYear: number;
  baseTimeline: MetricPoint[];
  branches: Array<{
    label: string;
    probability: number;
    compositeScore: number;
    points: MetricPoint[];
  }>;
  graph: {
    nodes: Array<{ id: string; label: string; year: number; kind: string }>;
    edges: Array<{ source: string; target: string; value: number; probability?: number }>;
  };
}

/** stress-comparison 端点返回 */
export interface StressComparisonData {
  baseSimulationId: string;
  baseSummary: {
    recommendedPathId: string;
    paths: Array<{
      pathId: string;
      compositeScore: number;
      regretProbability: number;
    }>;
  };
  variants: Array<{
    simulationId: string;
    status: string;
    summary: {
      recommendedPathId: string;
      paths: Array<{ pathId: string; compositeScore: number; regretProbability: number }>;
    };
    deltas: Array<{
      pathId: string;
      compositeScoreDelta: number;
      regretProbabilityDelta: number;
    }>;
  }>;
}

/** milestones 端点返回 */
export interface MilestonesData {
  simulationId: string;
  metrics: MetricKey[];
  metricMeta: MetricMeta[];
  milestones: PathMilestones[];
}

/** 模拟创建请求 */
export interface CreateSimulationRequest {
  paths: Array<{
    id: string;
    label: string;
    description: string;
    initialConditions: Record<string, number>;
    branches: Array<{
      label: string;
      probability: number;
      conditions: Record<string, number>;
    }>;
  }>;
  horizonYears: number;
  age: number;
}

/** 模拟状态 */
export interface SimulationStatus {
  id: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  createdAt: number;
  completedAt?: number;
}

/** 价值观 */
export interface CoreValue {
  id: string;
  label: string;
  weight: number;
}

/** 压力测试创建请求 */
export interface CreateStressTestRequest {
  variantLabel: string;
  overrides: {
    incomeFreezeYears?: number;
    marketDownturnFactor?: number;
    healthShock?: number;
  };
}
