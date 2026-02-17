/**
 * 人生模拟核心引擎
 * 确定性数值核心：年度状态推演 + L0-L3 结构化评分 + 概率分支 + 回顾式评估
 */

import type { PersonaOSState } from '../types/personality-os.js';
import type {
  LifeSimulationConfig,
  LifeSimulationResult,
  LifePath,
  LifePathResult,
  LifePathBranch,
  BranchResult,
  RetrospectiveScore,
  YearState,
  EmotionalState,
  FamilyState,
  FinanceState,
  SimulationProgress,
} from '../types/life-simulation.js';
import { computeStructuralScore, type StructuralScoreInput } from '../intelligence/structural-scorer.js';
import { computeFamilyState, type FamilySystemConfig, DEFAULT_FAMILY_CONFIG } from './family-system-model.js';
import { nextHealthIndex, type HealthConfig, DEFAULT_HEALTH_CONFIG } from './health-decay-model.js';
import { nextFinanceState, type FinanceConfig, DEFAULT_FINANCE_CONFIG } from './career-finance-model.js';
import { nextEmotionalState, type EmotionalConfig, DEFAULT_EMOTIONAL_CONFIG } from './emotional-trajectory-engine.js';
import { clamp01 } from '../utils/math.js';
import { generatePrefixedId } from '../utils/id-generator.js';

export interface LifeSimEngineConfig {
  readonly family: FamilySystemConfig;
  readonly health: HealthConfig;
  readonly finance: FinanceConfig;
  readonly emotional: EmotionalConfig;
}

export const DEFAULT_ENGINE_CONFIG: LifeSimEngineConfig = {
  family: DEFAULT_FAMILY_CONFIG,
  health: DEFAULT_HEALTH_CONFIG,
  finance: DEFAULT_FINANCE_CONFIG,
  emotional: DEFAULT_EMOTIONAL_CONFIG,
};

interface SimulateOptions {
  readonly simulationId?: string;
  readonly onProgress?: (p: SimulationProgress) => void;
}

/** 从 initialConditions 提取数值，带默认值 */
function extractNumber(conditions: Record<string, unknown>, key: string, defaultValue: number): number {
  const v = conditions[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : defaultValue;
}

/** 从 L0 锚点检查违规 */
function checkL0Violations(
  finance: FinanceState,
  family: FamilyState,
  healthIndex: number,
  anchors: PersonaOSState['L0'],
): string[] {
  const violations: string[] = [];
  for (const anchor of anchors) {
    if (anchor.kind === 'threshold' && typeof anchor.value === 'number') {
      /* 收入底线 */
      if (anchor.label.includes('收入') || anchor.label.toLowerCase().includes('income')) {
        if (finance.income < anchor.value) {
          violations.push(anchor.id);
        }
      }
      /* 健康底线 */
      if (anchor.label.includes('健康') || anchor.label.toLowerCase().includes('health')) {
        if (healthIndex < anchor.value) {
          violations.push(anchor.id);
        }
      }
      /* 储蓄底线 */
      if (anchor.label.includes('储蓄') || anchor.label.toLowerCase().includes('saving')) {
        if (finance.savings < anchor.value) {
          violations.push(anchor.id);
        }
      }
    }
    if (anchor.kind === 'constraint') {
      /* 家庭压力约束 */
      if (anchor.label.includes('家庭') || anchor.label.toLowerCase().includes('family')) {
        if (family.familyPressure > 0.8) {
          violations.push(anchor.id);
        }
      }
    }
  }
  return violations;
}

/** 从当前状态推导场景相关度（用于 computeStructuralScore） */
function deriveRelevance(
  finance: FinanceState,
  family: FamilyState,
  healthIndex: number,
  values: PersonaOSState['L1'],
): Map<string, number> {
  const relevance = new Map<string, number>();
  for (const [id, value] of values) {
    const label = value.label.toLowerCase();
    let score = 0.5; // 基线
    if (label.includes('财务') || label.includes('financial') || label.includes('money')) {
      score = finance.income > 0 ? 0.8 : 0.3;
    } else if (label.includes('家庭') || label.includes('family')) {
      score = 0.3 + family.familyPressure * 0.5;
    } else if (label.includes('健康') || label.includes('health')) {
      score = 0.3 + (1 - healthIndex) * 0.5;
    } else if (label.includes('成长') || label.includes('growth') || label.includes('自由') || label.includes('freedom')) {
      score = 0.7;
    }
    relevance.set(id, clamp01(score));
  }
  return relevance;
}

/** 从财务和健康推导风险评分 */
function deriveRisk(finance: FinanceState, healthIndex: number): number {
  const financialRisk = finance.wealth <= 0 ? 0.9 : clamp01(1 - finance.wealth / Math.max(finance.income * 5, 1));
  const healthRisk = clamp01(1 - healthIndex);
  return clamp01(financialRisk * 0.6 + healthRisk * 0.4);
}

export class LifeSimulationEngine {
  private readonly config: LifeSimEngineConfig;

  constructor(config?: Partial<LifeSimEngineConfig>) {
    this.config = {
      family: config?.family ?? DEFAULT_FAMILY_CONFIG,
      health: config?.health ?? DEFAULT_HEALTH_CONFIG,
      finance: config?.finance ?? DEFAULT_FINANCE_CONFIG,
      emotional: config?.emotional ?? DEFAULT_EMOTIONAL_CONFIG,
    };
  }

  /** 运行完整模拟 */
  simulate(
    simConfig: LifeSimulationConfig,
    coreState: PersonaOSState,
    options?: SimulateOptions,
  ): LifeSimulationResult {
    const simulationId = options?.simulationId ?? generatePrefixedId('sim');
    const stressTest = simConfig.stressTestConfig?.enabled ?? false;

    const pathResults: LifePathResult[] = [];
    const totalPaths = simConfig.paths.length;

    for (let i = 0; i < totalPaths; i++) {
      const path = simConfig.paths[i];
      const pathResult = this.simulatePath(
        path, coreState, simConfig.horizonYears, stressTest,
        simConfig.stressTestConfig, simConfig.age,
        (p) => {
          options?.onProgress?.({
            ...p,
            simulationId,
            percent: ((i + p.percent / 100) / totalPaths) * 100,
          });
        },
      );
      pathResults.push(pathResult);
    }

    const retrospective = this.retrospectiveScore(pathResults, coreState);

    /* 推荐路径 = 最高 compositeScore */
    let recommendedPathId = pathResults[0]?.pathId ?? '';
    let maxScore = -Infinity;
    for (const pr of pathResults) {
      if (pr.compositeScore > maxScore) {
        maxScore = pr.compositeScore;
        recommendedPathId = pr.pathId;
      }
    }

    return {
      simulationId,
      paths: pathResults,
      retrospective,
      recommendedPathId,
      completedAt: Date.now(),
    };
  }

  /** 模拟单条路径 */
  private simulatePath(
    path: LifePath,
    coreState: PersonaOSState,
    horizonYears: number,
    stressTest: boolean,
    stressTestConfig?: LifeSimulationConfig['stressTestConfig'],
    baseAge?: number,
    onProgress?: (p: Omit<SimulationProgress, 'simulationId'>) => void,
  ): LifePathResult {
    const age = baseAge ?? extractNumber(path.initialConditions, 'age', 35);
    const initialIncome = extractNumber(path.initialConditions, 'income', 300000);
    const initialSavings = extractNumber(path.initialConditions, 'savings', 500000);

    let finance: FinanceState = {
      income: initialIncome,
      savings: initialSavings,
      wealth: initialSavings,
    };
    let family: FamilyState = {
      spouseSecurity: extractNumber(path.initialConditions, 'spouseSecurity', 0.8),
      childCost: 0,
      familyPressure: extractNumber(path.initialConditions, 'familyPressure', 0.2),
    };
    let emotional: EmotionalState = {
      valence: 0.3,
      stress: extractNumber(path.initialConditions, 'stress', 0.3),
      fulfillment: 0.5,
      regret: 0,
    };
    let healthIndex = extractNumber(path.initialConditions, 'healthIndex', 0.95);
    let lowIncomeYears = 0;
    let prevIncome = initialIncome;

    const timeline: YearState[] = [];

    /* 构建 valueWeights 快照 */
    const valueWeights = new Map<string, number>();
    for (const [id, v] of coreState.L1) {
      valueWeights.set(id, v.weight);
    }

    for (let year = 1; year <= horizonYears; year++) {
      /* 压力测试：前 N 年冻结收入增长 + 财富缩水 */
      const isStressYear = stressTest && stressTestConfig
        && year <= (stressTestConfig.incomeFreezeYears ?? 0);

      /* 健康冲击 */
      if (stressTest && stressTestConfig && year === 1 && stressTestConfig.healthShock > 0) {
        healthIndex = clamp01(healthIndex - stressTestConfig.healthShock);
      }

      /* 财务推演 */
      finance = nextFinanceState(finance, {
        branchConditions: path.initialConditions,
        stressTest: isStressYear ?? false,
        year,
        familyExpense: family.childCost,
      }, this.config.finance);

      /* 压力测试：市场下行 */
      if (stressTest && stressTestConfig && year === 1 && stressTestConfig.marketDownturnFactor < 1) {
        finance = {
          ...finance,
          wealth: finance.wealth * stressTestConfig.marketDownturnFactor,
          savings: finance.savings * stressTestConfig.marketDownturnFactor,
        };
      }

      /* 低收入年数追踪 */
      if (finance.income < prevIncome * 0.7) {
        lowIncomeYears++;
      } else {
        lowIncomeYears = 0;
      }
      prevIncome = finance.income;

      /* 家庭推演 */
      family = computeFamilyState(family, {
        year,
        wealth: finance.wealth,
        income: finance.income,
        stress: emotional.stress,
        lowIncomeYears,
      }, this.config.family);

      /* 健康推演 */
      healthIndex = nextHealthIndex(healthIndex, {
        age: age + year,
        stress: emotional.stress,
        lifestyleScore: clamp01(1 - emotional.stress * 0.5),
      }, this.config.health);

      /* L0-L3 结构化评分 */
      const violations = checkL0Violations(finance, family, healthIndex, coreState.L0);
      const scenarioRelevance = deriveRelevance(finance, family, healthIndex, coreState.L1);
      const riskScore = deriveRisk(finance, healthIndex);

      const scoreInput: StructuralScoreInput = {
        valueWeights,
        values: coreState.L1,
        scenarioRelevance,
        anchors: coreState.L0,
        violations,
        riskScore,
        decisionStyle: coreState.L2,
        cognitiveModel: coreState.L3,
        timeHorizonMonths: horizonYears * 12,
      };
      const alignment = computeStructuralScore(scoreInput);

      /* 情绪推演 */
      emotional = nextEmotionalState(emotional, {
        finance,
        family,
        healthIndex,
        year,
        valueAlignment: alignment.overallScore,
      }, this.config.emotional);

      /* 年度快照 */
      const weightSnapshot: Record<string, number> = {};
      for (const [id, w] of valueWeights) {
        weightSnapshot[id] = w;
      }

      timeline.push({
        year,
        wealth: finance.wealth,
        emotionalState: emotional,
        familyState: family,
        healthIndex,
        overallScore: alignment.overallScore,
        valueWeights: weightSnapshot,
      });

      onProgress?.({
        pathId: path.id,
        year,
        percent: (year / horizonYears) * 100,
        stage: `year_${year}`,
      });
    }

    /* 概率分支模拟 */
    const pivotYear = Math.max(1, Math.floor(horizonYears / 3));
    const branches = this.simulateBranches(
      path.branches, timeline, coreState, pivotYear, horizonYears,
      baseAge ?? age,
    );

    /* 复合评分 */
    const mainScores = timeline.map(y => y.overallScore);
    const mainAvg = mainScores.reduce((s, v) => s + v, 0) / Math.max(mainScores.length, 1);

    let branchWeightedScore = 0;
    let branchWeightTotal = 0;
    for (const b of branches) {
      branchWeightedScore += b.compositeScore * b.probability;
      branchWeightTotal += b.probability;
    }
    const branchAvg = branchWeightTotal > 0 ? branchWeightedScore / branchWeightTotal : mainAvg;

    const compositeScore = branches.length > 0
      ? mainAvg * 0.6 + branchAvg * 0.4
      : mainAvg;

    /* 后悔概率 = regretSensitivity × (1 - compositeScore) */
    const regretProbability = clamp01(
      coreState.L2.regretSensitivity * (1 - clamp01(compositeScore)),
    );

    return {
      pathId: path.id,
      label: path.label,
      timeline,
      branches,
      compositeScore,
      regretProbability,
    };
  }

  /** 模拟路径内概率分支 */
  private simulateBranches(
    branchDefs: readonly LifePathBranch[],
    baseTimeline: readonly YearState[],
    coreState: PersonaOSState,
    pivotYear: number,
    horizonYears: number,
    baseAge: number,
  ): BranchResult[] {
    if (branchDefs.length === 0) return [];

    /* 归一化分支概率，受 L2.riskAppetite 影响 */
    const riskAppetite = clamp01(coreState.L2.riskAppetite);
    const rawWeights = branchDefs.map(b => clamp01(b.probability));
    const totalWeight = rawWeights.reduce((s, w) => s + w, 0);
    const normalizedProbs = totalWeight > 0
      ? rawWeights.map(w => w / totalWeight)
      : rawWeights.map(() => 1 / branchDefs.length);

    const results: BranchResult[] = [];

    for (let i = 0; i < branchDefs.length; i++) {
      const branch = branchDefs[i];
      const probability = normalizedProbs[i];

      /* 从 pivotYear 状态开始分叉 */
      const pivotState = baseTimeline[Math.min(pivotYear - 1, baseTimeline.length - 1)];
      if (!pivotState) continue;

      let finance: FinanceState = {
        income: pivotState.wealth > 0 ? pivotState.wealth * 0.3 : 0,
        savings: pivotState.wealth,
        wealth: pivotState.wealth,
      };
      let family = pivotState.familyState;
      let emotional = pivotState.emotionalState;
      let healthIdx = pivotState.healthIndex;

      const branchTimeline: YearState[] = [];
      const valueWeights = new Map<string, number>();
      for (const [id, v] of coreState.L1) {
        valueWeights.set(id, v.weight);
      }

      for (let year = pivotYear + 1; year <= horizonYears; year++) {
        finance = nextFinanceState(finance, {
          branchConditions: branch.conditions,
          stressTest: false,
          year,
          familyExpense: family.childCost,
        }, this.config.finance);

        family = computeFamilyState(family, {
          year, wealth: finance.wealth, income: finance.income,
          stress: emotional.stress, lowIncomeYears: 0,
        }, this.config.family);

        healthIdx = nextHealthIndex(healthIdx, {
          age: baseAge + year,
          stress: emotional.stress,
          lifestyleScore: clamp01(1 - emotional.stress * 0.5),
        }, this.config.health);

        const violations = checkL0Violations(finance, family, healthIdx, coreState.L0);
        const scenarioRelevance = deriveRelevance(finance, family, healthIdx, coreState.L1);
        const riskScore = deriveRisk(finance, healthIdx);

        const alignment = computeStructuralScore({
          valueWeights, values: coreState.L1,
          scenarioRelevance, anchors: coreState.L0,
          violations, riskScore,
          decisionStyle: coreState.L2,
          cognitiveModel: coreState.L3,
          timeHorizonMonths: horizonYears * 12,
        });

        emotional = nextEmotionalState(emotional, {
          finance, family, healthIndex: healthIdx, year,
          valueAlignment: alignment.overallScore,
        }, this.config.emotional);

        const weightSnapshot: Record<string, number> = {};
        for (const [id, w] of valueWeights) {
          weightSnapshot[id] = w;
        }

        branchTimeline.push({
          year, wealth: finance.wealth,
          emotionalState: emotional, familyState: family,
          healthIndex: healthIdx, overallScore: alignment.overallScore,
          valueWeights: weightSnapshot,
        });
      }

      const scores = branchTimeline.map(y => y.overallScore);
      const compositeScore = scores.length > 0
        ? scores.reduce((s, v) => s + v, 0) / scores.length
        : 0;

      /* riskAppetite 调整：高风险偏好者对高波动分支更宽容 */
      const adjustedScore = compositeScore * (1 + (riskAppetite - 0.5) * 0.2);

      results.push({
        label: branch.label,
        probability,
        timeline: branchTimeline,
        compositeScore: clamp01(adjustedScore),
      });
    }

    return results;
  }

  /** 回顾式评估 */
  private retrospectiveScore(
    paths: readonly LifePathResult[],
    coreState: PersonaOSState,
  ): RetrospectiveScore {
    if (paths.length === 0) {
      return { summary: '无路径可评估', confidence: 0, regretByPath: {} };
    }

    const regretByPath: Record<string, number> = {};

    /* 取最后 3 年平均后悔趋势 */
    for (const path of paths) {
      const lastYears = path.timeline.slice(-3);
      const avgRegret = lastYears.length > 0
        ? lastYears.reduce((s, y) => s + y.emotionalState.regret, 0) / lastYears.length
        : 0;
      regretByPath[path.pathId] = avgRegret;
    }

    /* 对比各路径的终值 fulfillment */
    const fulfillments = paths.map(p => {
      const last = p.timeline[p.timeline.length - 1];
      return { pathId: p.pathId, label: p.label, fulfillment: last?.emotionalState.fulfillment ?? 0 };
    });

    /* 按 fulfillment 排序 */
    fulfillments.sort((a, b) => b.fulfillment - a.fulfillment);

    /* 信心度 = 路径间 compositeScore 差异越大，信心越高 */
    const scores = paths.map(p => p.compositeScore);
    const maxScore = Math.max(...scores);
    const minScore = Math.min(...scores);
    const confidence = clamp01((maxScore - minScore) * 2);

    /* 结合 L2.regretSensitivity 计算回顾效用 */
    const regretSensitivity = coreState.L2.regretSensitivity;
    const bestPath = fulfillments[0];
    const topRegret = regretByPath[bestPath.pathId] ?? 0;

    const summaryParts = [
      `推荐路径「${bestPath.label}」终值满足感 ${bestPath.fulfillment.toFixed(2)}`,
      `后悔趋势 ${topRegret.toFixed(2)}`,
      paths.length > 1
        ? `对比 ${paths.length} 条路径，信心度 ${(confidence * 100).toFixed(0)}%`
        : '',
      regretSensitivity > 0.5
        ? `后悔敏感度较高 (${regretSensitivity.toFixed(2)})，建议关注低后悔路径`
        : '',
    ].filter(Boolean);

    return {
      summary: summaryParts.join('；'),
      confidence,
      regretByPath,
    };
  }
}
