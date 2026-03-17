/**
 * 人生模拟核心引擎 — 纯领域逻辑
 * 确定性数值核心：年度状态推演 + L0-L3 结构化评分 + 概率分支 + 回顾式评估
 * 零 node:* 依赖
 */

import type { CoreValue } from '../core-self/value-types.js';
import type { SurvivalAnchor } from '../core-self/anchor-types.js';
import type { FinanceState, FamilyState, EmotionalState } from './types.js';
import type {
  SimulationPersonaState,
  YearState,
  LifePath,
  LifePathBranch,
  LifePathResult,
  LifeSimulationConfig,
  LifeSimulationResult,
  BranchResult,
  RetrospectiveScore,
  SimulationProgress,
} from './life-simulation-types.js';
import type { StructuralScoreInput } from '../intelligence/structural-scorer.js';
import { computeStructuralScore } from '../intelligence/structural-scorer.js';
import { nextFinanceState, type FinanceConfig, DEFAULT_FINANCE_CONFIG } from './career-finance-model.js';
import { computeFamilyState, type FamilySystemConfig, DEFAULT_FAMILY_CONFIG } from './family-system-model.js';
import { nextHealthIndex, type HealthConfig, DEFAULT_HEALTH_CONFIG } from './health-decay-model.js';
import { nextEmotionalState, type EmotionalConfig, DEFAULT_EMOTIONAL_CONFIG } from './emotional-trajectory-engine.js';
import { clamp01 } from '../math.js';

/** 子模型配置聚合 */
export interface LifeSimEngineConfig {
  readonly family: FamilySystemConfig;
  readonly health: HealthConfig;
  readonly finance: FinanceConfig;
  readonly emotional: EmotionalConfig;
}

export const DEFAULT_ENGINE_CONFIG: LifeSimEngineConfig = Object.freeze({
  family: DEFAULT_FAMILY_CONFIG,
  health: DEFAULT_HEALTH_CONFIG,
  finance: DEFAULT_FINANCE_CONFIG,
  emotional: DEFAULT_EMOTIONAL_CONFIG,
});

/* ───────── 纯辅助函数 ───────── */

/** 从 initialConditions 提取数值，带默认值 */
export function extractNumber(conditions: Record<string, unknown>, key: string, defaultValue: number): number {
  const v = conditions[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : defaultValue;
}

/** 从 L0 锚点检查违规 */
export function checkL0Violations(
  finance: FinanceState,
  family: FamilyState,
  healthIndex: number,
  anchors: readonly SurvivalAnchor[],
): string[] {
  const violations: string[] = [];
  for (const anchor of anchors) {
    if (anchor.kind === 'threshold' && typeof anchor.value === 'number') {
      if (anchor.label.includes('收入') || anchor.label.toLowerCase().includes('income')) {
        if (finance.income < anchor.value) violations.push(anchor.id);
      }
      if (anchor.label.includes('健康') || anchor.label.toLowerCase().includes('health')) {
        if (healthIndex < anchor.value) violations.push(anchor.id);
      }
      if (anchor.label.includes('储蓄') || anchor.label.toLowerCase().includes('saving')) {
        if (finance.savings < anchor.value) violations.push(anchor.id);
      }
    }
    if (anchor.kind === 'constraint') {
      if (anchor.label.includes('家庭') || anchor.label.toLowerCase().includes('family')) {
        if (family.familyPressure > 0.8) violations.push(anchor.id);
      }
    }
  }
  return violations;
}

/** 从当前状态推导场景相关度（用于 computeStructuralScore） */
export function deriveRelevance(
  finance: FinanceState,
  family: FamilyState,
  healthIndex: number,
  values: ReadonlyMap<string, CoreValue>,
): Map<string, number> {
  const relevance = new Map<string, number>();
  for (const [id, value] of values) {
    const label = value.label.toLowerCase();
    let score = 0.5;
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
export function deriveRisk(finance: FinanceState, healthIndex: number): number {
  const financialRisk = finance.wealth <= 0 ? 0.9 : clamp01(1 - finance.wealth / Math.max(finance.income * 5, 1));
  const healthRisk = clamp01(1 - healthIndex);
  return clamp01(financialRisk * 0.6 + healthRisk * 0.4);
}

function buildValueWeights(values: ReadonlyMap<string, CoreValue>): Map<string, number> {
  const m = new Map<string, number>();
  for (const [id, v] of values) m.set(id, v.weight);
  return m;
}

/* ───────── 年度推演核心循环 ───────── */

/** 年度推演参数 */
interface YearSimContext {
  readonly config: LifeSimEngineConfig;
  readonly persona: SimulationPersonaState;
  readonly horizonYears: number;
  readonly valueWeights: ReadonlyMap<string, number>;
}

/** 年度推演可变状态 */
interface YearSimState {
  finance: FinanceState;
  family: FamilyState;
  emotional: EmotionalState;
  healthIndex: number;
  lowIncomeYears: number;
  prevIncome: number;
}

/** 推演单个年度，返回新状态和年度快照 */
function simulateYear(
  state: YearSimState,
  year: number,
  baseAge: number,
  conditions: Record<string, unknown>,
  stressTest: boolean,
  stressTestConfig: LifeSimulationConfig['stressTestConfig'],
  ctx: YearSimContext,
  trackLowIncomeYears = true,
): { nextState: YearSimState; snapshot: YearState } {
  let { finance, family, emotional, healthIndex, lowIncomeYears, prevIncome } = state;

  const isStressYear = stressTest && stressTestConfig
    && year <= (stressTestConfig.incomeFreezeYears ?? 0);

  /* 健康冲击（仅首年） */
  if (stressTest && stressTestConfig && year === 1 && stressTestConfig.healthShock > 0) {
    healthIndex = clamp01(healthIndex - stressTestConfig.healthShock);
  }

  /* 财务推演 */
  finance = nextFinanceState(finance, {
    branchConditions: conditions,
    stressTest: isStressYear ?? false,
    year,
    familyExpense: family.childCost,
  }, ctx.config.finance);

  /* 市场下行冲击（仅首年） */
  if (stressTest && stressTestConfig && year === 1 && stressTestConfig.marketDownturnFactor < 1) {
    finance = {
      ...finance,
      wealth: finance.wealth * stressTestConfig.marketDownturnFactor,
      savings: finance.savings * stressTestConfig.marketDownturnFactor,
    };
  }

  /* 低收入年数追踪 */
  if (trackLowIncomeYears) {
    if (finance.income < prevIncome * 0.7) {
      lowIncomeYears++;
    } else {
      lowIncomeYears = 0;
    }
  } else {
    lowIncomeYears = 0;
  }
  prevIncome = finance.income;

  /* 家庭推演 */
  family = computeFamilyState(family, {
    year, wealth: finance.wealth, income: finance.income,
    stress: emotional.stress, lowIncomeYears,
  }, ctx.config.family);

  /* 健康推演 */
  healthIndex = nextHealthIndex(healthIndex, {
    age: baseAge + year,
    stress: emotional.stress,
    lifestyleScore: clamp01(1 - emotional.stress * 0.5),
  }, ctx.config.health);

  /* L0-L3 结构化评分 */
  const violations = checkL0Violations(finance, family, healthIndex, ctx.persona.L0);
  const scenarioRelevance = deriveRelevance(finance, family, healthIndex, ctx.persona.L1);
  const riskScore = deriveRisk(finance, healthIndex);

  const scoreInput: StructuralScoreInput = {
    valueWeights: ctx.valueWeights,
    values: ctx.persona.L1,
    scenarioRelevance,
    anchors: ctx.persona.L0,
    violations,
    riskScore,
    decisionStyle: ctx.persona.L2,
    cognitiveModel: ctx.persona.L3,
    timeHorizonMonths: ctx.horizonYears * 12,
  };
  const alignment = computeStructuralScore(scoreInput);

  /* 情绪推演 */
  emotional = nextEmotionalState(emotional, {
    finance, family, healthIndex, year,
    valueAlignment: alignment.overallScore,
  }, ctx.config.emotional);

  /* 年度快照 */
  const weightSnapshot: Record<string, number> = {};
  for (const [id, w] of ctx.valueWeights) {
    weightSnapshot[id] = w;
  }

  const snapshot: YearState = {
    year,
    wealth: finance.wealth,
    emotionalState: emotional,
    familyState: family,
    healthIndex,
    overallScore: alignment.overallScore,
    valueWeights: weightSnapshot,
  };

  return {
    nextState: { finance, family, emotional, healthIndex, lowIncomeYears, prevIncome },
    snapshot,
  };
}

/* ───────── 路径模拟 ───────── */

/** 模拟单条路径（纯函数） */
export function simulatePath(
  path: LifePath,
  persona: SimulationPersonaState,
  horizonYears: number,
  stressTest: boolean,
  stressTestConfig: LifeSimulationConfig['stressTestConfig'],
  baseAge: number | undefined,
  engineConfig: LifeSimEngineConfig,
  onProgress?: (p: Omit<SimulationProgress, 'simulationId'>) => void,
): LifePathResult {
  const age = baseAge ?? extractNumber(path.initialConditions, 'age', 35);
  const initialIncome = extractNumber(path.initialConditions, 'income', 300000);
  const initialSavings = extractNumber(path.initialConditions, 'savings', 500000);

  const ctx: YearSimContext = {
    config: engineConfig, persona, horizonYears,
    valueWeights: buildValueWeights(persona.L1),
  };

  let state: YearSimState = {
    finance: { income: initialIncome, savings: initialSavings, wealth: initialSavings },
    family: {
      spouseSecurity: extractNumber(path.initialConditions, 'spouseSecurity', 0.8),
      childCost: 0,
      familyPressure: extractNumber(path.initialConditions, 'familyPressure', 0.2),
    },
    emotional: {
      valence: 0.3,
      stress: extractNumber(path.initialConditions, 'stress', 0.3),
      fulfillment: 0.5,
      regret: 0,
    },
    healthIndex: extractNumber(path.initialConditions, 'healthIndex', 0.95),
    lowIncomeYears: 0,
    prevIncome: initialIncome,
  };

  const timeline: YearState[] = [];

  for (let year = 1; year <= horizonYears; year++) {
    const result = simulateYear(state, year, age, path.initialConditions, stressTest, stressTestConfig, ctx);
    state = result.nextState;
    timeline.push(result.snapshot);

    onProgress?.({
      pathId: path.id,
      year,
      percent: (year / horizonYears) * 100,
      stage: `year_${year}`,
    });
  }

  /* 概率分支模拟 */
  const pivotYear = Math.max(1, Math.floor(horizonYears / 3));
  const branches = simulateBranches(
    path.branches, timeline, persona, pivotYear, horizonYears, baseAge ?? age, engineConfig,
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

  const regretProbability = clamp01(
    persona.L2.regretSensitivity * (1 - clamp01(compositeScore)),
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

/* ───────── 分支模拟 ───────── */

/** 模拟路径内概率分支（纯函数） */
export function simulateBranches(
  branchDefs: readonly LifePathBranch[],
  baseTimeline: readonly YearState[],
  persona: SimulationPersonaState,
  pivotYear: number,
  horizonYears: number,
  baseAge: number,
  engineConfig: LifeSimEngineConfig,
): BranchResult[] {
  if (branchDefs.length === 0) return [];

  const riskAppetite = clamp01(persona.L2.riskAppetite);
  const rawWeights = branchDefs.map(b => clamp01(b.probability));
  const totalWeight = rawWeights.reduce((s, w) => s + w, 0);
  const normalizedProbs = totalWeight > 0
    ? rawWeights.map(w => w / totalWeight)
    : rawWeights.map(() => 1 / branchDefs.length);

  const ctx: YearSimContext = {
    config: engineConfig, persona, horizonYears,
    valueWeights: buildValueWeights(persona.L1),
  };
  const results: BranchResult[] = [];

  for (let i = 0; i < branchDefs.length; i++) {
    const branch = branchDefs[i];
    const probability = normalizedProbs[i];

    const pivotState = baseTimeline[Math.min(pivotYear - 1, baseTimeline.length - 1)];
    if (!pivotState) continue;

    let state: YearSimState = {
      finance: {
        income: pivotState.wealth > 0 ? pivotState.wealth * 0.3 : 0,
        savings: pivotState.wealth,
        wealth: pivotState.wealth,
      },
      family: pivotState.familyState,
      emotional: pivotState.emotionalState,
      healthIndex: pivotState.healthIndex,
      lowIncomeYears: 0,
      prevIncome: pivotState.wealth > 0 ? pivotState.wealth * 0.3 : 0,
    };

    const branchTimeline: YearState[] = [];

    for (let year = pivotYear + 1; year <= horizonYears; year++) {
      const result = simulateYear(state, year, baseAge, branch.conditions, false, undefined, ctx, false);
      state = result.nextState;
      branchTimeline.push(result.snapshot);
    }

    const scores = branchTimeline.map(y => y.overallScore);
    const compositeScore = scores.length > 0
      ? scores.reduce((s, v) => s + v, 0) / scores.length
      : pivotState.overallScore;

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

/* ───────── 回顾式评估 ───────── */

/** 回顾式评估（纯函数） */
export function retrospectiveScore(
  paths: readonly LifePathResult[],
  persona: SimulationPersonaState,
): RetrospectiveScore {
  if (paths.length === 0) {
    return { summary: '无路径可评估', confidence: 0, regretByPath: {} };
  }

  const regretByPath: Record<string, number> = {};
  for (const path of paths) {
    const lastYears = path.timeline.slice(-3);
    const avgRegret = lastYears.length > 0
      ? lastYears.reduce((s, y) => s + y.emotionalState.regret, 0) / lastYears.length
      : 0;
    regretByPath[path.pathId] = avgRegret;
  }

  /* 选取 compositeScore 最高的路径，与 runSimulation 的 recommendedPathId 一致 */
  let bestPath = paths[0];
  for (const p of paths) {
    if (p.compositeScore > bestPath.compositeScore) bestPath = p;
  }
  const bestFulfillment = bestPath.timeline[bestPath.timeline.length - 1]?.emotionalState.fulfillment ?? 0;

  const scores = paths.map(p => p.compositeScore);
  const maxScore = Math.max(...scores);
  const minScore = Math.min(...scores);
  const confidence = clamp01((maxScore - minScore) * 2);

  const regretSensitivity = persona.L2.regretSensitivity;
  const topRegret = regretByPath[bestPath.pathId] ?? 0;

  const summaryParts = [
    `推荐路径「${bestPath.label}」终值满足感 ${bestFulfillment.toFixed(2)}`,
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

/* ───────── 完整模拟编排 ───────── */

/** 运行完整模拟（纯函数，IO 通过参数注入） */
export function runSimulation(
  simConfig: LifeSimulationConfig,
  persona: SimulationPersonaState,
  engineConfig: LifeSimEngineConfig,
  simulationId: string,
  completedAt: number,
  onProgress?: (p: SimulationProgress) => void,
): LifeSimulationResult {
  const stressTest = simConfig.stressTestConfig?.enabled ?? false;
  const totalPaths = simConfig.paths.length;
  const pathResults: LifePathResult[] = [];

  for (let i = 0; i < totalPaths; i++) {
    const path = simConfig.paths[i];
    const pathResult = simulatePath(
      path, persona, simConfig.horizonYears, stressTest,
      simConfig.stressTestConfig, simConfig.age, engineConfig,
      (p) => {
        onProgress?.({
          ...p,
          simulationId,
          percent: ((i + p.percent / 100) / totalPaths) * 100,
        });
      },
    );
    pathResults.push(pathResult);
  }

  const retro = retrospectiveScore(pathResults, persona);

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
    retrospective: retro,
    recommendedPathId,
    completedAt,
  };
}
