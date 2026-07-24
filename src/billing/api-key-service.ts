/**
 * API Key Application Service
 * 封装 API Key 的创建、列表、吊销的数据访问与业务逻辑
 *
 * 分片 Phase 0 · Plan 1b（Task 8）：
 * - api_keys 表**有 tenant_id 列**，故租户约束直接在 query/executor 层：list `WHERE tenant_id=?`、
 *   revoke `WHERE id=? AND tenant_id=?`、create INSERT 带 tenant_id（executor 已含 tenant predicate）。
 * - `ApiKeyWriter` 是 **tenant-bound 内核**——ctor 同时绑 `tenantId` + `tx`（已解析到正确 shard 的 UoW），
 *   方法**不再接 tenantId**（消双源不一致），tenantId 恒来自构造时绑定。承载 API Key 全部管理读写。
 * - `ApiKeyService` ctor 收 `TenantDbResolver`；`writerFor(tenantId)` 每次 `dbForTenant(tenantId)` 现造 writer
 *   （**不跨请求缓存**，避免无界 tenant cache）；每 public 管理方法首参 tenantId，委托 writer。
 * - **key hash→tenant 反查**（无 tenantId 入参，token/keyHash 本身即定位符=mixed-scope）不在本类内——
 *   它在 API Key 认证中间件 `src/server/plugins/auth.ts`（`apikeyQueryByHash(keyHash)` 直查），归 **Plan 1c**。
 *   Plan 1c 的 coordinator 定位 tenant 后**用同一 `ApiKeyWriter(resolvedTenantId, resolvedTx)`**——
 *   不破坏、不半截、不 `new SingleDbResolver(tx)` 回退。
 */

import { randomUUID, createHash, randomBytes } from 'node:crypto';
import type { SyncWriteUnitOfWork } from '@chrono/kernel';
import { apikeyQueryList, apikeyCmdCreate, apikeyCmdRevoke } from '@chrono/kernel';
import type { TenantDbResolver } from '../storage/tenant-db-resolver.js';
import { SubscriptionQueryService } from './subscription-query-service.js';
import { registerCoreSelfExecutors } from '../storage/executors/index.js';

export interface ApiKeyDto {
  id: string;
  tenantId: string;
  planId: string;
  isRevoked: boolean;
  createdAt: number;
}

export interface CreateApiKeyResult {
  id: string;
  tenantId: string;
  planId: string;
  apiKey: string;
  createdAt: number;
}

export type CreateApiKeyOutcome =
  | { ok: true; data: CreateApiKeyResult }
  | { ok: false; tenantPlanId: string };

/**
 * tenant-bound API Key 管理读写内核：ctor 同时绑定 `tenantId` + 已解析到该租户 shard 的 `tx`。
 * 方法不接 tenantId——tenantId 恒来自构造绑定（消双源不一致）。所有查询/命令带 tenant predicate。
 *
 * 每个 `new ApiKeyWriter(...)` 是 Plan 0 inventory 里独立的 resolved-tx sink edge，逐调用点审计。
 * 供 Plan 1c 的 key-hash coordinator 定位 tenant 后复用（传它解析出的 tenantId + tx）。
 */
export class ApiKeyWriter {
  private readonly subscriptionQuery: SubscriptionQueryService;

  constructor(
    private readonly tenantId: string,
    private readonly tx: SyncWriteUnitOfWork,
  ) {
    registerCoreSelfExecutors();
    this.subscriptionQuery = new SubscriptionQueryService(tx);
  }

  /**
   * 创建 API Key
   * @returns ok=true 时包含明文 key（仅此一次）；ok=false 时包含实际 tenantPlanId
   */
  create(requestedPlanId: string): CreateApiKeyOutcome {
    const tenantPlanId = this.subscriptionQuery.getActiveSubscriptionPlanId(this.tenantId);
    const planId = requestedPlanId === 'free' ? tenantPlanId : requestedPlanId;
    if (planId !== tenantPlanId) return { ok: false, tenantPlanId };

    const apiKey = `csk_${randomBytes(36).toString('base64url')}`;
    const keyHash = createHash('sha256').update(apiKey).digest('hex');
    const id = `ak_${randomUUID()}`;
    const now = Date.now();

    this.tx.execute(apikeyCmdCreate({ id, tenantId: this.tenantId, keyHash, planId, now }));

    return { ok: true, data: { id, tenantId: this.tenantId, planId, apiKey, createdAt: now } };
  }

  /** 列出租户所有 API Key（不含明文）。tenant predicate：`WHERE tenant_id=?`。 */
  list(): ApiKeyDto[] {
    const rows = this.tx.queryMany(apikeyQueryList(this.tenantId));

    return rows.map(r => ({
      id: r.id,
      tenantId: r.tenant_id,
      planId: r.plan_id,
      isRevoked: r.is_revoked === 1,
      createdAt: r.created_at,
    }));
  }

  /** 吊销 API Key，返回是否成功。tenant predicate：`WHERE id=? AND tenant_id=?`（防跨租户误吊销）。 */
  revoke(id: string): boolean {
    const result = this.tx.execute(apikeyCmdRevoke({ id, tenantId: this.tenantId }));
    return result.rowsAffected > 0;
  }
}

export class ApiKeyService {
  constructor(private readonly resolver: TenantDbResolver) {
    registerCoreSelfExecutors();
  }

  /** 每 tenant-scoped 调用现造 tenant-bound writer（dbForTenant 选 shard），不跨请求缓存。 */
  private writerFor(tenantId: string): ApiKeyWriter {
    return new ApiKeyWriter(tenantId, this.resolver.dbForTenant(tenantId));
  }

  create(tenantId: string, requestedPlanId: string): CreateApiKeyOutcome {
    return this.writerFor(tenantId).create(requestedPlanId);
  }

  list(tenantId: string): ApiKeyDto[] {
    return this.writerFor(tenantId).list();
  }

  revoke(id: string, tenantId: string): boolean {
    return this.writerFor(tenantId).revoke(id);
  }
}
