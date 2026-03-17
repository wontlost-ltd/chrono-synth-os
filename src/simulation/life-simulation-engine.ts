/**
 * 人生模拟核心引擎 — 薄适配器，委托 kernel 纯函数
 */

import type { PersonaOSState } from '../types/personality-os.js';
import type {
  LifeSimulationConfig,
  LifeSimulationResult,
  SimulationProgress,
} from '../types/life-simulation.js';
import {
  runSimulation,
  DEFAULT_ENGINE_CONFIG,
  type LifeSimEngineConfig,
  type SimulationPersonaState,
} from '@chrono/kernel';
import { generatePrefixedId } from '../utils/id-generator.js';

export type { LifeSimEngineConfig };
export { DEFAULT_ENGINE_CONFIG };

interface SimulateOptions {
  readonly simulationId?: string;
  readonly onProgress?: (p: SimulationProgress) => void;
}

/** PersonaOSState → SimulationPersonaState（剥离 L4） */
function toSimPersona(state: PersonaOSState): SimulationPersonaState {
  return { L0: state.L0, L1: state.L1, L2: state.L2, L3: state.L3 };
}

export class LifeSimulationEngine {
  private readonly config: LifeSimEngineConfig;

  constructor(config?: Partial<LifeSimEngineConfig>) {
    this.config = {
      family: config?.family ?? DEFAULT_ENGINE_CONFIG.family,
      health: config?.health ?? DEFAULT_ENGINE_CONFIG.health,
      finance: config?.finance ?? DEFAULT_ENGINE_CONFIG.finance,
      emotional: config?.emotional ?? DEFAULT_ENGINE_CONFIG.emotional,
    };
  }

  /** 运行完整模拟 */
  simulate(
    simConfig: LifeSimulationConfig,
    coreState: PersonaOSState,
    options?: SimulateOptions,
  ): LifeSimulationResult {
    const simulationId = options?.simulationId ?? generatePrefixedId('sim');
    const result = runSimulation(
      simConfig,
      toSimPersona(coreState),
      this.config,
      simulationId,
      0,
      options?.onProgress,
    );
    return { ...result, completedAt: Date.now() };
  }
}
