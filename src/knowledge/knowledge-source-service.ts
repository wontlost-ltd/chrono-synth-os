/**
 * 知识源 Application Service
 * 封装知识源的业务逻辑，路由层只做请求解析和响应序列化
 */

import type { UowOrDb } from '../storage/uow-helpers.js';
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
  private readonly store: KnowledgeSourceStore;

  constructor(uowOrDb: UowOrDb) {
    this.store = new KnowledgeSourceStore(uowOrDb);
  }

  list(tenantId: string, page: number, pageSize: number): PaginatedResult<KnowledgeSourceRecord> {
    const offset = (page - 1) * pageSize;
    const { sources, total } = this.store.listByTenant(tenantId, pageSize, offset);
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
    const source = this.store.getById(sourceId, tenantId);
    if (!source) throw new NotFoundError(`知识源 ${sourceId} 不存在`, ErrorCode.NOT_FOUND_KNOWLEDGE_SOURCE);
    return source;
  }

  create(tenantId: string, input: CreateKnowledgeSourceInput): KnowledgeSourceRecord {
    return this.store.create(tenantId, {
      type: input.type,
      name: input.name,
      configJson: JSON.stringify(input.config),
    });
  }

  update(tenantId: string, sourceId: string, input: UpdateKnowledgeSourceInput): KnowledgeSourceRecord {
    const updated = this.store.update(sourceId, tenantId, {
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
    this.store.update(sourceId, tenantId, {});
    return { id: sourceId, synced: true };
  }

  delete(tenantId: string, sourceId: string): { id: string } {
    const deleted = this.store.delete(sourceId, tenantId);
    if (!deleted) throw new NotFoundError(`知识源 ${sourceId} 不存在`, ErrorCode.NOT_FOUND_KNOWLEDGE_SOURCE);
    return { id: sourceId };
  }
}
