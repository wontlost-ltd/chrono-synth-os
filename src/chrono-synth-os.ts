/**
 * ChronoSynth OS 主编排器
 * 协调三层架构（慢层/快层/元调控层）+ 恢复/演化机制
 */

import { AcceleratedLayer } from './accelerated/accelerated-layer.js';
import { CoreRhythmLayer } from './core/core-rhythm-layer.js';
import { MemoryPatternExtractor, type PatternExtractionConfig, type ValueUpdateProposal } from './core/memory-pattern-extractor.js';
import { EventBus } from './events/event-bus.js';
import { MetaRegulationLayer } from './meta/meta-regulation-layer.js';
import type { IntegrationConfig } from './meta/integration-engine.js';
import { UpdateGate, type UpdateGateConfig, type UpdateTrigger } from './meta/update-gate.js';
import { EvolutionMerger } from './recovery/evolution-merger.js';
import { SnapshotStore } from './recovery/snapshot-store.js';
import { LifeSimulationEngine, type LifeSimEngineConfig } from './simulation/life-simulation-engine.js';
import { LifeSimulationService } from './simulation/life-simulation-service.js';
import { LifeSimulationStore } from './storage/life-simulation-store.js';
import { type IDatabase, createMemoryDatabase } from './storage/index.js';
import { runDslSqliteMigrations } from './storage/dsl-migrations-runner.js';
import { registerCoreSelfExecutors } from './storage/executors/index.js';
import type { SystemSnapshot, EvolutionDiffReport } from './types/snapshot.js';
import type { SimulationScenario } from './types/persona-version.js';
import type { AllocationStrategy, ResourceAllocation } from './types/meta-regulation.js';
import type { MemoryCognitionConfig } from './types/core-self.js';
import { FieldEncryption, type EncryptionConfig } from './storage/encryption.js';
import { type Clock, realClock } from './utils/clock.js';
import { ConsoleLogger, type Logger } from './utils/logger.js';
import { generatePrefixedId } from './utils/id-generator.js';
import type { EvaluatorFn } from './accelerated/simulation-runner.js';
import { compilePersonaState } from './intelligence/persona-state.js';
import { TaskQueue } from './queue/task-queue.js';

export interface ChronoSynthOSConfig {
  /** 数据库实例（默认内存） */
  db?: IDatabase;
  clock?: Clock;
  logger?: Logger;
  integrationConfig?: Partial<IntegrationConfig>;
  evaluator?: EvaluatorFn;
  /** 认知记忆配置 */
  cognitionConfig?: Partial<MemoryCognitionConfig>;
  /** 更新闸门配置 */
  updateGateConfig?: Partial<UpdateGateConfig>;
  /** 记忆模式提取配置 */
  patternExtractionConfig?: Partial<PatternExtractionConfig>;
  /** 人生模拟引擎配置 */
  lifeSimulationConfig?: Partial<LifeSimEngineConfig>;
  /** 字段加密配置 */
  encryptionConfig?: EncryptionConfig;
  /** 跳过迁移（当数据库已由 createDatabase() 工厂初始化时设为 true） */
  skipMigrations?: boolean;
  /** 租户 ID（用于事件租户隔离，默认 'default'） */
  tenantId?: string;
}

export class ChronoSynthOS {
  readonly bus: EventBus;
  readonly core: CoreRhythmLayer;
  readonly accelerated: AcceleratedLayer;
  readonly meta: MetaRegulationLayer;
  readonly snapshots: SnapshotStore;
  readonly evolution: EvolutionMerger;
  readonly updateGate: UpdateGate;
  readonly patternExtractor: MemoryPatternExtractor;
  readonly lifeSimulation: LifeSimulationService;
  readonly queue: TaskQueue;

  private readonly db: IDatabase;
  private readonly clock: Clock;
  private readonly logger: Logger;
  private readonly tenantId: string;
  private stopped = false;
  private closed = false;

  constructor(config: ChronoSynthOSConfig = {}) {
    this.db = config.db ?? createMemoryDatabase();
    this.clock = config.clock ?? realClock;
    this.logger = config.logger ?? new ConsoleLogger('info');
    this.tenantId = config.tenantId ?? 'default';

    /* 初始化数据库表（createDatabase 工厂已处理迁移时跳过） */
    if (!config.skipMigrations) {
      runDslSqliteMigrations(this.db);
    }

    /* 创建事件总线 */
    this.bus = new EventBus();

    /* 更新闸门（需在 MetaRegulationLayer 之前初始化，供其使用） */
    this.updateGate = new UpdateGate(this.db, this.clock, config.updateGateConfig, this.logger);

    /* 记忆模式提取器 */
    this.patternExtractor = new MemoryPatternExtractor(this.clock, this.logger, config.patternExtractionConfig);

    /* 字段加密（可选） */
    const encryption = config.encryptionConfig?.enabled
      ? new FieldEncryption(config.encryptionConfig)
      : undefined;

    /* 注册内核 SQL 执行器 */
    registerCoreSelfExecutors();

    /* 初始化三层 */
    this.core = new CoreRhythmLayer(this.db, this.bus, this.clock, this.logger, config.cognitionConfig, encryption, this.tenantId);
    this.accelerated = new AcceleratedLayer(this.db, this.bus, this.clock, this.logger, config.evaluator, this.tenantId);
    this.meta = new MetaRegulationLayer(this.db, this.bus, this.clock, this.logger, config.integrationConfig, this.updateGate, this.tenantId);

    /* 恢复与演化 */
    this.snapshots = new SnapshotStore(this.db);
    this.evolution = new EvolutionMerger(this.db, this.clock, this.logger);

    /* 任务队列 + 人生模拟 */
    this.queue = new TaskQueue(this.db);
    const lifeSimStore = new LifeSimulationStore(this.db);
    const lifeSimEngine = new LifeSimulationEngine(config.lifeSimulationConfig);
    this.lifeSimulation = new LifeSimulationService(
      lifeSimStore, this.queue, lifeSimEngine, this.bus,
      () => compilePersonaState(this.core),
    );
  }

  /** 获取数据库实例 */
  getDatabase(): IDatabase {
    return this.db;
  }

  /** 获取系统时钟 */
  getClock(): Clock {
    return this.clock;
  }

  /** 获取系统日志器 */
  getLogger(): Logger {
    return this.logger;
  }

  /** 获取租户 ID */
  getTenantId(): string {
    return this.tenantId;
  }

  /** 启动系统 */
  start(): void {
    this.bus.emit('system:started', { timestamp: this.clock.now(), tenantId: this.tenantId });
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
    this.bus.emit('system:snapshot-created', { snapshot, tenantId: this.tenantId });
    this.logger.info('System', `快照已创建: ${snapshot.id} (原因=${reason})`);
    return snapshot;
  }

  /** 最近一次资源分配结果 */
  private lastAllocations: readonly ResourceAllocation[] = [];

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

        /* 恢复 P-OS 层 */
        this.core.restoreSurvivalAnchors(snapshot.coreSelf.survivalAnchors);
        this.core.restoreDecisionStyle(snapshot.coreSelf.decisionStyle);
        this.core.restoreCognitiveModel(snapshot.coreSelf.cognitiveModel);

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

    this.bus.emit('system:snapshot-restored', { snapshotId, tenantId: this.tenantId });
    this.logger.info('System', `系统已从快照恢复: ${snapshotId}`);
    return true;
  }

  /** 运行演化周期：快照 → 合并最佳实验 → 快照 → 差异报告 */
  runEvolutionCycle(): { mergedCount: number; beforeSnapshotId: string; afterSnapshotId: string; diffReport: EvolutionDiffReport } {
    const beforeSnapshot = this.createSnapshot('pre_evolution');

    const completed = this.accelerated.getAllPersonas().filter(p => p.status === 'completed');
    const { mergedVersionIds, valueDelta, diffReport } = this.evolution.merge(completed, this.core, this.meta);

    const afterSnapshot = this.createSnapshot('manual');

    if (mergedVersionIds.length > 0) {
      this.evolution.persistRecord(beforeSnapshot.id, afterSnapshot.id, mergedVersionIds, valueDelta, diffReport);
      this.bus.emit('system:evolution-completed', { mergedVersionIds, diffReport, tenantId: this.tenantId });
      this.logger.info('System', `演化完成: ${diffReport.summary}`);
    }

    return {
      mergedCount: mergedVersionIds.length,
      beforeSnapshotId: beforeSnapshot.id,
      afterSnapshotId: afterSnapshot.id,
      diffReport,
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

  /** 将价值漂移提案路由到 UpdateGate */
  private applyValueDriftProposals(proposals: readonly ValueUpdateProposal[], trigger: UpdateTrigger): void {
    for (const proposal of proposals) {
      this.updateGate.tryApply(
        'L1', trigger, proposal.valueId,
        String(proposal.currentWeight), String(proposal.suggestedWeight),
        proposal.delta, proposal.reason,
        () => { this.core.updateValueParams(proposal.valueId, { weight: proposal.suggestedWeight }); },
      );
    }
  }

  /** 运行认知周期：固化 → 衰减(含L1) → 容量淘汰(L2) → 刷新工作记忆 → 情绪事件 → 模式提取 → 价值漂移 */
  runCognitionCycle(): { decayedCount: number; consolidatedCount: number; patternsFound: number; emotionalEvents: number; evictedCount: number } {
    /* 先固化（基于当前显著性判断，含L3清理），再衰减（含L1淘汰），然后容量淘汰（L2），最后刷新工作记忆 */
    const consolidated = this.core.runConsolidation();
    const decayResult = this.core.runMemoryDecay();
    const capacityEvicted = this.core.runMemoryEviction();
    this.core.refreshWorkingMemory();

    /* 强情绪事件检测 → 即时价值漂移（must-think 第八节触发机制之一） */
    const emotionalProposals = this.patternExtractor.extractEmotionalEvents(
      this.core.memories.getAllMemories(),
      this.core.values.getAll(),
    );
    this.applyValueDriftProposals(emotionalProposals, 'emotional_event');

    /* 模式提取 → 价值漂移提案（must-think 第六节） */
    const patterns = this.patternExtractor.extractPatterns(
      this.core.memories.getAllMemories(),
      this.core.values.getAll(),
    );
    this.applyValueDriftProposals(
      this.patternExtractor.patternsToProposals(patterns, this.core.values.getAll()),
      'statistical_drift',
    );
    if (patterns.length > 0) {
      this.bus.emit('system:patterns-extracted', { count: patterns.length, tenantId: this.tenantId });
    }

    return {
      decayedCount: decayResult.decayed.length,
      consolidatedCount: consolidated.length,
      patternsFound: patterns.length,
      emotionalEvents: emotionalProposals.length,
      evictedCount: decayResult.evicted.length + capacityEvicted.length,
    };
  }

  /** 停止系统（幂等） */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    try {
      this.bus.emit('system:stopping', { timestamp: this.clock.now(), tenantId: this.tenantId });
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
