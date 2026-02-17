/**
 * 加速认知层（快层）
 * 处理并行模拟、实验、自适应模型
 * 生成多个人格版本并向元调控层提供建议
 */

import type { EventBus } from '../events/event-bus.js';
import type { IDatabase } from '../storage/database.js';
import type { PersonaVersion, SimulationResult, SimulationScenario } from '../types/persona-version.js';
import type { Clock } from '../utils/clock.js';
import type { Logger } from '../utils/logger.js';
import { PersonaEngine } from './persona-engine.js';
import { SimulationRunner, type EvaluatorFn } from './simulation-runner.js';

const LAYER = 'Accelerated';

export class AcceleratedLayer {
  readonly personas: PersonaEngine;
  readonly simulator: SimulationRunner;

  constructor(
    db: IDatabase,
    private readonly bus: EventBus,
    clock: Clock,
    private readonly logger: Logger,
    evaluator?: EvaluatorFn,
  ) {
    this.personas = new PersonaEngine(db, clock);
    this.simulator = new SimulationRunner(clock, evaluator);
  }

  /** 从核心价值分叉创建新的人格版本 */
  forkPersona(label: string, coreValues: ReadonlyMap<string, number>, resourceQuota = 0.2): PersonaVersion {
    const persona = this.personas.create(label, coreValues, resourceQuota);
    this.bus.emit('persona:created', { persona });
    this.logger.info(LAYER, `人格已创建: ${label} (配额=${resourceQuota})`);
    return persona;
  }

  /** 暂停人格版本 */
  pausePersona(id: string): boolean {
    const persona = this.personas.getById(id);
    if (!persona) return false;
    const oldStatus = persona.status;
    const ok = this.personas.setStatus(id, 'paused');
    if (ok) {
      this.bus.emit('persona:status-changed', { personaId: id, oldStatus, newStatus: 'paused' });
      this.logger.info(LAYER, `人格已暂停: ${persona.label}`);
    }
    return ok;
  }

  /** 恢复人格版本 */
  resumePersona(id: string): boolean {
    const persona = this.personas.getById(id);
    if (!persona || persona.status !== 'paused') return false;
    const ok = this.personas.setStatus(id, 'active');
    if (ok) {
      this.bus.emit('persona:status-changed', { personaId: id, oldStatus: 'paused', newStatus: 'active' });
      this.logger.info(LAYER, `人格已恢复: ${persona.label}`);
    }
    return ok;
  }

  /** 在指定人格版本上运行模拟 */
  runSimulation(personaId: string, scenario: SimulationScenario): SimulationResult {
    const persona = this.personas.getById(personaId);
    if (!persona) throw new Error(`人格 ${personaId} 不存在`);

    const result = this.simulator.run(persona, scenario);
    this.personas.addResult(personaId, result);
    this.bus.emit('persona:simulation-completed', { result });
    this.logger.info(LAYER, `模拟完成: 人格=${persona.label}, 场景=${scenario.id}, 适应度=${result.fitnessScore.toFixed(3)}`);
    return result;
  }

  /** 在所有活跃人格上运行同一场景 */
  runOnAllActive(scenario: SimulationScenario): SimulationResult[] {
    const actives = this.personas.getActive();
    return actives.map(p => this.runSimulation(p.id, scenario));
  }

  /** 标记人格为完成 */
  completePersona(id: string): boolean {
    const persona = this.personas.getById(id);
    if (!persona) return false;
    const oldStatus = persona.status;
    const ok = this.personas.setStatus(id, 'completed');
    if (ok) {
      this.bus.emit('persona:status-changed', { personaId: id, oldStatus, newStatus: 'completed' });
      this.logger.info(LAYER, `人格已完成: ${persona.label}`);
    }
    return ok;
  }

  /** 获取所有活跃人格 */
  getActivePersonas(): PersonaVersion[] {
    return this.personas.getActive();
  }

  /** 获取全部人格 */
  getAllPersonas(): PersonaVersion[] {
    return this.personas.getAll();
  }

  /** 从快照恢复人格版本（清空后重建） */
  restorePersonas(personas: readonly PersonaVersion[]): void {
    this.personas.deleteAll();
    for (const p of personas) {
      this.personas.insertRaw(p);
    }
    this.logger.info(LAYER, `人格已恢复: ${personas.length} 个版本`);
  }
}
