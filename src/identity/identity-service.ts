/**
 * 身份管理服务
 * 维护 User ↔ Identity (1:1) 映射；同一 tenant 可包含多个用户身份。
 * 创建身份时同时生成默认 Avatar。
 *
 * 分片 Phase 0 · Plan 1b：
 * - `IdentityWriter` 是 **tenant-bound 内核**——ctor 同时绑 `tenantId` + `tx`（已解析到正确 shard 的 UoW），
 *   方法**不再接 tenantId**（消双源不一致），tenantId 恒来自构造时绑定。承载 identity 全部读写。
 * - `IdentityService` ctor 收 `TenantDbResolver`；`writerFor(tenantId)` 每次 `dbForTenant(tenantId)` 现造 writer
 *   （**不跨请求缓存**，避免无界 tenant cache）；每 public 方法首参 tenantId，委托 writer。
 * - Plan 1c 的 Auth/SCIM/SSO 定位 tenant 后**用同一 `IdentityWriter(resolvedTenantId, resolvedTx)`**，
 *   不破坏、不半截、不 `new SingleDbResolver(tx)` 回退。
 */

import type { SyncWriteUnitOfWork, IdentityRow } from '@chrono/kernel';
import {
  identQueryByTenantAndUser, identQueryByTenantAndId, identQueryByTenant,
  identCmdCreate, identCmdCreateDefaultAvatar, identCmdUpdate,
} from '@chrono/kernel';
import type { TenantDbResolver } from '../storage/tenant-db-resolver.js';
import { generatePrefixedId } from '../utils/id-generator.js';
import type { Identity } from './types.js';
import { registerCoreSelfExecutors } from '../storage/executors/index.js';

function rowToIdentity(r: IdentityRow): Identity {
  return {
    id: r.id,
    userId: r.user_id,
    tenantId: r.tenant_id,
    displayName: r.display_name,
    bio: r.bio,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/**
 * tenant-bound 身份读写内核：ctor 同时绑定 `tenantId` + 已解析到该租户 shard 的 `tx`。
 * 方法不接 tenantId——tenantId 恒来自构造绑定（消双源不一致）。所有查询/命令带 tenant predicate。
 *
 * 每个 `new IdentityWriter(...)` 是 Plan 0 inventory 里独立的 resolved-tx sink edge，逐调用点审计。
 */
export class IdentityWriter {
  constructor(
    private readonly tenantId: string,
    private readonly tx: SyncWriteUnitOfWork,
  ) {
    registerCoreSelfExecutors();
  }

  listByTenant(): Identity[] {
    const rows = [...this.tx.queryMany(identQueryByTenant(this.tenantId))];
    return rows.map(rowToIdentity);
  }

  getByUser(userId: string): Identity | null {
    const row = this.tx.queryOne(identQueryByTenantAndUser(this.tenantId, userId));
    return row ? rowToIdentity(row) : null;
  }

  ensureForUser(userId: string, displayName: string): Identity {
    const existing = this.getByUser(userId);
    if (existing) return existing;
    return this.create(userId, displayName);
  }

  /** 创建身份 + 默认分身（事务内）。 */
  create(userId: string, displayName: string): Identity {
    const identityId = generatePrefixedId('ident');
    const avatarId = generatePrefixedId('avt');
    const now = Date.now();

    this.tx.transaction(() => {
      this.tx.execute(identCmdCreate({ identityId, userId, tenantId: this.tenantId, displayName, now }));
      this.tx.execute(identCmdCreateDefaultAvatar({ avatarId, identityId, now }));
    });

    return { id: identityId, userId, tenantId: this.tenantId, displayName, bio: null, createdAt: now, updatedAt: now };
  }

  update(identityId: string, data: { displayName?: string; bio?: string }): Identity | null {
    const now = Date.now();
    this.tx.execute(identCmdUpdate({
      identityId,
      tenantId: this.tenantId,
      displayName: data.displayName,
      bio: data.bio,
      now,
    }));

    const row = this.tx.queryOne(identQueryByTenantAndId(this.tenantId, identityId));
    return row ? rowToIdentity(row) : null;
  }
}

export class IdentityService {
  constructor(private readonly resolver: TenantDbResolver) {
    registerCoreSelfExecutors();
  }

  /** 每 tenant-scoped 调用现造 tenant-bound writer（dbForTenant 选 shard），不跨请求缓存。 */
  private writerFor(tenantId: string): IdentityWriter {
    return new IdentityWriter(tenantId, this.resolver.dbForTenant(tenantId));
  }

  listByTenant(tenantId: string): Identity[] {
    return this.writerFor(tenantId).listByTenant();
  }

  getByUser(tenantId: string, userId: string): Identity | null {
    return this.writerFor(tenantId).getByUser(userId);
  }

  ensureForUser(tenantId: string, userId: string, displayName: string): Identity {
    return this.writerFor(tenantId).ensureForUser(userId, displayName);
  }

  create(tenantId: string, userId: string, displayName: string): Identity {
    return this.writerFor(tenantId).create(userId, displayName);
  }

  update(tenantId: string, identityId: string, data: { displayName?: string; bio?: string }): Identity | null {
    return this.writerFor(tenantId).update(identityId, data);
  }
}
