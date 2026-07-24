/**
 * 知识源 Application Service
 * 封装知识源的业务逻辑，路由层只做请求解析和响应序列化
 *
 * 分片 Phase 0 · Plan 1b（Task 5）：
 * - knowledge_sources 表**有 tenant_id 列**，故租户约束直接在 query/executor 层 `WHERE tenant_id=? AND id=?`
 *   （本 Task 前 executor 已含：byId/list/count/create/update/delete 全带 tenant predicate）。
 * - public 方法**已普遍带 tenantId**（list/getById/create/update/sync/delete），本 Task 仅
 *   ctor `(tx)`→`(resolver)` + 每方法经 `storeFor(tenantId)`（dbForTenant 选对 shard 现造 store，不缓存）。
 * - 双重约束：`dbForTenant(tenantId)` 选对 shard + SQL tenant predicate 防同库跨租户读改删。
 * - KnowledgeSourceStore 是薄数据访问层（已 tenantId-aware），照 collaboration 直取模式，不抽额外 writer seam。
 */

import type { SyncWriteUnitOfWork } from '@chrono/kernel';
import type { TenantDbResolver } from '../storage/tenant-db-resolver.js';
import type { KnowledgeSourceRecord, KnowledgeSourceType } from '../types/avatar-autorun.js';
import { KnowledgeSourceStore } from '../storage/knowledge-source-store.js';
import { NotFoundError, ErrorCode } from '../errors/index.js';

export interface CreateKnowledgeSourceInput {
  readonly type: KnowledgeSourceType;
  readonly name: string;
  readonly config: Record<string, unknown>;
}

export interface UpdateKnowledgeSourceInput {
  readonly name?: string;
  readonly type?: KnowledgeSourceType;
  readonly config?: Record<string, unknown>;
  readonly enabled?: boolean;
}

export interface PaginatedResult<T> {
  readonly data: readonly T[];
  readonly pagination: {
    readonly page: number;
    readonly pageSize: number;
    readonly total: number;
    readonly totalPages: number;
  };
}

export class KnowledgeSourceService {
  constructor(private readonly resolver: TenantDbResolver) {}

  /** 每 tenant-scoped 调用现取该租户 shard 的 tx 并造 store（dbForTenant 选 shard），不跨请求缓存。 */
  private storeFor(tenantId: string): KnowledgeSourceStore {
    const tx: SyncWriteUnitOfWork = this.resolver.dbForTenant(tenantId);
    return new KnowledgeSourceStore(tx);
  }

  list(tenantId: string, page: number, pageSize: number): PaginatedResult<KnowledgeSourceRecord> {
    const offset = (page - 1) * pageSize;
    const { sources, total } = this.storeFor(tenantId).listByTenant(tenantId, pageSize, offset);
    return {
      data: sources,
      pagination: {
        page,
        pageSize,
        total,
        totalPages: Math.ceil(total / pageSize) || 1,
      },
    };
  }

  getById(tenantId: string, sourceId: string): KnowledgeSourceRecord {
    const source = this.storeFor(tenantId).getById(sourceId, tenantId);
    if (!source) throw new NotFoundError(`知识源 ${sourceId} 不存在`, ErrorCode.NOT_FOUND_KNOWLEDGE_SOURCE);
    return source;
  }

  create(tenantId: string, input: CreateKnowledgeSourceInput): KnowledgeSourceRecord {
    return this.storeFor(tenantId).create(tenantId, {
      type: input.type,
      name: input.name,
      configJson: JSON.stringify(input.config),
    });
  }

  update(tenantId: string, sourceId: string, input: UpdateKnowledgeSourceInput): KnowledgeSourceRecord {
    const updated = this.storeFor(tenantId).update(sourceId, tenantId, {
      name: input.name,
      type: input.type,
      configJson: input.config ? JSON.stringify(input.config) : undefined,
      enabled: input.enabled,
    });
    if (!updated) throw new NotFoundError(`知识源 ${sourceId} 不存在`, ErrorCode.NOT_FOUND_KNOWLEDGE_SOURCE);
    return updated;
  }

  sync(tenantId: string, sourceId: string): { id: string; synced: true } {
    this.getById(tenantId, sourceId);
    /* 更新 updated_at 作为同步标记；实际摄入由 autorun 异步执行 */
    this.storeFor(tenantId).update(sourceId, tenantId, {});
    return { id: sourceId, synced: true };
  }

  delete(tenantId: string, sourceId: string): { id: string } {
    const deleted = this.storeFor(tenantId).delete(sourceId, tenantId);
    if (!deleted) throw new NotFoundError(`知识源 ${sourceId} 不存在`, ErrorCode.NOT_FOUND_KNOWLEDGE_SOURCE);
    return { id: sourceId };
  }
}
