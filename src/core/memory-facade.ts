/**
 * 记忆管理 Application Façade
 * 封装记忆路由的业务逻辑：记忆 CRUD、嵌入索引、衰减、固化、扩散激活
 */

import type { ChronoSynthOS } from '../chrono-synth-os.js';
import type { TenantOSFactory } from '../multi-tenant/tenant-os-factory.js';
import type { AppConfig } from '../config/schema.js';
import type { IDatabase } from '../storage/database.js';
import type { MemoryNode, MemoryEdge, MemoryKind, ActivationResult, ConsolidationResult, EvictionResult, WorkingMemorySlot } from '../types/core-self.js';
import type { PersonaMemorySensitivity } from '../persona-core/types.js';
import type { MemorySourceKind } from '../server/schemas/api-schemas.js';
import { FieldEncryption } from '../storage/encryption.js';
import type { EmbeddingIndex } from '../intelligence/embedding-index.js';
import { createEmbeddingIndex } from '../intelligence/embedding-index-factory.js';
import { ModelRouter } from '../intelligence/model-router.js';
import { TokenBudget } from '../intelligence/token-budget.js';
import { CostTracker } from '../intelligence/cost-tracker.js';
import { QuotaManager } from '../multi-tenant/quota-manager.js';
import { BillingOutbox } from '../billing/billing-outbox.js';
import { UsageTracker } from '../billing/usage-tracker.js';
import { PersonaCoreService } from '../persona-core/persona-core-service.js';
import { NotFoundError, ErrorCode } from '../errors/index.js';

const CONFIDENCE_BY_SOURCE: Record<string, number> = {
  user_input: 0.95,
  api_sync: 0.70,
  system_inferred: 0.60,
  unknown: 0.30,
};

/** persona 记忆创建结果 */
export interface PersonaMemoryResult {
  memoryId: string;
  personaId: string;
  memoryType: string;
  createdAt: string;
}

export interface MemoryNodeWithConfidence extends MemoryNode {
  confidenceScore: number;
  sourceKind: MemorySourceKind;
  unverified: boolean;
}

/** 记忆列表分页结果 */
export interface MemoryListResult {
  data: MemoryNodeWithConfidence[];
  pagination: { page: number; pageSize: number; total: number; totalPages: number };
}

/** 衰减结果 */
export interface DecayResult {
  decayed: Array<{ memoryId: string; oldSalience: number; newSalience: number }>;
  evicted: EvictionResult[];
  decayedCount: number;
  evictedCount: number;
}

/** 激活结果 */
export interface ActivationResponse {
  activations: ActivationResult[];
  count: number;
}

function mapMemoryRecordKind(memoryType: string, sourceType?: string): 'interaction' | 'task' | 'training' | 'knowledge' | 'governance' {
  const normalized = `${memoryType} ${sourceType ?? ''}`.toLowerCase();
  if (normalized.includes('task')) return 'task';
  if (normalized.includes('train')) return 'training';
  if (normalized.includes('knowledge')) return 'knowledge';
  if (normalized.includes('governance') || normalized.includes('policy')) return 'governance';
  return 'interaction';
}

const MAX_EMBEDDING_CACHE = 64;

export class MemoryFacade {
  private readonly sharedDb: IDatabase;
  private readonly personaCoreService: PersonaCoreService;
  private readonly tokenBudget: TokenBudget | undefined;
  private readonly costTracker: CostTracker | undefined;
  private readonly quotaManager: QuotaManager | undefined;
  private readonly usageTracker: UsageTracker | undefined;
  private readonly billingOutbox: BillingOutbox | undefined;
  private readonly embeddingIndexes = new Map<string, EmbeddingIndex>();

  constructor(
    private readonly os: ChronoSynthOS,
    private readonly tenantFactory: TenantOSFactory | undefined,
    private readonly config: AppConfig | undefined,
  ) {
    this.sharedDb = os.getDatabase();
    const sharedTx = this.sharedDb;
    const encryption = config?.encryption.enabled ? new FieldEncryption(config.encryption) : undefined;
    this.personaCoreService = new PersonaCoreService(sharedTx, encryption);
    this.tokenBudget = config ? new TokenBudget(config.intelligence.budget, this.sharedDb) : undefined;
    this.costTracker = config ? new CostTracker(this.sharedDb) : undefined;
    this.quotaManager = config ? new QuotaManager(sharedTx) : undefined;
    this.usageTracker = config ? new UsageTracker(sharedTx) : undefined;
    this.billingOutbox = config ? new BillingOutbox(sharedTx, config) : undefined;
  }

  private getOS(tenantId: string): ChronoSynthOS {
    if (this.tenantFactory && tenantId && tenantId !== 'default') return this.tenantFactory.getTenantOS(tenantId);
    return this.os;
  }

  private getEmbeddingIndex(tenantOS: ChronoSynthOS, tenantId: string): EmbeddingIndex | undefined {
    if (!this.config?.intelligence.apiKey) return undefined;
    const cached = this.embeddingIndexes.get(tenantId);
    if (cached) {
      this.embeddingIndexes.delete(tenantId);
      this.embeddingIndexes.set(tenantId, cached);
      return cached;
    }
    const stripeCustomerId = this.config?.stripe.enabled
      ? this.sharedDb.prepare<{ stripe_customer_id: string | null }>(
          'SELECT stripe_customer_id FROM subscriptions WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 1',
        ).get(tenantId)?.stripe_customer_id ?? undefined
      : undefined;
    const llm = new ModelRouter({
      provider: this.config.intelligence.provider,
      model: this.config.intelligence.model,
      embeddingModel: this.config.intelligence.embeddingModel,
      apiKey: this.config.intelligence.apiKey,
      baseUrl: this.config.intelligence.baseUrl,
      maxTokens: this.config.intelligence.maxTokens,
      temperature: this.config.intelligence.temperature,
      tokenBudget: this.tokenBudget,
      costTracker: this.costTracker,
      quotaManager: this.quotaManager,
      usageTracker: this.usageTracker,
      tenantId,
      stripeConfig: this.config,
      stripeCustomerId,
      billingOutbox: this.billingOutbox ?? undefined,
    });
    const idx = createEmbeddingIndex({
      tenantId,
      db: tenantOS.getDatabase(),
      clock: tenantOS.getClock(),
      llm,
      config: this.config,
    });
    if (this.embeddingIndexes.size >= MAX_EMBEDDING_CACHE) {
      const oldest = this.embeddingIndexes.keys().next().value;
      if (oldest) this.embeddingIndexes.delete(oldest);
    }
    this.embeddingIndexes.set(tenantId, idx);
    return idx;
  }

  /**
   * 创建 persona 记忆记录
   * @throws NotFoundError 如果 persona 不存在
   */
  createPersonaMemory(
    tenantId: string,
    ownerUserId: string,
    input: {
      personaId: string;
      memoryType: string;
      contentText: string;
      sourceType?: string;
      sourceId?: string;
      sensitivity?: PersonaMemorySensitivity;
    },
  ): PersonaMemoryResult {
    const memory = this.personaCoreService.addMemory({
      tenantId,
      ownerUserId,
      personaId: input.personaId,
      kind: mapMemoryRecordKind(input.memoryType, input.sourceType),
      sensitivity: input.sensitivity,
      summary: input.contentText,
      content: {
        memoryType: input.memoryType,
        sourceType: input.sourceType ?? null,
        sourceId: input.sourceId ?? null,
      },
      importance: 0.6,
    });
    if (!memory) {
      throw new NotFoundError(`Persona ${input.personaId} 不存在`, ErrorCode.NOT_FOUND_PERSONA);
    }
    return {
      memoryId: memory.id,
      personaId: memory.personaId,
      memoryType: input.memoryType,
      createdAt: new Date(memory.createdAt).toISOString(),
    };
  }

  /**
   * 创建核心记忆（非 persona）
   * @returns 创建的记忆节点，以及可选的嵌入索引 Promise（调用方可选择是否 await/catch）
   */
  createCoreMemory(
    tenantId: string,
    kind: MemoryKind,
    content: string,
    valence: number,
    salience: number,
    sourceKind: MemorySourceKind = 'unknown',
  ): { memory: MemoryNode; indexPromise?: Promise<boolean> } {
    const tenantOS = this.getOS(tenantId);
    const memory = tenantOS.core.addMemory(kind, content, valence, salience);
    const idx = this.getEmbeddingIndex(tenantOS, tenantId);
    const indexPromise = idx ? idx.indexMemory(memory.id, content) : undefined;

    // 写入置信度元数据（列由 v060 迁移新增，旧实例中可能不存在则静默失败）
    // 使用 sharedDb（非租户隔离包装）直接按 id 更新，避免 TenantDatabase 重写 WHERE 条件干扰
    const confidenceScore = CONFIDENCE_BY_SOURCE[sourceKind] ?? 0.3;
    const unverified = confidenceScore < 0.8 ? 1 : 0;
    try {
      this.sharedDb.prepare<void>(
        `UPDATE memory_nodes
            SET confidence_score = ?, source_kind = ?, unverified = ?
          WHERE id = ?`,
      ).run(confidenceScore, sourceKind, unverified, memory.id);
    } catch {
      // 列尚未存在（旧迁移未运行）时静默跳过
    }

    return { memory, indexPromise };
  }

  listMemories(tenantId: string, page: number, pageSize: number): MemoryListResult {
    const tenantOS = this.getOS(tenantId);
    const offset = (page - 1) * pageSize;
    const { nodes, total } = tenantOS.core.memories.getMemoriesPaginated(pageSize, offset);

    // 追加 confidence 字段（batch IN 查询，单次往返）
    let confMap = new Map<string, { confidence_score: number; source_kind: string; unverified: number }>();
    if (nodes.length > 0) {
      const placeholders = nodes.map(() => '?').join(', ');
      try {
        // 使用 sharedDb 直接按 id 查询（ids 已由 getMemoriesPaginated 租户过滤），避免 TenantDatabase 重写 WHERE 引发误匹配
        const confRows = this.sharedDb.prepare<{
          id: string;
          confidence_score: number;
          source_kind: string;
          unverified: number;
        }>(`SELECT id, confidence_score, source_kind, unverified FROM memory_nodes WHERE id IN (${placeholders})`).all(...nodes.map((n) => n.id));
        confMap = new Map(confRows.map((r) => [r.id, r]));
      } catch {
        // 列尚未存在（旧迁移未运行）时静默跳过，使用默认值
      }
    }

    const data: MemoryNodeWithConfidence[] = nodes.map((n) => {
      const conf = confMap.get(n.id);
      return {
        ...n,
        confidenceScore: conf?.confidence_score ?? 0.3,
        sourceKind: (conf?.source_kind ?? 'unknown') as MemorySourceKind,
        unverified: conf ? conf.unverified === 1 : true,
      };
    });

    return {
      data,
      pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) || 1 },
    };
  }

  linkMemories(tenantId: string, source: string, target: string, relation: string, strength: number): MemoryEdge {
    const tenantOS = this.getOS(tenantId);
    if (!tenantOS.core.memories.getMemory(source)) {
      throw new NotFoundError(`记忆节点 ${source} 不存在`, ErrorCode.NOT_FOUND_MEMORY);
    }
    if (!tenantOS.core.memories.getMemory(target)) {
      throw new NotFoundError(`记忆节点 ${target} 不存在`, ErrorCode.NOT_FOUND_MEMORY);
    }
    return tenantOS.core.linkMemories(source, target, relation, strength);
  }

  runDecay(tenantId: string): DecayResult {
    const tenantOS = this.getOS(tenantId);
    const { decayed, evicted } = tenantOS.core.runMemoryDecay();
    return { decayed, evicted, decayedCount: decayed.length, evictedCount: evicted.length };
  }

  runConsolidation(tenantId: string): { consolidated: ConsolidationResult[]; count: number } {
    const tenantOS = this.getOS(tenantId);
    const consolidated = tenantOS.core.runConsolidation();
    return { consolidated, count: consolidated.length };
  }

  getWorkingMemory(tenantId: string): WorkingMemorySlot[] {
    const tenantOS = this.getOS(tenantId);
    return tenantOS.core.getWorkingMemory();
  }

  getRelatedMemories(tenantId: string, memoryId: string, depth: number): MemoryNode[] {
    const tenantOS = this.getOS(tenantId);
    if (!tenantOS.core.memories.getMemory(memoryId)) {
      throw new NotFoundError(`记忆节点 ${memoryId} 不存在`, ErrorCode.NOT_FOUND_MEMORY);
    }
    return tenantOS.core.memories.getRelatedMemories(memoryId, depth);
  }

  activateMemory(tenantId: string, memoryId: string): ActivationResponse {
    const tenantOS = this.getOS(tenantId);
    if (!tenantOS.core.memories.getMemory(memoryId)) {
      throw new NotFoundError(`记忆节点 ${memoryId} 不存在`, ErrorCode.NOT_FOUND_MEMORY);
    }
    const results = tenantOS.core.activateMemory(memoryId);
    return { activations: results, count: results.length };
  }
}
