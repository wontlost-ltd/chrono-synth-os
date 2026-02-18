/**
 * 引导流程路由
 * POST /api/v1/onboarding/start — 创建引导会话
 * POST /api/v1/onboarding/step/:step — 提交步骤数据
 * GET /api/v1/onboarding/status/:sessionId — 获取会话状态
 * POST /api/v1/onboarding/questionnaire — 提交问卷
 * POST /api/v1/onboarding/import — 导入外部数据
 */

import type { FastifyInstance } from 'fastify';
import type { ChronoSynthOS } from '../../chrono-synth-os.js';
import type { AppConfig } from '../../config/schema.js';
import type { IDatabase } from '../../storage/database.js';
import type { TenantOSFactory } from '../../multi-tenant/tenant-os-factory.js';
import { NotFoundError, ValidationError, ErrorCode } from '../../errors/index.js';
import { OnboardingService } from '../../onboarding/onboarding-service.js';
import { QuestionnaireEngine } from '../../onboarding/questionnaire-engine.js';
import { DataIngestion } from '../../onboarding/data-ingestion.js';
import { DecisionEngine } from '../../intelligence/decision-engine.js';
import { RuleEngine } from '../../intelligence/rule-engine.js';
import { EmbeddingIndex } from '../../intelligence/embedding-index.js';
import { RetrievalService } from '../../intelligence/retrieval-service.js';
import { ModelRouter } from '../../intelligence/model-router.js';
import { TokenBudget } from '../../intelligence/token-budget.js';
import { CostTracker } from '../../intelligence/cost-tracker.js';
import {
  OnboardingStep1Schema,
  OnboardingStep2Schema,
  OnboardingStep3Schema,
  OnboardingQuestionnaireSchema,
  OnboardingImportSchema,
} from '../schemas/api-schemas.js';

function safeJsonParse(json: string | null | undefined, fallback: unknown = null): unknown {
  if (!json) return fallback;
  try { return JSON.parse(json); }
  catch { return fallback; }
}

interface OnboardingSessionRow {
  id: string;
  tenant_id: string;
  current_step: number;
  completed_steps_json: string;
  decision_json: string | null;
  simulation_result_json: string | null;
  snapshot_id: string | null;
  created_at: number;
  updated_at: number;
}

export function registerOnboardingRoutes(
  app: FastifyInstance,
  os: ChronoSynthOS,
  config: AppConfig,
  db?: IDatabase,
  tenantFactory?: TenantOSFactory,
): void {
  const sharedDb = db ?? os.getDatabase();
  const tokenBudget = new TokenBudget(config.intelligence.budget, sharedDb);
  const costTracker = new CostTracker(sharedDb);
  const questionnaire = new QuestionnaireEngine();

  function getOS(tenantId: string): ChronoSynthOS {
    if (tenantFactory && tenantId !== 'default') return tenantFactory.getTenantOS(tenantId);
    return os;
  }

  /** 懒加载决策引擎（按租户，LRU 驱逐上限 64） */
  const MAX_TENANT_CACHE = 64;
  const engines = new Map<string, DecisionEngine>();
  const onboardings = new Map<string, OnboardingService>();
  const ingestions = new Map<string, DataIngestion>();
  const embeddingIndexes = new Map<string, EmbeddingIndex>();

  /** 驱逐最旧的租户缓存 */
  function evictOldest(): void {
    if (engines.size < MAX_TENANT_CACHE) return;
    const oldest = engines.keys().next().value;
    if (oldest) {
      engines.delete(oldest);
      onboardings.delete(oldest);
      ingestions.delete(oldest);
      embeddingIndexes.delete(oldest);
    }
  }

  function getEngine(tenantId: string): DecisionEngine {
    const cached = engines.get(tenantId);
    if (cached) {
      engines.delete(tenantId);
      engines.set(tenantId, cached);
      return cached;
    }

    const tenantOS = getOS(tenantId);
    const llm = new ModelRouter({
      provider: config.intelligence.provider,
      model: config.intelligence.model,
      embeddingModel: config.intelligence.embeddingModel,
      apiKey: config.intelligence.apiKey,
      baseUrl: config.intelligence.baseUrl,
      maxTokens: config.intelligence.maxTokens,
      temperature: config.intelligence.temperature,
      tokenBudget,
      costTracker,
      tenantId,
    });
    const idx = new EmbeddingIndex(tenantOS.getDatabase(), tenantOS.getClock(), llm, config.intelligence.embeddingModel);
    embeddingIndexes.set(tenantId, idx);
    const retrieval = new RetrievalService(tenantOS.core.memories, idx);
    const ruleEngine = config.ruleEngine.enabled
      ? new RuleEngine(tenantOS.getClock(), config.ruleEngine, tenantOS.getLogger())
      : undefined;
    const engine = new DecisionEngine(tenantOS.core, retrieval, llm, tenantOS.getClock(), tenantOS.getLogger(), config.intelligence.simulation, ruleEngine);
    evictOldest();
    engines.set(tenantId, engine);
    return engine;
  }

  function getOnboarding(tenantId: string): OnboardingService {
    const cached = onboardings.get(tenantId);
    if (cached) return cached;
    const tenantOS = getOS(tenantId);
    const svc = new OnboardingService(
      tenantOS.core,
      getEngine(tenantId),
      tenantOS.bus,
      tenantOS.getClock(),
      tenantOS.getLogger(),
      (reason) => tenantOS.createSnapshot(reason),
      tenantId,
    );
    onboardings.set(tenantId, svc);
    return svc;
  }

  function getIngestion(tenantId: string): DataIngestion {
    const cached = ingestions.get(tenantId);
    if (cached) return cached;
    const tenantOS = getOS(tenantId);
    if (!embeddingIndexes.has(tenantId)) getEngine(tenantId);
    const ing = new DataIngestion(tenantOS.core, embeddingIndexes.get(tenantId)!);
    ingestions.set(tenantId, ing);
    return ing;
  }

  /* POST /api/v1/onboarding/start */
  app.post('/api/v1/onboarding/start', async (request, reply) => {
    const tenantId = request.tenantId;
    const session = getOnboarding(tenantId).createSession();
    /* 持久化到 DB */
    sharedDb.prepare<void>(
      `INSERT INTO onboarding_sessions (id, tenant_id, current_step, completed_steps_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(session.id, tenantId, session.currentStep, JSON.stringify(session.completedSteps), session.createdAt, session.updatedAt);
    return reply.status(201).send({ data: session });
  });

  /* GET /api/v1/onboarding/status/:sessionId */
  app.get<{ Params: { sessionId: string } }>('/api/v1/onboarding/status/:sessionId', async (request) => {
    const tenantId = request.tenantId;
    const { sessionId } = request.params;

    /* 优先从内存服务读取 */
    const memSession = getOnboarding(tenantId).getSession(sessionId);
    if (memSession) return { data: memSession };

    /* 回退到 DB 读取（服务重启后内存缓存已丢失） */
    const row = sharedDb.prepare<OnboardingSessionRow>(
      'SELECT * FROM onboarding_sessions WHERE id = ? AND tenant_id = ?',
    ).get(sessionId, tenantId);
    if (!row) {
      throw new NotFoundError(`引导会话 ${sessionId} 不存在`, ErrorCode.NOT_FOUND_ONBOARDING);
    }
    return {
      data: {
        id: row.id,
        currentStep: row.current_step,
        completedSteps: safeJsonParse(row.completed_steps_json, []) as number[],
        decision: row.decision_json ? safeJsonParse(row.decision_json) : undefined,
        simulationResult: row.simulation_result_json ? safeJsonParse(row.simulation_result_json) : undefined,
        snapshotId: row.snapshot_id ?? undefined,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      },
    };
  });

  /* POST /api/v1/onboarding/step/:step */
  app.post<{ Params: { step: string }; Querystring: { sessionId?: string } }>('/api/v1/onboarding/step/:step', async (request) => {
    const step = Number.parseInt(request.params.step, 10);
    const sessionId = request.query.sessionId;
    if (!sessionId) {
      throw new ValidationError('缺少 sessionId 查询参数', ErrorCode.VALIDATION_REQUIRED);
    }

    const tenantId = request.tenantId;
    if (step < 1 || step > 5 || Number.isNaN(step)) {
      throw new ValidationError(`无效步骤: ${request.params.step}，有效范围 1-5`, ErrorCode.VALIDATION_RANGE);
    }

    let data: Record<string, unknown> = {};
    if (step === 1) data = OnboardingStep1Schema.parse(request.body);
    else if (step === 2) data = OnboardingStep2Schema.parse(request.body);
    else if (step === 3) data = OnboardingStep3Schema.parse(request.body);

    const session = await getOnboarding(tenantId).submitStep(sessionId, step, data);

    /* 更新 DB */
    sharedDb.prepare<void>(
      `UPDATE onboarding_sessions SET current_step = ?, completed_steps_json = ?, decision_json = ?, simulation_result_json = ?, snapshot_id = ?, updated_at = ?
       WHERE id = ? AND tenant_id = ?`,
    ).run(
      session.currentStep,
      JSON.stringify(session.completedSteps),
      session.decision ? JSON.stringify(session.decision) : null,
      session.simulationResult ? JSON.stringify(session.simulationResult) : null,
      session.snapshotId ?? null,
      session.updatedAt,
      sessionId,
      tenantId,
    );

    return { data: session };
  });

  /* POST /api/v1/onboarding/questionnaire */
  app.post('/api/v1/onboarding/questionnaire', async (request) => {
    const tenantId = request.tenantId;
    const tenantOS = getOS(tenantId);
    const body = OnboardingQuestionnaireSchema.parse(request.body);
    const result = questionnaire.evaluate(body.responses);
    if (Object.keys(result.decisionStyle).length > 0) {
      tenantOS.core.setDecisionStyle(result.decisionStyle);
    }
    if (Object.keys(result.cognitiveModel).length > 0) {
      tenantOS.core.setCognitiveModel(result.cognitiveModel);
    }
    return { data: result };
  });

  /* POST /api/v1/onboarding/import */
  app.post('/api/v1/onboarding/import', async (request) => {
    const tenantId = request.tenantId;
    const body = OnboardingImportSchema.parse(request.body);
    const total = (body.journalEntries?.length ?? 0) + (body.decisionRecords?.length ?? 0);
    if (total > config.onboarding.maxImportEntries) {
      throw new ValidationError(
        `导入条目数 ${total} 超出限制 ${config.onboarding.maxImportEntries}`,
        ErrorCode.VALIDATION_RANGE,
      );
    }
    const ing = getIngestion(tenantId);
    const journal = body.journalEntries
      ? await ing.importJournalEntries(body.journalEntries)
      : { imported: 0, memoryIds: [] as string[] };
    const decisions = body.decisionRecords
      ? await ing.importDecisionRecords(body.decisionRecords)
      : { imported: 0, caseIds: [] as string[] };
    return { data: { journal, decisions } };
  });
}
