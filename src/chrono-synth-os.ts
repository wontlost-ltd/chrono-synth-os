/**
 * ChronoSynth OS 主编排器
 * 协调三层架构（慢层/快层/元调控层）+ 恢复/演化机制
 */

import { AcceleratedLayer } from './accelerated/accelerated-layer.js';
import { CoreRhythmLayer } from './core/core-rhythm-layer.js';
import { EventBus } from './events/event-bus.js';
import { MetaRegulationLayer } from './meta/meta-regulation-layer.js';
import type { IntegrationConfig } from './meta/integration-engine.js';
import { EvolutionMerger } from './recovery/evolution-merger.js';
import { SnapshotStore } from './recovery/snapshot-store.js';
import { type IDatabase, createMemoryDatabase, runMigrations } from './storage/index.js';
import type { SystemSnapshot } from './types/snapshot.js';
import type { SimulationScenario } from './types/persona-version.js';
import type { AllocationStrategy } from './types/meta-regulation.js';
import { type Clock, realClock } from './utils/clock.js';
import { ConsoleLogger, type Logger } from './utils/logger.js';
import { generatePrefixedId } from './utils/id-generator.js';
import type { EvaluatorFn } from './accelerated/simulation-runner.js';

export interface ChronoSynthOSConfig {
  /** 数据库实例（默认内存） */
  db?: IDatabase;
  clock?: Clock;
  logger?: Logger;
  integrationConfig?: Partial<IntegrationConfig>;
  evaluator?: EvaluatorFn;
  /** 跳过迁移（当数据库已由 createDatabase() 工厂初始化时设为 true） */
  skipMigrations?: boolean;
}

export class ChronoSynthOS {
  readonly bus: EventBus;
  readonly core: CoreRhythmLayer;
  readonly accelerated: AcceleratedLayer;
  readonly meta: MetaRegulationLayer;
  readonly snapshots: SnapshotStore;
  readonly evolution: EvolutionMerger;

  private readonly db: IDatabase;
  private readonly clock: Clock;
  private readonly logger: Logger;
  private stopped = false;
  private closed = false;

  constructor(config: ChronoSynthOSConfig = {}) {
    this.db = config.db ?? createMemoryDatabase();
    this.clock = config.clock ?? realClock;
    this.logger = config.logger ?? new ConsoleLogger('info');

    /* 初始化数据库表（createDatabase 工厂已处理迁移时跳过） */
    if (!config.skipMigrations) {
      runMigrations(this.db);
    }

    /* 创建事件总线 */
    this.bus = new EventBus();

    /* 初始化三层 */
    this.core = new CoreRhythmLayer(this.db, this.bus, this.clock, this.logger);
    this.accelerated = new AcceleratedLayer(this.db, this.bus, this.clock, this.logger, config.evaluator);
    this.meta = new MetaRegulationLayer(this.db, this.bus, this.clock, this.logger, config.integrationConfig);

    /* 恢复与演化 */
    this.snapshots = new SnapshotStore(this.db);
    this.evolution = new EvolutionMerger(this.db, this.clock, this.logger);
  }

  /** 启动系统 */
  start(): void {
    this.bus.emit('system:started', { timestamp: this.clock.now() });
    this.logger.info('System', 'ChronoSynth OS 已启动');
  }

  /** 创建系统快照（事务读取确保一致性） */
  createSnapshot(reason: SystemSnapshot['reason'] = 'manual'): SystemSnapshot {
    const snapshot = this.db.transaction(() => {
      const snap: SystemSnapshot = {
        id: generatePrefixedId('snap'),
        coreSelf: this.core.getState(),
        personas: this.accelerated.getAllPersonas(),
        activeConflicts: this.meta.conflicts.getUnresolved(),
        allocations: this.lastAllocations,
        createdAt: this.clock.now(),
        reason,
      };
      this.snapshots.save(snap);
      return snap;
    });
    this.bus.emit('system:snapshot-created', { snapshot });
    this.logger.info('System', `快照已创建: ${snapshot.id} (原因=${reason})`);
    return snapshot;
  }

  /** 最近一次资源分配结果 */
  private lastAllocations: readonly import('./types/meta-regulation.js').ResourceAllocation[] = [];

  /** 从快照恢复系统状态（完整恢复，事务保护） */
  restoreFromSnapshot(snapshotId: string): boolean {
    let snapshot: SystemSnapshot | undefined;
    try {
      snapshot = this.snapshots.load(snapshotId);
    } catch (err) {
      this.logger.error('System', `快照加载失败: ${snapshotId}`, err);
      return false;
    }
    if (!snapshot) {
      this.logger.error('System', `快照不存在: ${snapshotId}`);
      return false;
    }

    try {
      this.db.transaction(() => {
        /* 清空并恢复核心价值 */
        this.core.restoreValues(snapshot.coreSelf.values);

        /* 恢复记忆和边 */
        this.core.restoreMemories(snapshot.coreSelf.memories, snapshot.coreSelf.edges);

        /* 恢复叙事（直接写入，不触发事件） */
        this.core.narrative.set(snapshot.coreSelf.narrative);

        /* 恢复人格版本 */
        this.accelerated.restorePersonas(snapshot.personas);

        /* 恢复冲突 */
        this.meta.conflicts.restoreConflicts(snapshot.activeConflicts);
      });
    } catch (err) {
      this.logger.error('System', `快照恢复失败: ${snapshotId}`, err);
      return false;
    }

    /* 恢复资源分配状态（内存，无需事务） */
    this.lastAllocations = snapshot.allocations;

    this.bus.emit('system:snapshot-restored', { snapshotId });
    this.logger.info('System', `系统已从快照恢复: ${snapshotId}`);
    return true;
  }

  /** 运行演化周期：快照 → 合并最佳实验 → 快照 */
  runEvolutionCycle(): { mergedCount: number; beforeSnapshotId: string; afterSnapshotId: string } {
    const beforeSnapshot = this.createSnapshot('pre_evolution');

    const completed = this.accelerated.getAllPersonas().filter(p => p.status === 'completed');
    const { mergedVersionIds, valueDelta } = this.evolution.merge(completed, this.core, this.meta);

    const afterSnapshot = this.createSnapshot('manual');

    if (mergedVersionIds.length > 0) {
      this.evolution.persistRecord(beforeSnapshot.id, afterSnapshot.id, mergedVersionIds, valueDelta);
      this.bus.emit('system:evolution-completed', { mergedVersionIds });
      this.logger.info('System', `演化完成: 合并了 ${mergedVersionIds.length} 个人格版本`);
    }

    return {
      mergedCount: mergedVersionIds.length,
      beforeSnapshotId: beforeSnapshot.id,
      afterSnapshotId: afterSnapshot.id,
    };
  }

  /** 运行完整调控周期：冲突检测 → 资源分配 → 应用配额 */
  runRegulationCycle(allocationStrategy?: AllocationStrategy): void {
    const personas = this.accelerated.getAllPersonas();
    this.meta.detectConflicts(personas);
    const allocations = this.meta.allocateResources(personas, allocationStrategy);
    this.lastAllocations = allocations;

    /* 将分配结果写回人格配额 */
    for (const alloc of allocations) {
      this.accelerated.personas.setQuota(alloc.versionId, alloc.quota);
    }
  }

  /** 便捷方法：创建人格并运行模拟 */
  forkAndSimulate(
    label: string,
    scenario: SimulationScenario,
    resourceQuota = 0.2,
  ): { personaId: string; fitnessScore: number } {
    const coreValues = new Map<string, number>();
    for (const [id, v] of this.core.values.getAll()) {
      coreValues.set(id, v.weight);
    }

    const persona = this.accelerated.forkPersona(label, coreValues, resourceQuota);
    const result = this.accelerated.runSimulation(persona.id, scenario);

    return { personaId: persona.id, fitnessScore: result.fitnessScore };
  }

  /** 停止系统（幂等） */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    try {
      this.bus.emit('system:stopping', { timestamp: this.clock.now() });
      this.createSnapshot('shutdown');
    } finally {
      this.bus.removeAllListeners();
      this.logger.info('System', 'ChronoSynth OS 已停止');
    }
  }

  /** 关闭数据库连接（幂等） */
  close(): void {
    if (this.closed) return;
    this.stop();
    this.db.close();
    this.closed = true;
  }
}
