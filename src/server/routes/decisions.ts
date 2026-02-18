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
import type { IDatabase } from '../../storage/database.js';
import type { TenantOSFactory } from '../../multi-tenant/tenant-os-factory.js';
import { NotFoundError, QuotaExceededError, ErrorCode } from '../../errors/index.js';
import { generatePrefixedId } from '../../utils/id-generator.js';
import type { DecisionCase } from '../../intelligence/types.js';
import { DecisionEngine } from '../../intelligence/decision-engine.js';
import { RuleEngine } from '../../intelligence/rule-engine.js';
import { EmbeddingIndex } from '../../intelligence/embedding-index.js';
import { RetrievalService } from '../../intelligence/retrieval-service.js';
import { ModelRouter } from '../../intelligence/model-router.js';
import { TokenBudget } from '../../intelligence/token-budget.js';
import { CostTracker } from '../../intelligence/cost-tracker.js';
import { UsageTracker } from '../../billing/usage-tracker.js';
import { QuotaManager } from '../../multi-tenant/quota-manager.js';
import { reportUsage as reportStripeUsage } from '../../billing/stripe-client.js';
import { CreateDecisionSchema, DecisionFeedbackSchema } from '../schemas/api-schemas.js';

interface DecisionCaseRow {
  id: string;
  tenant_id: string;
  title: string;
  description: string;
  alternatives_json: string;
  constraints_json: string | null;
  context_json: string | null;
  created_at: number;
}

interface DecisionRunRow {
  id: string;
  case_id: string;
  tenant_id: string;
  result_json: string;
  created_at: number;
}

export function registerDecisionRoutes(
  app: FastifyInstance,
  os: ChronoSynthOS,
  config: AppConfig,
  db?: IDatabase,
  tenantFactory?: TenantOSFactory,
): void {
  const sharedDb = db ?? os.getDatabase();
  const tokenBudget = new TokenBudget(config.intelligence.budget, sharedDb);
  const costTracker = new CostTracker(sharedDb);
  const usageTracker = new UsageTracker(sharedDb);
  const quotaManager = new QuotaManager(sharedDb);

  function getOS(tenantId: string): ChronoSynthOS {
    if (tenantFactory && tenantId !== 'default') return tenantFactory.getTenantOS(tenantId);
    return os;
  }

  /** 懒加载决策引擎（按租户） */
  const engines = new Map<string, DecisionEngine>();
  function getEngine(tenantId: string): DecisionEngine {
    const cached = engines.get(tenantId);
    if (cached) return cached;

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
    const embeddingIndex = new EmbeddingIndex(tenantOS.getDatabase(), tenantOS.getClock(), llm, config.intelligence.embeddingModel);
    const retrieval = new RetrievalService(tenantOS.core.memories, embeddingIndex);
    const ruleEngine = config.ruleEngine.enabled
      ? new RuleEngine(tenantOS.getClock(), config.ruleEngine, tenantOS.getLogger())
      : undefined;
    const engine = new DecisionEngine(tenantOS.core, retrieval, llm, tenantOS.getClock(), tenantOS.getLogger(), config.intelligence.simulation, ruleEngine);
    engines.set(tenantId, engine);
    return engine;
  }

  /* POST /api/v1/decisions */
  app.post('/api/v1/decisions', async (request) => {
    const body = CreateDecisionSchema.parse(request.body);
    const tenantId = request.tenantId;
    const id = generatePrefixedId('dec');
    const now = Date.now();

    const decisionCase: DecisionCase = {
      id,
      title: body.title,
      description: body.description,
      alternatives: body.alternatives,
      constraints: body.constraints,
      context: body.context,
    };

    sharedDb.prepare<void>(
      `INSERT INTO decision_cases (id, tenant_id, title, description, alternatives_json, constraints_json, context_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, tenantId, body.title, body.description, JSON.stringify(body.alternatives), body.constraints ? JSON.stringify(body.constraints) : null, body.context ? JSON.stringify(body.context) : null, now);

    return { data: decisionCase };
  });

  /* GET /api/v1/decisions */
  app.get('/api/v1/decisions', async (request) => {
    const tenantId = request.tenantId;
    const { page, pageSize } = request.query as { page?: string; pageSize?: string };
    const p = Math.max(1, parseInt(page || '1', 10) || 1);
    const ps = Math.min(100, Math.max(1, parseInt(pageSize || '20', 10) || 20));
    const offset = (p - 1) * ps;

    const total = sharedDb.prepare<{ count: number }>(
      'SELECT COUNT(*) as count FROM decision_cases WHERE tenant_id = ?',
    ).get(tenantId)?.count ?? 0;

    const rows = sharedDb.prepare<DecisionCaseRow>(
      'SELECT * FROM decision_cases WHERE tenant_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?',
    ).all(tenantId, ps, offset);

    return {
      data: rows.map((r) => ({
        id: r.id,
        title: r.title,
        description: r.description,
        alternatives: JSON.parse(r.alternatives_json),
        constraints: r.constraints_json ? JSON.parse(r.constraints_json) : undefined,
        context: r.context_json ? JSON.parse(r.context_json) : undefined,
        createdAt: new Date(r.created_at).toISOString(),
      })),
      pagination: { page: p, pageSize: ps, total, totalPages: Math.ceil(total / ps) },
    };
  });

  /* POST /api/v1/decisions/:id/simulate */
  app.post<{ Params: { id: string } }>('/api/v1/decisions/:id/simulate', async (request) => {
    const { id } = request.params;
    const tenantId = request.tenantId;

    const row = sharedDb.prepare<DecisionCaseRow>(
      'SELECT * FROM decision_cases WHERE id = ? AND tenant_id = ?',
    ).get(id, tenantId);
    if (!row) {
      throw new NotFoundError(`决策 ${id} 不存在`, ErrorCode.NOT_FOUND_DECISION);
    }

    /* 原子性配额检查 + 消费 */
    if (!quotaManager.consumeQuota(tenantId, 'simulation')) {
      throw new QuotaExceededError('模拟次数配额已用尽');
    }

    const decisionCase: DecisionCase = {
      id: row.id,
      title: row.title,
      description: row.description,
      alternatives: JSON.parse(row.alternatives_json),
      constraints: row.constraints_json ? JSON.parse(row.constraints_json) : undefined,
      context: row.context_json ? JSON.parse(row.context_json) : undefined,
    };

    const runId = generatePrefixedId('run');
    os.bus.emit('decision:simulation-progress', { tenantId, caseId: id, runId, progress: 0, stage: 'started' });

    try {
      const result = await getEngine(tenantId).evaluate(decisionCase, {
        onProgress: (p) => os.bus.emit('decision:simulation-progress', { tenantId, caseId: id, runId, ...p }),
      });

      const now = Date.now();
      sharedDb.prepare<void>(
        'INSERT INTO decision_runs (id, case_id, tenant_id, result_json, created_at) VALUES (?, ?, ?, ?, ?)',
      ).run(runId, id, tenantId, JSON.stringify(result), now);

      /* 记录用量（配额已在 consumeQuota 中扣减） */
      usageTracker.record(tenantId, 'simulation', 1);

      /* Stripe 计量上报 */
      if (config.stripe.enabled) {
        const sub = sharedDb.prepare<{ stripe_customer_id: string | null }>(
          'SELECT stripe_customer_id FROM subscriptions WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 1',
        ).get(tenantId);
        if (sub?.stripe_customer_id) {
          reportStripeUsage(config, sub.stripe_customer_id, 'simulation', 1).catch((e) => {
            os.getLogger().warn('Billing', `Stripe 计量上报失败: ${e instanceof Error ? e.message : String(e)}`);
          });
        }
      }

      os.bus.emit('decision:simulation-completed', { tenantId, caseId: id, runId });
      return { data: { runId, result } };
    } catch (err) {
      os.bus.emit('decision:simulation-failed', {
        tenantId, caseId: id, runId,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  });

  /* GET /api/v1/decisions/:id/runs/:runId */
  app.get<{ Params: { id: string; runId: string } }>('/api/v1/decisions/:id/runs/:runId', async (request) => {
    const { id, runId } = request.params;
    const tenantId = request.tenantId;

    const row = sharedDb.prepare<DecisionRunRow>(
      'SELECT * FROM decision_runs WHERE id = ? AND case_id = ? AND tenant_id = ?',
    ).get(runId, id, tenantId);
    if (!row) {
      throw new NotFoundError(`决策运行 ${runId} 不存在`, ErrorCode.NOT_FOUND_DECISION_RUN);
    }
    return { data: { runId, result: JSON.parse(row.result_json) } };
  });

  /* POST /api/v1/decisions/:id/feedback */
  app.post<{ Params: { id: string } }>('/api/v1/decisions/:id/feedback', async (request) => {
    const { id } = request.params;
    const tenantId = request.tenantId;
    const body = DecisionFeedbackSchema.parse(request.body);

    const row = sharedDb.prepare<DecisionRunRow>(
      'SELECT * FROM decision_runs WHERE id = ? AND case_id = ? AND tenant_id = ?',
    ).get(body.runId, id, tenantId);
    if (!row) {
      throw new NotFoundError(`决策运行 ${body.runId} 不存在`, ErrorCode.NOT_FOUND_DECISION_RUN);
    }

    const feedbackId = generatePrefixedId('fb');
    sharedDb.prepare<void>(
      `INSERT INTO decision_feedbacks (id, run_id, tenant_id, selected_alternative, satisfaction, notes, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(feedbackId, body.runId, tenantId, body.selectedAlternative, body.satisfaction, body.notes ?? null, Date.now());

    return { data: { runId: body.runId, stored: true } };
  });
}
