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
import { NotFoundError, ValidationError, ErrorCode } from '../../errors/index.js';
import { OnboardingService } from '../../onboarding/onboarding-service.js';
import { QuestionnaireEngine } from '../../onboarding/questionnaire-engine.js';
import { DataIngestion } from '../../onboarding/data-ingestion.js';
import { DecisionEngine } from '../../intelligence/decision-engine.js';
import { RuleEngine } from '../../intelligence/rule-engine.js';
import { EmbeddingIndex } from '../../intelligence/embedding-index.js';
import { RetrievalService } from '../../intelligence/retrieval-service.js';
import { ModelRouter } from '../../intelligence/model-router.js';
import {
  OnboardingStep1Schema,
  OnboardingStep2Schema,
  OnboardingStep3Schema,
  OnboardingQuestionnaireSchema,
  OnboardingImportSchema,
} from '../schemas/api-schemas.js';

export function registerOnboardingRoutes(app: FastifyInstance, os: ChronoSynthOS, config: AppConfig): void {
  let engine: DecisionEngine | undefined;
  let embeddingIndex: EmbeddingIndex | undefined;
  let onboarding: OnboardingService | undefined;
  let ingestion: DataIngestion | undefined;
  const questionnaire = new QuestionnaireEngine();

  function getEngine(): DecisionEngine {
    if (engine) return engine;
    const llm = new ModelRouter({
      provider: config.intelligence.provider,
      model: config.intelligence.model,
      embeddingModel: config.intelligence.embeddingModel,
      apiKey: config.intelligence.apiKey,
      baseUrl: config.intelligence.baseUrl,
      maxTokens: config.intelligence.maxTokens,
      temperature: config.intelligence.temperature,
    });
    embeddingIndex = new EmbeddingIndex(os.getDatabase(), os.getClock(), llm, config.intelligence.embeddingModel);
    const retrieval = new RetrievalService(os.core.memories, embeddingIndex);
    const ruleEngine = config.ruleEngine.enabled
      ? new RuleEngine(os.getClock(), config.ruleEngine, os.getLogger())
      : undefined;
    engine = new DecisionEngine(os.core, retrieval, llm, os.getClock(), os.getLogger(), config.intelligence.simulation, ruleEngine);
    return engine;
  }

  function getOnboarding(): OnboardingService {
    if (onboarding) return onboarding;
    onboarding = new OnboardingService(
      os.core,
      getEngine(),
      os.bus,
      os.getClock(),
      os.getLogger(),
      (reason) => os.createSnapshot(reason),
    );
    return onboarding;
  }

  function getIngestion(): DataIngestion {
    if (ingestion) return ingestion;
    if (!embeddingIndex) getEngine();
    ingestion = new DataIngestion(os.core, embeddingIndex!);
    return ingestion;
  }

  /* POST /api/v1/onboarding/start */
  app.post('/api/v1/onboarding/start', async () => {
    const session = getOnboarding().createSession();
    return { data: session };
  });

  /* GET /api/v1/onboarding/status/:sessionId */
  app.get<{ Params: { sessionId: string } }>('/api/v1/onboarding/status/:sessionId', async (request) => {
    const session = getOnboarding().getSession(request.params.sessionId);
    if (!session) {
      throw new NotFoundError(`引导会话 ${request.params.sessionId} 不存在`, ErrorCode.NOT_FOUND_ONBOARDING);
    }
    return { data: session };
  });

  /* POST /api/v1/onboarding/step/:step */
  app.post<{ Params: { step: string }; Querystring: { sessionId?: string } }>('/api/v1/onboarding/step/:step', async (request) => {
    const step = Number.parseInt(request.params.step, 10);
    const query = request.query as Record<string, string>;
    const sessionId = query.sessionId;
    if (!sessionId) {
      throw new ValidationError('缺少 sessionId 查询参数', ErrorCode.VALIDATION_REQUIRED);
    }

    let data: Record<string, unknown> = {};
    if (step === 1) data = OnboardingStep1Schema.parse(request.body);
    else if (step === 2) data = OnboardingStep2Schema.parse(request.body);
    else if (step === 3) data = OnboardingStep3Schema.parse(request.body);
    /* Step 4 和 5 不需要请求体 */

    const session = await getOnboarding().submitStep(sessionId, step, data);
    return { data: session };
  });

  /* POST /api/v1/onboarding/questionnaire */
  app.post('/api/v1/onboarding/questionnaire', async (request) => {
    const body = OnboardingQuestionnaireSchema.parse(request.body);
    const result = questionnaire.evaluate(body.responses);
    if (Object.keys(result.decisionStyle).length > 0) {
      os.core.setDecisionStyle(result.decisionStyle);
    }
    if (Object.keys(result.cognitiveModel).length > 0) {
      os.core.setCognitiveModel(result.cognitiveModel);
    }
    return { data: result };
  });

  /* POST /api/v1/onboarding/import */
  app.post('/api/v1/onboarding/import', async (request) => {
    const body = OnboardingImportSchema.parse(request.body);
    const total = (body.journalEntries?.length ?? 0) + (body.decisionRecords?.length ?? 0);
    if (total > config.onboarding.maxImportEntries) {
      throw new ValidationError(
        `导入条目数 ${total} 超出限制 ${config.onboarding.maxImportEntries}`,
        ErrorCode.VALIDATION_RANGE,
      );
    }
    const ing = getIngestion();
    const journal = body.journalEntries
      ? await ing.importJournalEntries(body.journalEntries)
      : { imported: 0, memoryIds: [] as string[] };
    const decisions = body.decisionRecords
      ? await ing.importDecisionRecords(body.decisionRecords)
      : { imported: 0, caseIds: [] as string[] };
    return { data: { journal, decisions } };
  });
}
