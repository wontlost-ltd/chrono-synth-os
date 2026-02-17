/**
 * 决策模拟路由
 * POST /api/v1/decisions — 创建决策案例
 * POST /api/v1/decisions/:id/simulate — 运行蒙特卡洛模拟
 * GET /api/v1/decisions/:id/runs/:runId — 获取模拟结果
 * POST /api/v1/decisions/:id/feedback — 用户反馈校准
 */

import type { FastifyInstance } from 'fastify';
import type { ChronoSynthOS } from '../../chrono-synth-os.js';
import type { AppConfig } from '../../config/schema.js';
import { NotFoundError, ErrorCode } from '../../errors/index.js';
import { generatePrefixedId } from '../../utils/id-generator.js';
import type { DecisionCase, DecisionResult } from '../../intelligence/types.js';
import { DecisionEngine } from '../../intelligence/decision-engine.js';
import { EmbeddingIndex } from '../../intelligence/embedding-index.js';
import { RetrievalService } from '../../intelligence/retrieval-service.js';
import { ModelRouter } from '../../intelligence/model-router.js';
import { CreateDecisionSchema, DecisionFeedbackSchema } from '../schemas/api-schemas.js';

interface RunRecord {
  readonly caseId: string;
  readonly result: DecisionResult;
  readonly createdAt: number;
}

export function registerDecisionRoutes(app: FastifyInstance, os: ChronoSynthOS, config: AppConfig): void {
  const cases = new Map<string, DecisionCase>();
  const runs = new Map<string, RunRecord>();
  const feedbacks = new Map<string, { runId: string; selectedAlternative: string; satisfaction: number; notes?: string }>();

  /** 懒加载决策引擎 */
  let engine: DecisionEngine | undefined;
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
    const embeddingIndex = new EmbeddingIndex(os.getDatabase(), os.getClock(), llm, config.intelligence.embeddingModel);
    const retrieval = new RetrievalService(os.core.memories, embeddingIndex);
    engine = new DecisionEngine(os.core, retrieval, llm, os.getClock(), os.getLogger(), config.intelligence.simulation);
    return engine;
  }

  /* POST /api/v1/decisions */
  app.post('/api/v1/decisions', async (request) => {
    const body = CreateDecisionSchema.parse(request.body);
    const id = generatePrefixedId('dec');
    const decisionCase: DecisionCase = {
      id,
      title: body.title,
      description: body.description,
      alternatives: body.alternatives,
      constraints: body.constraints,
      context: body.context,
    };
    cases.set(id, decisionCase);
    return { data: decisionCase };
  });

  /* POST /api/v1/decisions/:id/simulate */
  app.post<{ Params: { id: string } }>('/api/v1/decisions/:id/simulate', async (request) => {
    const { id } = request.params;
    const decisionCase = cases.get(id);
    if (!decisionCase) {
      throw new NotFoundError(`决策 ${id} 不存在`, ErrorCode.NOT_FOUND_DECISION);
    }

    const runId = generatePrefixedId('run');
    os.bus.emit('decision:simulation-progress', { caseId: id, runId, progress: 0, stage: 'started' });

    try {
      const result = await getEngine().evaluate(decisionCase, {
        onProgress: (p) => os.bus.emit('decision:simulation-progress', { caseId: id, runId, ...p }),
      });
      runs.set(runId, { caseId: id, result, createdAt: os.getClock().now() });
      os.bus.emit('decision:simulation-completed', { caseId: id, runId });
      return { data: { runId, result } };
    } catch (err) {
      os.bus.emit('decision:simulation-failed', {
        caseId: id, runId,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  });

  /* GET /api/v1/decisions/:id/runs/:runId */
  app.get<{ Params: { id: string; runId: string } }>('/api/v1/decisions/:id/runs/:runId', async (request) => {
    const { id, runId } = request.params;
    const record = runs.get(runId);
    if (!record || record.caseId !== id) {
      throw new NotFoundError(`决策运行 ${runId} 不存在`, ErrorCode.NOT_FOUND_DECISION_RUN);
    }
    return { data: { runId, result: record.result } };
  });

  /* POST /api/v1/decisions/:id/feedback */
  app.post<{ Params: { id: string } }>('/api/v1/decisions/:id/feedback', async (request) => {
    const { id } = request.params;
    const body = DecisionFeedbackSchema.parse(request.body);
    const record = runs.get(body.runId);
    if (!record || record.caseId !== id) {
      throw new NotFoundError(`决策运行 ${body.runId} 不存在`, ErrorCode.NOT_FOUND_DECISION_RUN);
    }
    feedbacks.set(body.runId, {
      runId: body.runId,
      selectedAlternative: body.selectedAlternative,
      satisfaction: body.satisfaction,
      notes: body.notes,
    });
    return { data: { runId: body.runId, stored: true } };
  });
}
