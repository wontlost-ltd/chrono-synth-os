/**
 * 模拟运行器 — 纯领域逻辑
 * 在人格版本上执行模拟场景，生成适应度评分和价值调整建议
 * 零 node:* 依赖
 */

import type {
  PersonaVersion,
  SimulationScenario,
  SimulationResult,
} from './persona-version-types.js';

/** 模拟评估函数签名 */
export type EvaluatorFn = (
  persona: PersonaVersion,
  scenario: SimulationScenario,
) => { fitnessScore: number; valueAdjustments: Map<string, number>; insights: string[] };

/** 评估器原始输出 */
interface RawEvaluatorOutput {
  readonly fitnessScore: number;
  readonly valueAdjustments: Map<string, number>;
  readonly insights: string[];
}

/** 默认评估器：基于价值权重与场景参数的匹配度计算适应度 */
export function defaultEvaluator(
  persona: PersonaVersion,
  scenario: SimulationScenario,
): { fitnessScore: number; valueAdjustments: Map<string, number>; insights: string[] } {
  let totalWeight = 0;
  let matchScore = 0;

  for (const [key, weight] of persona.values) {
    totalWeight += weight;
    if (scenario.params.has(key)) {
      matchScore += weight;
    }
  }

  const fitnessScore = totalWeight > 0 ? matchScore / totalWeight : 0;
  const adjustments = new Map<string, number>();
  const insights: string[] = [];

  /* 适应度高的场景对涉及的价值维度给予微调提升 */
  if (fitnessScore > 0.5) {
    for (const [key] of scenario.params) {
      const current = persona.values.get(key);
      if (current !== undefined) {
        adjustments.set(key, Math.min(1, current + 0.05));
      }
    }
    insights.push(`场景 ${scenario.id} 与人格 ${persona.label} 高度匹配`);
  }

  return { fitnessScore, valueAdjustments: adjustments, insights };
}

/** 校验评估器输出结构 */
export function validateEvaluatorOutput(raw: unknown): asserts raw is RawEvaluatorOutput {
  const r = raw as Record<string, unknown>;
  if (typeof r.fitnessScore !== 'number') {
    throw new TypeError('评估器必须返回数字类型的 fitnessScore');
  }
  if (!(r.valueAdjustments instanceof Map)) {
    throw new TypeError('评估器必须返回 Map 类型的 valueAdjustments');
  }
  if (!Array.isArray(r.insights)) {
    throw new TypeError('评估器必须返回数组类型的 insights');
  }
}

/** 限幅并清理评估器输出（纯函数） */
export function clampEvaluatorOutput(raw: RawEvaluatorOutput): {
  fitnessScore: number;
  valueAdjustments: ReadonlyMap<string, number>;
  insights: readonly string[];
} {
  const fitnessScore = Number.isFinite(raw.fitnessScore)
    ? Math.max(0, Math.min(1, raw.fitnessScore))
    : 0;
  const valueAdjustments = new Map<string, number>();
  for (const [key, val] of raw.valueAdjustments) {
    valueAdjustments.set(key, Number.isFinite(val) ? Math.max(0, Math.min(1, val)) : 0);
  }
  return { fitnessScore, valueAdjustments, insights: raw.insights };
}

/** 运行单个模拟场景（纯函数，now 由外部注入） */
export function runSimulationScenario(
  persona: PersonaVersion,
  scenario: SimulationScenario,
  evaluator: EvaluatorFn,
  now: number,
): SimulationResult {
  if (persona.status !== 'active') {
    throw new Error(`人格 ${persona.id} 状态为 ${persona.status}，无法运行模拟`);
  }

  const raw = evaluator(persona, scenario);
  validateEvaluatorOutput(raw);
  const clamped = clampEvaluatorOutput(raw);

  return {
    scenarioId: scenario.id,
    personaVersionId: persona.id,
    fitnessScore: clamped.fitnessScore,
    valueAdjustments: clamped.valueAdjustments,
    insights: clamped.insights,
    completedAt: now,
  };
}

/** 批量运行多个场景（纯函数） */
export function runSimulationBatch(
  persona: PersonaVersion,
  scenarios: readonly SimulationScenario[],
  evaluator: EvaluatorFn,
  now: number,
): SimulationResult[] {
  return scenarios.map(s => runSimulationScenario(persona, s, evaluator, now));
}
