/**
 * ChronoSynth OS 主编排器
 * 协调三层架构（慢层/快层/元调控层）+ 恢复/演化机制
 */

import { ProactiveEngine } from './proactivity/proactive-engine.js';
import { ProactiveMessageStore } from './storage/proactive-message-store.js';
import { OfflineConversationResponder } from './conversation/offline-conversation-responder.js';
import { COMPANION_BASELINE_BOUNDARIES } from './conversation/companion-boundaries.js';
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
import { resolvePersonaUnverifiedGrowthBudget } from './storage/persona-governance-store.js';
import {
  computeDynamicGrowthBudget,
  growthAggressivenessFromDecisionStyle,
  paramsForAggressiveness,
  DEFAULT_DYNAMIC_GROWTH_BUDGET_PARAMS,
} from './intelligence/dynamic-growth-budget.js';
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
import { ArtifactCompiler } from './intelligence/artifact-compiler.js';
import { DistillationService } from './intelligence/distillation-service.js';
import { CapabilityIndexProjector } from './intelligence/capability-index-projector.js';
import {
  DEFAULT_DISTILLATION_POLICY, type DistillationPolicy,
  perturbDecisionStyle, archetypeDecisionStyle, type PersonalityArchetype,
  DEFAULT_PROACTIVE_GATE_CONFIG, type ProactiveGateConfig,
} from '@chrono/kernel';
import { EarningOutcomeDistiller } from './intelligence/earning-outcome-distiller.js';
import { DistilledArtifactStore } from './storage/distilled-artifact-store.js';
import { PersonaLeaseStore } from './storage/persona-lease-store.js';
import { ResponseTemplateStore } from './storage/response-template-store.js';
import { RuleStore } from './storage/rule-store.js';
import { TaskQueue } from './queue/task-queue.js';
import { FeatureFlagService } from './feature-flags/feature-flag-service.js';
import { AuditChainAnchorService, type AuditChainKmsProvider } from './audit/audit-chain-anchor-service.js';

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
  /** 蒸馏策略（含不确定性预算：窗口内 auto-compile 上限）；缺省用 DEFAULT_DISTILLATION_POLICY */
  distillationPolicy?: Partial<DistillationPolicy>;
  /** 动态成长预算（ADR-0048）：无 per-persona override 的人格，不确定性预算随核心成熟度 U 形自适应
   * （婴儿激进/成熟保守）。默认 true。false → 回退全局 policy 静态预算（旧行为，默认不限）。 */
  dynamicGrowthBudgetEnabled?: boolean;
  /**
   * 主动性门控配置（ADR-0054）：覆盖 DEFAULT_PROACTIVE_GATE_CONFIG。生产可达的关闭入口
   * （红线 3）：`{ enabled: false }` 完全关闭主动消息；也可调静默期/频率上限。缺省用默认（保守）。
   */
  proactivity?: Partial<ProactiveGateConfig>;
  /**
   * 性格出生设定（②原型 + ③随机化）：**新 persona**（决策风格未写过）在 start() 时设定性格——
   *   - archetype（可选，②）：出生取该原型的 6 维基准（explorer/guardian/analyst/doer）；不给则用默认。
   *   - seed + magnitude（可选，③）：在基准上加可复现扰动，同原型也有个体差异；magnitude 缺省/0 不扰动。
   * 二者叠加：archetype 给基准性格，扰动给个体差异。全缺省 → 默认风格（向后兼容，旧行为不变）。
   * seed 一般用 personaId/tenantId（同 seed → 同结果，可复现）。
   */
  personalitySeed?: { seed?: string; magnitude?: number; archetype?: PersonalityArchetype };
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
  /** 审计链 KMS 尾锚后台任务配置；未提供 kmsProvider 时不启动锚定 */
  auditChainAnchors?: {
    kmsProvider?: AuditChainKmsProvider;
    featureFlags?: FeatureFlagService;
    intervalMs?: number;
  };
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
  /** ADR-0047：蒸馏管线（LLM 教学输出 → 门控 → 编译进确定性内核） */
  readonly distillation: DistillationService;
  /** ADR-0048：收益蒸馏器（任务收益 → 蒸馏候选，闭合 earn→grow 飞轮） */
  readonly earningDistiller: EarningOutcomeDistiller;
  /** ADR-0047/0048：per-persona 并发锁（compile mutex + earning lease，多实例 gating） */
  readonly personaLeases: PersonaLeaseStore;
  /** ADR-0047：响应模板专用持久表（版本化、不衰减；取代会衰减的 procedural memory） */
  readonly responseTemplates: ResponseTemplateStore;
  /** ADR-0047：规则专用持久表（版本化；RuleEngine 消费 active rules） */
  readonly rules: RuleStore;
  readonly queue: TaskQueue;
  /** Phase 1B 可选：开启 audit chain KMS 锚定时存在 */
  readonly auditChainAnchors: AuditChainAnchorService | undefined;
  /** 平台级 feature flag 服务；web 与后端 worker 共享同一份决策来源。
   *  Web 通过 /api/v1/feature-flags/{bootstrap,stream} 消费，
   *  后端 worker 通过 isEnabled() 直接查询。 */
  readonly featureFlags: FeatureFlagService;

  /** ADR-0054 主动性引擎：订阅内部信号 → 确定性门控 → 主动消息入队（start() 时启动）。 */
  private readonly proactiveEngine: ProactiveEngine;

  /** ADR-0057 L7 能力索引投影器：订阅 capability-learned → 投影 capability_index（start() 时启动）。 */
  private readonly capabilityIndexProjector: CapabilityIndexProjector;

  private readonly db: IDatabase;
  private readonly clock: Clock;
  private readonly logger: Logger;
  private readonly tenantId: string;
  /* K3(ADR-0056) per-persona CoreRhythmLayer 工厂：按 personaId 缓存独立认知内核（缓存 persona-aware，
   * 防 DB 隔离了内存却共享同一 core 实例而串脑，ADR 红线5）。 */
  private readonly personaCores = new Map<string, CoreRhythmLayer>();
  private cognitionConfig?: Partial<MemoryCognitionConfig>;
  private encryption?: FieldEncryption;
  /** 性格出生设定（②原型 + ③随机化）；缺省不设。仅在 start() 用一次。 */
  private readonly personalitySeed?: { seed?: string; magnitude?: number; archetype?: PersonalityArchetype };
  private stopped = false;
  private closed = false;

  constructor(config: ChronoSynthOSConfig = {}) {
    this.personalitySeed = config.personalitySeed;
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

    /* Feature flag 服务，bus 注入后 mutation 自动广播。
     * 单例确保 web SSE 推送的状态与后端 worker 的 isEnabled() 决策
     * 来自同一来源。 */
    this.featureFlags = new FeatureFlagService({ bus: this.bus });

    /* 更新闸门（需在 MetaRegulationLayer 之前初始化，供其使用） */
    this.updateGate = new UpdateGate(this.db, this.clock, config.updateGateConfig, this.logger);

    /* 记忆模式提取器 */
    this.patternExtractor = new MemoryPatternExtractor(this.clock, this.logger, config.patternExtractionConfig);

    /* 字段加密（可选） */
    const encryption = config.encryptionConfig?.enabled
      ? new FieldEncryption(config.encryptionConfig)
      : undefined;
    /* K3(ADR-0056)：存构造依赖供 getCore() 按需建 per-persona core。 */
    this.cognitionConfig = config.cognitionConfig;
    this.encryption = encryption;

    /* 注册内核 SQL 执行器 */
    registerCoreSelfExecutors();

    /* 初始化三层。core = default persona 的 CoreRhythmLayer（兼容 facade；新代码用 getCore(personaId)）。 */
    this.core = this.getCore('default');
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

    /* ADR-0047 蒸馏管线：候选 → 校验 → 门控 → 编译进核心（带快照/回滚）。
     * snapshotGuard 复用编排器的事务级 createSnapshot/restoreFromSnapshot。 */
    const artifactStore = new DistilledArtifactStore(this.db, this.tenantId);
    /* ADR-0047：response_template 编译进专用持久表（版本化、不衰减），而非会被衰减驱逐的 procedural memory。 */
    this.responseTemplates = new ResponseTemplateStore(this.db, this.tenantId);
    /* ADR-0047：rule 编译进专用规则表，作为 RuleEngine 的确定性排序调整输入。 */
    this.rules = new RuleStore(this.db, this.tenantId);
    /* ADR-0056 K5：编译经 resolver 按 personaId 寻址到该 persona 的内核，而非共享 default core。
     * 人格特征三件套(narrative/decision_style/cognitive_model)+ response_template/rule 真正 per-persona 隔离；
     * value_shift/memory_edge 底层 store 仍 tenant 键(K5b 后续)。每个数字员工的自成长(earning/perception/
     * reflection 蒸馏物)经此塑造它自己的认知人格（三件套维度）。 */
    const artifactCompiler = new ArtifactCompiler((pid) => this.getCore(pid), this.logger, this.responseTemplates, this.clock, this.rules);
    /* ADR-0047/0048 多实例 gating：并发锁，供租户级全局 compile mutex 与 per-persona
     * earning lease 共用（同一个 store，不同 scope）。 */
    this.personaLeases = new PersonaLeaseStore(this.db, this.tenantId);
    /* 有效蒸馏策略（含全局不确定性预算上限——运维/部署级安全天花板，默认不限）。 */
    const distillationPolicy = config.distillationPolicy
      ? { ...DEFAULT_DISTILLATION_POLICY, ...config.distillationPolicy }
      : DEFAULT_DISTILLATION_POLICY;
    this.distillation = new DistillationService({
      store: artifactStore,
      compiler: artifactCompiler,
      policy: distillationPolicy,
      snapshotGuard: {
        /* ADR-0056 K5：按 persona 快照/回滚——读写对称（编译写哪个 persona core，回滚就恢复哪个）。
         * rollback 用 coreSelfOnly：只恢复该 persona 自己的内核，**不**触碰租户级 personas/conflicts/
         * allocations。compile mutex 只串行化编译、不阻止并发演化/治理路由改租户级状态，故把"窗口内租户级
         * 未变"从假设移进机制——即便并发改了，coreSelfOnly 也绝不过度回滚（Codex K5 复审建议）。 */
        snapshot: (personaId = 'default') => this.createSnapshot('manual', personaId).id,
        rollback: (snapshotId: string) => this.restoreFromSnapshot(snapshotId, { coreSelfOnly: true }),
      },
      bus: this.bus,
      clock: this.clock,
      logger: this.logger,
      tenantId: this.tenantId,
      leaseStore: this.personaLeases,
      /* 预算解析（ADR-0048）：①用户显式 per-persona override **绝对优先**；②否则若动态开启（默认），
       * 按当前核心记忆数 U 形动态算（婴儿激进/成熟保守），并与全局 policy 上限取 **min**——动态不绕过
       * 运维安全天花板（Codex 复审：全局 policy 设了上限就该生效，默认 policy=不限故 min 不影响动态）；
       * ③动态关闭 → undefined → 回退全局静态 policy 预算（旧行为）。
       * 用 getMemoryCount()（SELECT COUNT(*)）取核心规模，不全量加载解密（Codex 复审性能）。
       * 注：动态读 tenant-global core 的记忆数——companion 单人格('default')语义正确；多 persona 租户
       * 的预算分桶（按 personaId 计数）vs 核心写入（共享 this.core）是既有蒸馏设计属性，非本变更引入。 */
      budgetResolver: (personaId: string) => {
        const override = resolvePersonaUnverifiedGrowthBudget(this.db, this.tenantId, personaId);
        if (override !== undefined) return override;
        if (config.dynamicGrowthBudgetEnabled === false) return undefined;
        /* 按性格调制动态预算曲线（ADR-0048）：从已落库 decision style 的 explorationBias+riskAppetite
         * 派生激进度（explorer 激进/guardian 保守），调 openRatioMax/ceil。decision style 未写过
         * （极早期连默认都没写）→ 用默认中性参数。U 形随成熟度机制不变，仅曲线高低随性格。 */
        const params = this.core.decisionStyle.exists()
          ? paramsForAggressiveness(growthAggressivenessFromDecisionStyle(this.core.decisionStyle.get()))
          : DEFAULT_DYNAMIC_GROWTH_BUDGET_PARAMS;
        const dynamic = computeDynamicGrowthBudget(this.core.memories.getMemoryCount(), params);
        return Math.min(dynamic, distillationPolicy.unverifiedGrowthBudgetPerWindow);
      },
    });
    /* ADR-0048：收益蒸馏器复用蒸馏门，把任务收益转为成长候选 */
    this.earningDistiller = new EarningOutcomeDistiller(this.distillation, this.logger);

    /* 可选：注入 KmsProvider 后开启审计链尾签名。flag 默认关闭，
     * 即使注入了 provider，feature flag 也必须显式开启才会签名。 */
    if (config.auditChainAnchors?.kmsProvider) {
      const anchorDeps: ConstructorParameters<typeof AuditChainAnchorService>[0] = {
        db: this.db,
        kmsProvider: config.auditChainAnchors.kmsProvider,
        /* 共享同一实例：admin 端通过 /api/v1/feature-flags 翻转
         * audit.kms-sign-chain-tail 时，anchor service 立即感知。 */
        featureFlags: config.auditChainAnchors.featureFlags ?? this.featureFlags,
        clock: this.clock,
        logger: this.logger,
      };
      if (config.auditChainAnchors.intervalMs !== undefined) {
        anchorDeps.intervalMs = config.auditChainAnchors.intervalMs;
      }
      this.auditChainAnchors = new AuditChainAnchorService(anchorDeps);
    } else {
      this.auditChainAnchors = undefined;
    }

    /* ADR-0054 主动性引擎：订阅内部信号 → 确定性门控 → 主动消息入队。start() 时订阅。
     * 生产可达关闭入口（红线 3）：config.proactivity 覆盖默认（保守）配置，{enabled:false} 全关。
     * P4 个性化：只读人格状态（叙事 + 纯读记忆，红线 2 不改身份）+ never_discuss 自检（红线 4）。 */
    const proactiveResponder = new OfflineConversationResponder();
    this.proactiveEngine = new ProactiveEngine({
      bus: this.bus,
      store: new ProactiveMessageStore(this.db, () => this.clock.now(), this.tenantId),
      now: () => this.clock.now(),
      logger: this.logger,
      tenantId: this.tenantId,
      config: { ...DEFAULT_PROACTIVE_GATE_CONFIG, ...config.proactivity },
      context: {
        getNarrative: () => this.core.narrative.get(),
        getMemoryContent: (id) => this.core.memories.getMemory(id)?.content,
      },
      boundaryChecker: {
        violates: (text) => proactiveResponder.violatesNeverDiscuss(text, COMPANION_BASELINE_BOUNDARIES),
      },
    });

    /* ADR-0057 L7：能力索引投影器——订阅 capability-learned（L6 落核后发）→ 确定性投影 capability_index。
     * 已学能力的正式来源（GapDetector 据此算缺口差集，替换 L2 status='passed' 扫描）。start() 时订阅。 */
    this.capabilityIndexProjector = new CapabilityIndexProjector({
      bus: this.bus,
      db: this.db,
      logger: this.logger,
      now: () => this.clock.now(),
    });
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

  /**
   * K3(ADR-0056)：取某 persona 的认知内核（CoreRhythmLayer）。同 personaId 返回**同一缓存实例**——
   * 防 DB 按 (tenant, persona) 隔离了但内存共享一个 core 而串脑（ADR 红线5：缓存 persona-aware）。
   *   - personaId 缺省 'default'：= 兼容 facade，等价于 this.core（legacy companion/manager 路径）。
   *   - 不同 personaId：独立 CoreRhythmLayer，各自的 decision_style/cognitive_model/narrative（K2 已隔离）。
   * 工厂只**寻址/加载**，不 seed persona 业务状态（ADR 红线9：persona 出生由 K4 显式 bootstrap）。
   */
  getCore(personaId = 'default'): CoreRhythmLayer {
    const cached = this.personaCores.get(personaId);
    if (cached) return cached;
    const core = new CoreRhythmLayer(
      this.db, this.bus, this.clock, this.logger, this.cognitionConfig, this.encryption, this.tenantId, personaId,
    );
    this.personaCores.set(personaId, core);
    return core;
  }

  /** 已实例化(缓存)的 persona core 身份列表（可观测；不含未被 getCore 触达的 persona）。 */
  listPersonaCores(): readonly string[] {
    return [...this.personaCores.keys()].sort();
  }

  /**
   * 构造一个**影子认知内核**（ADR-0057 L4 D0.6）——同 db/clock/persona，但**独立的隔离 EventBus**
   * （production listeners 不订阅它 → core:* 事件不外发，红线 18）。**不缓存**（不进 personaCores，与 os.core 隔离）。
   * 配合验收器在 BEGIN/ROLLBACK 事务里用它：候选编译进影子核 → 作答 → 整事务回滚 → 主内核 + 所有持久表零污染。
   */
  createShadowCore(personaId: string): CoreRhythmLayer {
    const silentBus = new EventBus();
    return new CoreRhythmLayer(
      this.db, silentBus, this.clock, this.logger, this.cognitionConfig, this.encryption, this.tenantId, personaId,
    );
  }

  /** 获取租户 ID */
  getTenantId(): string {
    return this.tenantId;
  }

  /** 启动系统 */
  start(): void {
    this.auditChainAnchors?.start();
    this.maybeSeedPersonality();
    this.proactiveEngine.start();
    this.capabilityIndexProjector.start();
    this.bus.emit('system:started', { timestamp: this.clock.now(), tenantId: this.tenantId });
    this.logger.info('System', 'ChronoSynth OS 已启动');
  }

  /**
   * 性格出生随机化（③）：仅当配了 personalitySeed **且**决策风格 row 尚未写过（懒默认、全新 persona、
   * 未演化/未恢复快照）时，对 6 维 decision style 加可复现扰动。
   * 已写过 row（扰动/演化/恢复）的 persona 不再扰动，保证重启不漂移。
   */
  private maybeSeedPersonality(): void {
    const cfg = this.personalitySeed;
    if (!cfg) return;
    const hasArchetype = cfg.archetype !== undefined;
    const hasPerturb = (cfg.magnitude ?? 0) > 0 && cfg.seed !== undefined;
    if (!hasArchetype && !hasPerturb) return; /* 既无原型也无扰动 → 不设（向后兼容） */
    /* 出生扰动只能作用于**全新** persona——多租户工厂按 tenantId 派生 seed 接线后，「现有租户」
     * 不能被首次出生扰动改写已落库人格。判定「全新」必须看**整个核心是否纯净**，而非仅某一维 row：
     * 现有租户可能只写过 memories（/perceive、chat）/ survival anchors（/pos/survival）/ cognitive
     * model（POS L3），却从未写 decision_style，若只看部分维度会被误判新生而扰动（Codex 两轮退回）。
     * 因此覆盖 CoreSelfState 全部 7 个持久核心维度：values/memories/edges/narrative/survivalAnchors/
     * decisionStyle/cognitiveModel——任一非空即非纯净新生。
     * 边界：纯净以**核心人格状态**为界，不以租户所有业务表（distilled_artifacts/wallet/avatars 等
     * 外围/操作状态）为界——只要核心人格仍是懒默认，出生时初始化 decision style 是安全的。
     * decision_style/cognitive_model 用 row 存在性（而非 updatedAt===0）判——set* 用 clock.now() 写
     * updatedAt，TestClock(0) 下 updatedAt 仍 0，用 updatedAt 会误判已写维度为未写→重启漂移；row
     * 存在性与时钟无关。 */
    const state = this.core.getState();
    const isPristine =
      !this.core.decisionStyle.exists() &&
      !this.core.cognitiveModel.exists() &&
      state.values.size === 0 &&
      state.memories.size === 0 &&
      state.edges.length === 0 &&
      state.survivalAnchors.length === 0 &&
      state.narrative.trim() === '';
    if (!isPristine) return; /* 非纯净新生（已有任何核心持久状态）→ 不动 */
    const now = this.clock.now();
    /* ② 基准：有原型用原型的 6 维，否则用当前默认。 */
    const base = hasArchetype ? archetypeDecisionStyle(cfg.archetype!, now) : state.decisionStyle;
    /* ③ 个体扰动：在基准上加可复现扰动（无扰动配置则直接用基准）。 */
    const seeded = hasPerturb ? perturbDecisionStyle(base, cfg.seed!, cfg.magnitude!, now) : base;
    this.core.setDecisionStyle(seeded);
    this.logger.info('System', `性格出生设定：archetype=${cfg.archetype ?? '—'} seed=${cfg.seed ?? '—'} magnitude=${cfg.magnitude ?? 0}`);
  }

  /**
   * 创建系统快照（事务读取确保一致性）。
   *
   * personaId（ADR-0056 K5）：指定时 coreSelf 取**该 persona 内核**的状态（用于 per-persona 蒸馏编译的
   * 回滚边界——读写对称：编译写哪个 persona core，回滚就恢复哪个）。省略时取 default core（系统级，向后兼容）。
   * personas/activeConflicts/allocations 是租户级（加速实验/冲突/分配），与 persona core 无关，始终全量快照。
   */
  createSnapshot(reason: SystemSnapshot['reason'] = 'manual', personaId = 'default'): SystemSnapshot {
    const snapshot = this.db.transaction(() => {
      const snap: SystemSnapshot = {
        id: generatePrefixedId('snap'),
        personaId,
        coreSelf: this.getCore(personaId).getState(),
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

  /**
   * 从快照恢复系统状态（事务保护）。
   *
   * coreSelfOnly（ADR-0056 K5）：仅恢复快照所属 persona 的 coreSelf（七维人格状态），**不**触碰租户级的
   * personas（加速实验）/conflicts/allocations。用于 per-persona 蒸馏编译失败的精确补偿——把"编译窗口内租户级
   * 状态未变"这个假设从注释**移进机制**：即便另一实例/请求在窗口内并发改了租户级状态，coreSelfOnly 回滚也只
   * 动该 persona 自己的内核，绝不过度回滚租户级状态（Codex K5 复审 8.0 建议）。
   * 省略（默认 full）= 完整恢复（含租户级），供手工回滚/演化回滚/恢复演练，行为与既往一致（向后兼容）。
   */
  restoreFromSnapshot(snapshotId: string, opts?: { coreSelfOnly?: boolean }): boolean {
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
    const coreSelfOnly = opts?.coreSelfOnly === true;

    try {
      this.db.transaction(() => {
        /* coreSelf 恢复到**快照记录的那个 persona 内核**（ADR-0056 K5：读写对称——快照存哪个 persona，
         * 就恢复哪个；老快照无 personaId 字段时回落 default，向后兼容）。 */
        const core = this.getCore(snapshot.personaId ?? 'default');

        /* 清空并恢复核心价值 */
        core.restoreValues(snapshot.coreSelf.values);

        /* 恢复记忆和边 */
        core.restoreMemories(snapshot.coreSelf.memories, snapshot.coreSelf.edges);

        /* 恢复叙事（直接写入，不触发事件） */
        core.narrative.set(snapshot.coreSelf.narrative);

        /* 恢复 P-OS 层 */
        core.restoreSurvivalAnchors(snapshot.coreSelf.survivalAnchors);
        core.restoreDecisionStyle(snapshot.coreSelf.decisionStyle);
        core.restoreCognitiveModel(snapshot.coreSelf.cognitiveModel);

        /* 租户级状态（加速实验人格/冲突）——coreSelfOnly 时跳过，避免过度回滚（per-persona 编译补偿用）。 */
        if (!coreSelfOnly) {
          this.accelerated.restorePersonas(snapshot.personas);
          this.meta.conflicts.restoreConflicts(snapshot.activeConflicts);
        }
      });
    } catch (err) {
      this.logger.error('System', `快照恢复失败: ${snapshotId}`, err);
      return false;
    }

    /* 资源分配状态（内存，租户级）——coreSelfOnly 时同样跳过。 */
    if (!coreSelfOnly) {
      this.lastAllocations = snapshot.allocations;
    }

    this.bus.emit('system:snapshot-restored', { snapshotId, tenantId: this.tenantId });
    this.logger.info('System', `系统已从快照恢复: ${snapshotId}${coreSelfOnly ? '（仅 coreSelf）' : ''}`);
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
      this.proactiveEngine.stop();
      this.capabilityIndexProjector.stop();
      this.auditChainAnchors?.stop();
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
