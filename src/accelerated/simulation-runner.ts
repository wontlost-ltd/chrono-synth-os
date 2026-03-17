/**
 * 模拟运行器 — 薄适配器，委托 kernel 纯函数
 */

import type { PersonaVersion, SimulationScenario, SimulationResult } from '../types/persona-version.js';
import type { Clock } from '../utils/clock.js';
import { generatePrefixedId } from '../utils/id-generator.js';
import {
  defaultEvaluator as kernelDefaultEvaluator,
  runSimulationScenario,
  type EvaluatorFn,
} from '@chrono/kernel';

export type { EvaluatorFn };

export const defaultEvaluator = kernelDefaultEvaluator;

export class SimulationRunner {
  private readonly evaluator: EvaluatorFn;

  constructor(
    private readonly clock: Clock,
    evaluator?: EvaluatorFn,
  ) {
    this.evaluator = evaluator ?? kernelDefaultEvaluator;
  }

  /** 在指定人格版本上运行模拟场景 */
  run(persona: PersonaVersion, scenario: SimulationScenario): SimulationResult {
    return runSimulationScenario(persona, scenario, this.evaluator, this.clock.now());
  }

  /** 批量运行多个场景（每个场景独立采样时间戳，保持原语义） */
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
