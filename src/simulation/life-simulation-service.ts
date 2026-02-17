/**
 * 人生模拟服务层
 * 桥接 API ↔ TaskQueue ↔ LifeSimulationEngine ↔ LifeSimulationStore
 */

import type { EventBus } from '../events/event-bus.js';
import type { TaskQueue } from '../queue/task-queue.js';
import type { LifeSimulationStore } from '../storage/life-simulation-store.js';
import type { LifeSimulationEngine } from './life-simulation-engine.js';
import type { LifeSimulationConfig, LifeSimulationRecord, LifeSimulationPathRecord } from '../types/life-simulation.js';
import type { PersonaOSState } from '../types/personality-os.js';
import { generatePrefixedId } from '../utils/id-generator.js';

export class LifeSimulationService {
  constructor(
    private readonly store: LifeSimulationStore,
    private readonly queue: TaskQueue,
    private readonly engine: LifeSimulationEngine,
    private readonly bus: EventBus,
    private readonly getState: () => PersonaOSState,
  ) {}

  /** 入队模拟任务 */
  enqueue(config: LifeSimulationConfig, tenantId: string, baseSimulationId?: string): { simulationId: string; taskId: string } {
    const simulationId = generatePrefixedId('lsim');
    const taskId = this.queue.enqueue(tenantId, 'life_simulation', { simulationId }, 1);
    this.store.create(simulationId, tenantId, taskId, config, baseSimulationId);
    return { simulationId, taskId };
  }

  /** 执行模拟任务（由 TaskWorker 或内联调用） */
  executeTask(simulationId: string): void {
    const record = this.store.getById(simulationId);
    if (!record || record.status === 'running' || record.status === 'completed' || record.status === 'cancelled') {
      return;
    }

    this.store.setStatus(simulationId, 'running');

    try {
      const config: LifeSimulationConfig = JSON.parse(record.configJson);
      const coreState = this.getState();

      const result = this.engine.simulate(config, coreState, {
        simulationId,
        onProgress: (p) => {
          this.store.updateProgress(simulationId, p);
          this.bus.emit('life:simulation-progress', p);
        },
      });

      /* 逐路径保存 */
      for (const pathResult of result.paths) {
        this.store.savePathResult(simulationId, pathResult);
        this.bus.emit('life:path-completed', { simulationId, pathId: pathResult.pathId });
      }

      this.store.saveResult(simulationId, result);
      this.store.setStatus(simulationId, 'completed');
      this.bus.emit('life:simulation-completed', { simulationId });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.store.setStatus(simulationId, 'failed', error);
      this.bus.emit('life:simulation-failed', { simulationId, error });
    }
  }

  /** 查询模拟状态（租户隔离） */
  getStatus(simulationId: string, tenantId?: string): LifeSimulationRecord | undefined {
    return this.store.getById(simulationId, tenantId);
  }

  /** 查询路径详情（租户隔离） */
  getPathDetail(simulationId: string, pathId: string, tenantId?: string): LifeSimulationPathRecord | undefined {
    return this.store.getPathDetail(simulationId, pathId, tenantId);
  }

  /** 查询基于某模拟的压力测试变体 */
  getVariants(baseSimulationId: string, tenantId?: string): LifeSimulationRecord[] {
    return this.store.getVariants(baseSimulationId, tenantId);
  }

  /** 查询模拟的所有路径 */
  getPathsBySimulation(simulationId: string): LifeSimulationPathRecord[] {
    return this.store.getPathsBySimulation(simulationId);
  }

  /** 查询租户的所有模拟 */
  getByTenant(tenantId: string, limit?: number): LifeSimulationRecord[] {
    return this.store.getByTenant(tenantId, limit);
  }
}
