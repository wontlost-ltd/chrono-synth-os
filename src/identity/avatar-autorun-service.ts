/**
 * Avatar 自动运行服务
 * 调度器扫描到期配置 → 入队 TaskQueue → TaskWorker handler 执行认知周期 + 知识摄入
 */

import type { IDatabase } from '../storage/database.js';
import type { TaskQueue } from '../queue/task-queue.js';
import type { EventBus } from '../events/event-bus.js';
import type { Logger } from '../utils/logger.js';
import type { QuotaManager } from '../multi-tenant/quota-manager.js';
import type { AvatarService } from './avatar-service.js';
import type { AvatarAutorunStore } from '../storage/avatar-autorun-store.js';
import type { KnowledgeSourceStore } from '../storage/knowledge-source-store.js';
import type { KnowledgeIngestionService } from '../knowledge/knowledge-ingestion-service.js';
import type { TenantOSFactory } from '../multi-tenant/tenant-os-factory.js';
import type { AppConfig } from '../config/schema.js';
import type { AutorunRunMetrics } from '../types/avatar-autorun.js';
import type { PersonaOSState } from '../types/personality-os.js';
import { compilePersonaState } from '../intelligence/persona-state.js';
import { computeProjection } from './avatar-projection-engine.js';
import { LlmReflectionDistiller, type ReflectMemory, type ReflectValue } from '../intelligence/llm-reflection-distiller.js';
import type { LLMProvider } from '../intelligence/llm-provider.js';

export class AvatarAutorunService {
  constructor(
    _db: IDatabase,
    private readonly queue: TaskQueue,
    private readonly bus: EventBus,
    private readonly logger: Logger,
    private readonly quota: QuotaManager | undefined,
    private readonly avatarService: AvatarService,
    private readonly autorunStore: AvatarAutorunStore,
    _knowledgeStore: KnowledgeSourceStore,
    private readonly knowledgeIngestion: KnowledgeIngestionService,
    private readonly tenantFactory: TenantOSFactory,
    _config: AppConfig,
    /** 可选 LLM（ADR-0047 growth 档）：注入时 autorun 在确定性反思后额外跑 LLM 反思蒸馏，
     * 产成长候选过 DistillationService 门。未注入 = 纯确定性成长（向后兼容）。 */
    private readonly llm?: LLMProvider,
  ) {}

  /** 调度器调用：扫描到期配置并入队 */
  scheduleDueRuns(now: number): void {
    const dueConfigs = this.autorunStore.listDueConfigs(now, 50);

    for (const cfg of dueConfigs) {
      /* 配额预检 */
      if (this.quota && !this.quota.checkQuota(cfg.tenantId, 'simulation')) {
        const run = this.autorunStore.createRunLog({
          tenantId: cfg.tenantId,
          avatarId: cfg.avatarId,
          configId: cfg.id,
          taskId: '',
          status: 'skipped',
        });
        this.autorunStore.setRunStatus(run.id, 'skipped', undefined, 'quota_exceeded');
        this.bus.emit('avatar:autorun-failed', {
          tenantId: cfg.tenantId,
          avatarId: cfg.avatarId,
          runId: run.id,
          error: 'quota_exceeded',
        });
        /* 推迟到下个周期 */
        this.autorunStore.claimConfig(cfg.id, now, now + cfg.intervalMs);
        continue;
      }

      /* CAS 抢占 */
      if (this.autorunStore.claimConfig(cfg.id, now, now + cfg.intervalMs)) {
        try {
          this.enqueueRun(cfg.id, cfg.tenantId, cfg.avatarId);
        } catch (err) {
          this.logger.warn('AvatarAutorun', `入队失败: ${err instanceof Error ? err.message : String(err)}`);
          this.autorunStore.updateLastError(cfg.id, err instanceof Error ? err.message : String(err));
        }
      }
    }
  }

  /** 入队一次运行 */
  enqueueRun(configId: string, tenantId: string, avatarId: string): { runId: string; taskId: string } {
    const run = this.autorunStore.createRunLog({
      tenantId,
      avatarId,
      configId,
      taskId: '',
      status: 'pending',
    });

    const taskId = this.queue.enqueue(
      tenantId,
      'avatar_autorun',
      { runId: run.id, configId },
    );

    this.autorunStore.updateRunTaskId(run.id, taskId);
    this.bus.emit('avatar:autorun-enqueued', {
      tenantId, avatarId, configId, runId: run.id, taskId,
    });

    return { runId: run.id, taskId };
  }

  /** TaskWorker handler 执行入口 */
  async executeRun(runId: string, signal: AbortSignal): Promise<void> {
    const run = this.autorunStore.getRun(runId);
    if (!run) throw new Error(`运行日志 ${runId} 不存在`);

    const config = this.autorunStore.getConfigById(run.configId);
    if (!config) throw new Error(`自动运行配置 ${run.configId} 不存在`);

    const avatar = this.avatarService.getById(config.avatarId);
    if (!avatar) throw new Error(`Avatar ${config.avatarId} 不存在`);

    const tenantOS = this.tenantFactory.getTenantOS(run.tenantId);

    this.autorunStore.setRunStatus(runId, 'running');
    this.bus.emit('avatar:autorun-started', {
      tenantId: run.tenantId, avatarId: run.avatarId, runId,
    });

    try {
      /* 1. 计算基础 PersonaOS 状态 */
      const base = compilePersonaState(tenantOS.core);
      computeProjection(base, avatar); /* 触发投影缓存热身 */

      /* 2. 运行认知周期（衰减 + 固化 + 淘汰） */
      tenantOS.runCognitionCycle();

      /* 3. 知识摄入（传入租户级 memoryGraph 保证隔离） */
      const ingestResult = await this.knowledgeIngestion.ingest(
        run.tenantId,
        config.knowledgeSourceIds,
        signal,
        tenantOS.core.memories,
      );

      /* 3.5 LLM 反思（ADR-0047 growth 档，可选）：确定性反思（runCognitionCycle）已跑，这里用 LLM
       * 作为「老师」额外反思最近记忆产更丰富候选，过 DistillationService 同一安全门（三重证据门防
       * 幻觉）。未注入 LLM 则跳过（纯确定性成长，不靠 marketplace 也能长）。失败不影响 autorun 主流程。 */
      if (this.llm) {
        await this.runLlmReflection(tenantOS, run.tenantId, base);
      }

      /* 4. 漂移检测 */
      let driftScore = 0;
      const now = Date.now();
      if (config.lastDriftCheckAt === null || now - config.lastDriftCheckAt >= config.driftCheckIntervalMs) {
        const currentProjected = computeProjection(compilePersonaState(tenantOS.core), avatar);
        driftScore = this.evaluateDrift(base, currentProjected);
        this.autorunStore.updateDriftCheckTime(config.id, now);

        if (driftScore >= config.driftThreshold) {
          this.bus.emit('avatar:drift-detected', {
            tenantId: run.tenantId,
            avatarId: run.avatarId,
            driftScore,
            threshold: config.driftThreshold,
          });
        }
      }

      /* 5. 记录指标 */
      const metrics: AutorunRunMetrics = {
        memoriesCreated: ingestResult.imported,
        patternsFound: 0,
        valuesProposed: 0,
        driftScore,
        knowledgeItemsIngested: ingestResult.imported,
        knowledgeItemsSkipped: ingestResult.skipped,
      };

      this.autorunStore.setRunStatus(runId, 'completed', metrics);
      this.autorunStore.updateLastError(config.id, null);
      this.bus.emit('avatar:autorun-completed', {
        tenantId: run.tenantId, avatarId: run.avatarId, runId, metrics,
      });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.autorunStore.setRunStatus(runId, 'failed', undefined, errorMsg);
      this.autorunStore.updateLastError(config.id, errorMsg);
      this.bus.emit('avatar:autorun-failed', {
        tenantId: run.tenantId, avatarId: run.avatarId, runId, error: errorMsg,
      });
      throw err;
    }
  }

  /** 评估漂移：对比 base 与 projected 的 L1 价值观权重差异 */
  evaluateDrift(base: PersonaOSState, projected: PersonaOSState): number {
    let totalDiff = 0;
    let count = 0;

    /* L1 价值观权重偏差 */
    for (const [id, baseVal] of base.L1) {
      const projVal = projected.L1.get(id);
      if (projVal) {
        totalDiff += Math.abs(baseVal.weight - projVal.weight);
        count++;
      }
    }

    /* L2 决策风格偏差 */
    const styleDiffs = [
      Math.abs(base.L2.riskAppetite - projected.L2.riskAppetite),
      Math.abs(base.L2.timeHorizon - projected.L2.timeHorizon),
      Math.abs(base.L2.explorationBias - projected.L2.explorationBias),
    ];
    totalDiff += styleDiffs.reduce((s, d) => s + d, 0);
    count += styleDiffs.length;

    return count > 0 ? totalDiff / count : 0;
  }

  /**
   * LLM 反思（ADR-0047 growth 档）：读租户 OS core 的高显著记忆 + 价值 + 叙事，交
   * LlmReflectionDistiller 产成长候选过蒸馏门。失败仅记日志，不影响 autorun 主流程。
   * personaId 用 OS core 约定的 'default'（与 learning-benchmark / 收益蒸馏一致）。
   */
  private async runLlmReflection(
    tenantOS: ReturnType<TenantOSFactory['getTenantOS']>,
    tenantId: string,
    preCycle: PersonaOSState,
  ): Promise<void> {
    try {
      const state = tenantOS.core.getState();
      const values: ReflectValue[] = [...state.values.values()].map((v) => ({ id: v.id, label: v.label, weight: v.weight }));
      /* 高显著记忆优先（反思聚焦「最近最在意的」），脱敏只取 content/salience/valence。 */
      const memories: ReflectMemory[] = [...state.memories.values()]
        .sort((a, b) => b.salience - a.salience)
        .slice(0, 24)
        .map((m) => ({ id: m.id, content: m.content, salience: m.salience, valence: m.valence }));
      if (values.length === 0 || memories.length === 0) return;

      /* 单周期单 value 累计漂移预算（Codex 复审）：算本周期确定性反思（runCognitionCycle→UpdateGate）
       * 已对各 value 应用的漂移 = 当前权重 − 周期前权重，传给 distiller 从 0.05 预算里扣，避免两条
       * 自动路径同周期对同一 value 叠加超 0.05。 */
      const appliedDeltas = new Map<string, number>();
      for (const v of state.values.values()) {
        const before = preCycle.L1.get(v.id)?.weight;
        if (before !== undefined && before !== v.weight) appliedDeltas.set(v.id, v.weight - before);
      }

      const distiller = new LlmReflectionDistiller(tenantOS.distillation, this.llm!, this.logger);
      const result = await distiller.distill({ personaId: 'default', narrative: state.narrative, values, memories, appliedDeltas });
      if (result.candidatesIngested > 0) {
        this.logger.info('AvatarAutorun', `LLM 反思产 ${result.candidatesIngested} 个成长候选（tenant=${tenantId}）`);
      }
    } catch (err) {
      this.logger.warn('AvatarAutorun', `LLM 反思失败（不影响主流程）: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
