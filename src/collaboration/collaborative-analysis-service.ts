/** 编排：逐 persona 经 getTenantOS().getCore() 解析各自内核 → 单 persona 分析 → mode 汇聚（spec §5.3）。
 * fail-closed：未知/跨租户 persona 先经 getPersonaDetail 校验，抛 NotFoundError NOT_FOUND_PERSONA（约束 7）。 */
import type { TenantOSFactory } from '../multi-tenant/tenant-os-factory.js';
import type { PersonaCoreService } from '../persona-core/persona-core-service.js';
import type { AnalysisRequest, CollaborationMode, CollaborativeReport } from './collaboration-types.js';
import type { BehaviorBoundary } from '../enterprise/persona-template-catalog.js';
import type { AppConfig } from '../config/schema.js';
import { PersonaPerspectiveAnalyzer } from './persona-perspective-analyzer.js';
import { retrieveMemoriesDeterministic } from '../conversation/deterministic-memory-retrieval.js';
import { OfflineConversationResponder } from '../conversation/offline-conversation-responder.js';
import { DecisionEngine } from '../intelligence/decision-engine.js';
import { RuleEngine } from '../intelligence/rule-engine.js';
import { RetrievalService } from '../intelligence/retrieval-service.js';
import { NoOpEmbeddingIndex } from './no-op-embedding-index.js';
import { isValidBoundary } from '../conversation/boundary-utils.js';
import { NotFoundError, ValidationError, ErrorCode } from '../errors/index.js';

export interface CollaborativeAnalysisDeps {
  readonly factory: TenantOSFactory;
  readonly personaCoreService: PersonaCoreService;
  readonly mode: CollaborationMode;
  /** 取 ruleEngine / intelligence.simulation 配置。 */
  readonly config: AppConfig;
}

export class CollaborativeAnalysisService {
  constructor(private readonly deps: CollaborativeAnalysisDeps) {}

  analyze(
    tenantId: string,
    ownerUserId: string,
    personaIds: readonly string[],
    req: AnalysisRequest,
  ): CollaborativeReport {
    const question = req.question?.trim();
    if (!question) throw new ValidationError('question 不能为空', ErrorCode.VALIDATION_REQUIRED);
    const unique = [...new Set(personaIds)];
    if (unique.length === 0) throw new ValidationError('personaIds 不能为空', ErrorCode.VALIDATION_REQUIRED);

    const os = this.deps.factory.getTenantOS(tenantId);
    const clock = os.getClock();
    const logger = os.getLogger();
    /* 零-LLM：构造链无 LLMProvider（autonomous 决策不查询它）。全 persona 共用一个空索引即可。 */
    const noOpIndex = new NoOpEmbeddingIndex();

    /* 先全量校验存在+归属（fail-closed），再解析 core——避免为无效 persona 建空核（约束 7）。
     * 统一 NotFoundError（照 earning.ts:40），不区分 NotFound/Forbidden，不泄露跨租户存在性。 */
    const profiles = unique.map((personaId) => {
      const detail = this.deps.personaCoreService.getPersonaDetail(tenantId, ownerUserId, personaId);
      if (!detail) {
        throw new NotFoundError(`persona ${personaId} 不存在或调用者非 owner`, ErrorCode.NOT_FOUND_PERSONA);
      }
      return { personaId, detail };
    });

    const perspectives = profiles.map(({ personaId, detail }) =>
      this.analyzeOne(os, clock, logger, noOpIndex, personaId, detail, req),
    );

    return this.deps.mode.aggregate(question, perspectives);
  }

  /** 单 persona：解析各自内核 → 装配确定性零-LLM 三段基元 → 分析。 */
  private analyzeOne(
    os: ReturnType<TenantOSFactory['getTenantOS']>,
    clock: ReturnType<ReturnType<TenantOSFactory['getTenantOS']>['getClock']>,
    logger: ReturnType<ReturnType<TenantOSFactory['getTenantOS']>['getLogger']>,
    noOpIndex: NoOpEmbeddingIndex,
    personaId: string,
    detail: { profile?: Record<string, unknown> },
    req: AnalysisRequest,
  ) {
    const core = os.getCore(personaId);
    /* narrative + boundaries 同源 profile（照 conversation-service.ts:604-610 真实取法）。 */
    const profile = (detail.profile ?? {}) as Record<string, unknown>;
    const narrative = typeof profile.narrative === 'string' ? profile.narrative : '';
    const boundaries: BehaviorBoundary[] = Array.isArray(profile.behaviorBoundaries)
      ? (profile.behaviorBoundaries as BehaviorBoundary[]).filter(isValidBoundary)
      : [];
    /* always-enabled RuleEngine：autonomous 无 ruleEngine 抛错（decision-engine.ts:114），
     * disabled ruleEngine 的 evaluate 也抛「Rule engine disabled」（rule-engine.ts:42）。
     * collaboration 的决策是确定性零-LLM 一等主路径，无理由随 tenant config 关掉 → 强制 enabled:true。 */
    const ruleEngine = new RuleEngine(clock, { ...this.deps.config.ruleEngine, enabled: true }, logger);
    /* llm=undefined + noOpIndex → 构造链零 LLMProvider（结构性零-LLM，约束 1）。 */
    const decisionEngine = new DecisionEngine(
      core,
      new RetrievalService(core.memories, noOpIndex),
      undefined /* llm */,
      clock,
      logger,
      this.deps.config.intelligence.simulation,
      ruleEngine,
    );
    const analyzer = new PersonaPerspectiveAnalyzer({
      retrieve: (q) =>
        retrieveMemoriesDeterministic(
          q,
          core.memories.getAllMemories(),
          (id) => core.memories.getEdgesFor(id),
          undefined,
        ),
      decisionEngine,
      responder: new OfflineConversationResponder(),
      narrative,
      boundaries,
    });
    return analyzer.analyze(personaId, req);
  }
}
