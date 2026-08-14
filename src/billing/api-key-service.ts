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
import { apikeyQueryList, apikeyQueryById, apikeyCmdCreate, apikeyCmdRevoke } from '@chrono/kernel';
import type { TenantDbResolver } from '../storage/tenant-db-resolver.js';
import { SubscriptionQueryService } from './subscription-query-service.js';
import { TenantIdentityDirectory } from '../identity/tenant-identity-directory.js';
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

  /**
   * 吊销 API Key（分片 Plan 1c Task 7：目录=定位器，shard is_revoked=权威）。
   *
   * 先按 id 取 key_hash（用于调用方清协调库目录定位项）→ shard 标 revoked（tenant predicate
   * `WHERE id=? AND tenant_id=?` 防跨租户误吊销，是权威隔离门）。返回 `{ revoked, keyHash }`：
   * `revoked` 为本次是否真吊销（tenant 隔离命中）；`keyHash` 为该 id 的 hash（供 removeLookup 清目录）。
   * 跨租户越权（id 属他租户）→ revoked=false 且 keyHash=null（不取他租户 hash，不清他租户目录项）。
   */
  revoke(id: string): { revoked: boolean; keyHash: string | null } {
    /* 先取 hash——但只在 tenant 隔离命中时才回传（防跨租户读他人 hash）。 */
    const row = this.tx.queryOne(apikeyQueryById(id));
    const keyHash = row && row.tenant_id === this.tenantId ? row.key_hash : null;
    const result = this.tx.execute(apikeyCmdRevoke({ id, tenantId: this.tenantId }));
    return { revoked: result.rowsAffected > 0, keyHash };
  }
}

export class ApiKeyService {
  /** 协调库身份目录门面：api_key_hash→tenant 定位项 record/remove（Plan 1c Task 7）。 */
  private readonly directory: TenantIdentityDirectory;

  constructor(private readonly resolver: TenantDbResolver) {
    registerCoreSelfExecutors();
    this.directory = new TenantIdentityDirectory(resolver);
  }

  /** 每 tenant-scoped 调用现造 tenant-bound writer（dbForTenant 选 shard），不跨请求缓存。 */
  private writerFor(tenantId: string): ApiKeyWriter {
    return new ApiKeyWriter(tenantId, this.resolver.dbForTenant(tenantId));
  }

  /**
   * 创建 API Key（分片 Plan 1c Task 7）——shard 写 key 行后记录 api_key_hash→tenant 目录定位项。
   *
   * recordActiveLookup 遇他租户已占同 hash 会抛——**不吞**：目录 locator 写失败则整个创建失败
   * （避免发了 key 却定位不到 shard）。随机 key（csk_ + 36 字节）碰撞概率极低。
   */
  create(tenantId: string, requestedPlanId: string): CreateApiKeyOutcome {
    const outcome = this.writerFor(tenantId).create(requestedPlanId);
    if (outcome.ok) {
      const keyHash = createHash('sha256').update(outcome.data.apiKey).digest('hex');
      this.directory.recordActiveLookup({ tenantId, lookupKind: 'api_key_hash', lookupValue: keyHash });
    }
    return outcome;
  }

  list(tenantId: string): ApiKeyDto[] {
    return this.writerFor(tenantId).list();
  }

  /**
   * 吊销 API Key（分片 Plan 1c Task 7：目录=定位器，shard is_revoked=权威）。
   * 先在 shard 内标 revoked（权威）+ 取 key_hash → 再 removeLookup 清协调库目录定位项（尽力而为，
   * 非原子可接受——shard 已 revoked=权威拒，目录清晚了/清不了都不越权）。返回是否真吊销。
   */
  revoke(id: string, tenantId: string): boolean {
    const { revoked, keyHash } = this.writerFor(tenantId).revoke(id);
    if (keyHash) {
      this.directory.removeLookup('api_key_hash', keyHash);
    }
    return revoked;
  }
}
