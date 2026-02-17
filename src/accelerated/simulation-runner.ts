/**
 * 模拟运行器：在人格版本上执行模拟场景
 * 生成适应度评分和价值调整建议
 */

import type { PersonaVersion, SimulationScenario, SimulationResult } from '../types/persona-version.js';
import type { Clock } from '../utils/clock.js';
import { generatePrefixedId } from '../utils/id-generator.js';

/** 模拟评估函数签名 */
export type EvaluatorFn = (
  persona: PersonaVersion,
  scenario: SimulationScenario,
) => { fitnessScore: number; valueAdjustments: Map<string, number>; insights: string[] };

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

export class SimulationRunner {
  private readonly evaluator: EvaluatorFn;

  constructor(
    private readonly clock: Clock,
    evaluator?: EvaluatorFn,
  ) {
    this.evaluator = evaluator ?? defaultEvaluator;
  }

  /** 在指定人格版本上运行模拟场景 */
  run(persona: PersonaVersion, scenario: SimulationScenario): SimulationResult {
    if (persona.status !== 'active') {
      throw new Error(`人格 ${persona.id} 状态为 ${persona.status}，无法运行模拟`);
    }

    const raw = this.evaluator(persona, scenario);

    /* 校验评估器输出结构 */
    if (typeof raw.fitnessScore !== 'number') {
      throw new TypeError('评估器必须返回数字类型的 fitnessScore');
    }
    if (!(raw.valueAdjustments instanceof Map)) {
      throw new TypeError('评估器必须返回 Map 类型的 valueAdjustments');
    }
    if (!Array.isArray(raw.insights)) {
      throw new TypeError('评估器必须返回数组类型的 insights');
    }

    /* 边界校验：限制评估器输出在合法范围内，非有限数值归零 */
    const fitnessScore = Number.isFinite(raw.fitnessScore)
      ? Math.max(0, Math.min(1, raw.fitnessScore))
      : 0;
    const valueAdjustments = new Map<string, number>();
    for (const [key, val] of raw.valueAdjustments) {
      valueAdjustments.set(key, Number.isFinite(val) ? Math.max(0, Math.min(1, val)) : 0);
    }

    return {
      scenarioId: scenario.id,
      personaVersionId: persona.id,
      fitnessScore,
      valueAdjustments,
      insights: raw.insights,
      completedAt: this.clock.now(),
    };
  }

  /** 批量运行多个场景 */
  runBatch(persona: PersonaVersion, scenarios: readonly SimulationScenario[]): SimulationResult[] {
    return scenarios.map(s => this.run(persona, s));
  }

  /** 创建场景辅助方法 */
  static createScenario(description: string, params: Map<string, unknown>): SimulationScenario {
    return {
      id: generatePrefixedId('sim'),
      description,
      params,
    };
  }
}
