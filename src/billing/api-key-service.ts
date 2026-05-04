/**
 * API Key Application Service
 * 封装 API Key 的创建、列表、吊销的数据访问与业务逻辑
 */

import { randomUUID, createHash, randomBytes } from 'node:crypto';
import type { SyncWriteUnitOfWork, ApiKeyRow } from '@chrono/kernel';
import { apikeyQueryList, apikeyCmdCreate, apikeyCmdRevoke } from '@chrono/kernel';
import { SubscriptionQueryService } from './subscription-query-service.js';
import { asUow, type UowOrDb } from '../storage/uow-helpers.js';
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

export class ApiKeyService {
  private readonly tx: SyncWriteUnitOfWork;
  private readonly subscriptionQuery: SubscriptionQueryService;

  constructor(uowOrDb: UowOrDb) {
    registerCoreSelfExecutors();
    this.tx = asUow(uowOrDb);
    this.subscriptionQuery = new SubscriptionQueryService(uowOrDb);
  }

  /**
   * 创建 API Key
   * @returns ok=true 时包含明文 key（仅此一次）；ok=false 时包含实际 tenantPlanId
   */
  create(tenantId: string, requestedPlanId: string): CreateApiKeyOutcome {
    const tenantPlanId = this.subscriptionQuery.getActiveSubscriptionPlanId(tenantId);
    const planId = requestedPlanId === 'free' ? tenantPlanId : requestedPlanId;
    if (planId !== tenantPlanId) return { ok: false, tenantPlanId };

    const apiKey = `csk_${randomBytes(36).toString('base64url')}`;
    const keyHash = createHash('sha256').update(apiKey).digest('hex');
    const id = `ak_${randomUUID()}`;
    const now = Date.now();

    this.tx.execute(apikeyCmdCreate({ id, tenantId, keyHash, planId, now }));

    return { ok: true, data: { id, tenantId, planId, apiKey, createdAt: now } };
  }

  /** 列出租户所有 API Key（不含明文） */
  list(tenantId: string): ApiKeyDto[] {
    const rows = this.tx.queryMany(apikeyQueryList(tenantId)) as unknown as ApiKeyRow[];

    return rows.map(r => ({
      id: r.id,
      tenantId: r.tenant_id,
      planId: r.plan_id,
      isRevoked: r.is_revoked === 1,
      createdAt: r.created_at,
    }));
  }

  /** 吊销 API Key，返回是否成功 */
  revoke(id: string, tenantId: string): boolean {
    const result = this.tx.execute(apikeyCmdRevoke({ id, tenantId }));
    return result.rowsAffected > 0;
  }
}
