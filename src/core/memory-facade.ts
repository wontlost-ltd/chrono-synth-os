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
import { FieldEncryption } from '../storage/encryption.js';
import { EmbeddingIndex } from '../intelligence/embedding-index.js';
import { ModelRouter } from '../intelligence/model-router.js';
import { TokenBudget } from '../intelligence/token-budget.js';
import { CostTracker } from '../intelligence/cost-tracker.js';
import { QuotaManager } from '../multi-tenant/quota-manager.js';
import { BillingOutbox } from '../billing/billing-outbox.js';
import { UsageTracker } from '../billing/usage-tracker.js';
import { PersonaCoreService } from '../persona-core/persona-core-service.js';
import { NotFoundError, ErrorCode } from '../errors/index.js';

/** persona 记忆创建结果 */
export interface PersonaMemoryResult {
  memoryId: string;
  personaId: string;
  memoryType: string;
  createdAt: string;
}

/** 记忆列表分页结果 */
export interface MemoryListResult {
  data: MemoryNode[];
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
    const encryption = config?.encryption.enabled ? new FieldEncryption(config.encryption) : undefined;
    this.personaCoreService = new PersonaCoreService(this.sharedDb, encryption);
    this.tokenBudget = config ? new TokenBudget(config.intelligence.budget, this.sharedDb) : undefined;
    this.costTracker = config ? new CostTracker(this.sharedDb) : undefined;
    this.quotaManager = config ? new QuotaManager(this.sharedDb) : undefined;
    this.usageTracker = config ? new UsageTracker(this.sharedDb) : undefined;
    this.billingOutbox = config ? new BillingOutbox(this.sharedDb, config) : undefined;
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
    const idx = new EmbeddingIndex(tenantOS.getDatabase(), tenantOS.getClock(), llm, this.config.intelligence.embeddingModel);
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
  ): { memory: MemoryNode; indexPromise?: Promise<boolean> } {
    const tenantOS = this.getOS(tenantId);
    const memory = tenantOS.core.addMemory(kind, content, valence, salience);
    const idx = this.getEmbeddingIndex(tenantOS, tenantId);
    const indexPromise = idx ? idx.indexMemory(memory.id, content) : undefined;
    return { memory, indexPromise };
  }

  listMemories(tenantId: string, page: number, pageSize: number): MemoryListResult {
    const tenantOS = this.getOS(tenantId);
    const offset = (page - 1) * pageSize;
    const { nodes, total } = tenantOS.core.memories.getMemoriesPaginated(pageSize, offset);
    return {
      data: nodes,
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
