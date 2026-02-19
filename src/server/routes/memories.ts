/**
 * 记忆管理路由
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ChronoSynthOS } from '../../chrono-synth-os.js';
import type { TenantOSFactory } from '../../multi-tenant/tenant-os-factory.js';
import type { AppConfig } from '../../config/schema.js';
import { EmbeddingIndex } from '../../intelligence/embedding-index.js';
import { ModelRouter } from '../../intelligence/model-router.js';
import { TokenBudget } from '../../intelligence/token-budget.js';
import { CostTracker } from '../../intelligence/cost-tracker.js';
import { QuotaManager } from '../../multi-tenant/quota-manager.js';
import { UsageTracker } from '../../billing/usage-tracker.js';
import { CreateMemorySchema, LinkMemorySchema, RelatedMemoryQuerySchema } from '../schemas/api-schemas.js';
import { NotFoundError, ErrorCode } from '../../errors/index.js';
import { parsePagination } from '../plugins/pagination.js';

export function registerMemoryRoutes(app: FastifyInstance, os: ChronoSynthOS, tenantFactory?: TenantOSFactory, config?: AppConfig): void {
  const sharedDb = os.getDatabase();
  const tokenBudget = config ? new TokenBudget(config.intelligence.budget, sharedDb) : undefined;
  const costTracker = config ? new CostTracker(sharedDb) : undefined;
  const quotaManager = config ? new QuotaManager(sharedDb) : undefined;
  const usageTracker = config ? new UsageTracker(sharedDb) : undefined;

  function getOS(request: FastifyRequest): ChronoSynthOS {
    const tid = request.tenantId;
    if (tenantFactory && tid && tid !== 'default') return tenantFactory.getTenantOS(tid);
    return os;
  }

  /** 获取或创建租户的 EmbeddingIndex（懒加载，LRU 驱逐上限 64） */
  const MAX_EMBEDDING_CACHE = 64;
  const embeddingIndexes = new Map<string, EmbeddingIndex>();
  function getEmbeddingIndex(tenantOS: ChronoSynthOS, tenantId: string): EmbeddingIndex | undefined {
    if (!config?.intelligence.apiKey) return undefined;
    const cached = embeddingIndexes.get(tenantId);
    if (cached) {
      embeddingIndexes.delete(tenantId);
      embeddingIndexes.set(tenantId, cached);
      return cached;
    }
    const stripeCustomerId = config?.stripe.enabled
      ? sharedDb.prepare<{ stripe_customer_id: string | null }>(
          'SELECT stripe_customer_id FROM subscriptions WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 1',
        ).get(tenantId)?.stripe_customer_id ?? undefined
      : undefined;
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
      quotaManager,
      usageTracker,
      tenantId,
      stripeConfig: config,
      stripeCustomerId,
    });
    const idx = new EmbeddingIndex(tenantOS.getDatabase(), tenantOS.getClock(), llm, config.intelligence.embeddingModel);
    if (embeddingIndexes.size >= MAX_EMBEDDING_CACHE) {
      const oldest = embeddingIndexes.keys().next().value;
      if (oldest) embeddingIndexes.delete(oldest);
    }
    embeddingIndexes.set(tenantId, idx);
    return idx;
  }

  /* POST /api/v1/memories — 创建记忆，限流: 30 次/分钟 */
  app.post('/api/v1/memories', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request, reply) => {
    const body = CreateMemorySchema.parse(request.body);
    const tenantOS = getOS(request);
    const memory = tenantOS.core.addMemory(body.kind, body.content, body.valence, body.salience);

    /* 异步触发嵌入索引（不阻塞响应） */
    const idx = getEmbeddingIndex(tenantOS, request.tenantId);
    if (idx) {
      idx.indexMemory(memory.id, body.content).catch((err) => {
        app.log.warn({ err, memoryId: memory.id }, '嵌入索引失败');
      });
    }

    return reply.status(201).send({ data: memory });
  });

  /* GET /api/v1/memories — 获取所有记忆（SQL 级分页） */
  app.get('/api/v1/memories', async (request) => {
    const query = request.query as Record<string, unknown>;
    const tenantOS = getOS(request);
    const params = parsePagination(query);
    const offset = (params.page - 1) * params.pageSize;
    const { nodes, total } = tenantOS.core.memories.getMemoriesPaginated(params.pageSize, offset);
    return {
      data: nodes,
      pagination: { page: params.page, pageSize: params.pageSize, total, totalPages: Math.ceil(total / params.pageSize) || 1 },
    };
  });

  /* POST /api/v1/memories/link — 关联记忆 */
  app.post('/api/v1/memories/link', async (request, reply) => {
    const body = LinkMemorySchema.parse(request.body);
    const tenantOS = getOS(request);
    if (!tenantOS.core.memories.getMemory(body.source)) {
      throw new NotFoundError(`记忆节点 ${body.source} 不存在`, ErrorCode.NOT_FOUND_MEMORY);
    }
    if (!tenantOS.core.memories.getMemory(body.target)) {
      throw new NotFoundError(`记忆节点 ${body.target} 不存在`, ErrorCode.NOT_FOUND_MEMORY);
    }
    const edge = tenantOS.core.linkMemories(body.source, body.target, body.relation, body.strength);
    return reply.status(201).send({ data: edge });
  });

  /* POST /api/v1/memories/decay — 触发全量衰减 */
  app.post('/api/v1/memories/decay', async (request) => {
    const tenantOS = getOS(request);
    const decayed = tenantOS.core.runMemoryDecay();
    return { data: { decayed, count: decayed.length } };
  });

  /* POST /api/v1/memories/consolidate — 触发记忆固化 */
  app.post('/api/v1/memories/consolidate', async (request) => {
    const tenantOS = getOS(request);
    const consolidated = tenantOS.core.runConsolidation();
    return { data: { consolidated, count: consolidated.length } };
  });

  /* GET /api/v1/memories/working-set — 获取工作记忆 */
  app.get('/api/v1/memories/working-set', async (request) => {
    const tenantOS = getOS(request);
    const slots = tenantOS.core.getWorkingMemory();
    return { data: slots };
  });

  /* GET /api/v1/memories/:id/related — 获取相关记忆 */
  app.get<{ Params: { id: string } }>('/api/v1/memories/:id/related', async (request) => {
    const { id } = request.params;
    const query = request.query as Record<string, unknown>;
    const { depth } = RelatedMemoryQuerySchema.parse(query);
    const tenantOS = getOS(request);

    if (!tenantOS.core.memories.getMemory(id)) {
      throw new NotFoundError(`记忆节点 ${id} 不存在`, ErrorCode.NOT_FOUND_MEMORY);
    }

    const related = tenantOS.core.memories.getRelatedMemories(id, depth);
    return { data: related };
  });

  /* POST /api/v1/memories/:id/activate — 触发扩散激活 */
  app.post<{ Params: { id: string } }>('/api/v1/memories/:id/activate', async (request) => {
    const { id } = request.params;
    const tenantOS = getOS(request);

    if (!tenantOS.core.memories.getMemory(id)) {
      throw new NotFoundError(`记忆节点 ${id} 不存在`, ErrorCode.NOT_FOUND_MEMORY);
    }

    const results = tenantOS.core.activateMemory(id);
    return { data: { activations: results, count: results.length } };
  });
}
