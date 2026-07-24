/**
 * 分身管理服务
 * CRUD + 配额检查 + 软删除
 *
 * 分片 Phase 0 · Plan 1b（Task 2 Avatar 组）：
 * - `AvatarWriter` 是 **tenant-bound 内核**——ctor 同时绑 `tenantId` + `tx`（已解析到正确 shard 的 UoW），
 *   方法**不再接 tenantId**（消双源不一致），tenantId 恒来自构造绑定。avatars/device_avatars **无 tenant_id 列**
 *   （只 identity_id，v027），故租户约束全经父表 identities：读 `JOIN identities WHERE i.tenant_id=?`、
 *   写 `identity_id IN (SELECT id FROM identities WHERE tenant_id=?)`、create 前 `EXISTS identities WHERE id=? AND tenant_id=?`。
 * - `AvatarService` ctor 收 `TenantDbResolver`；`writerFor(tenantId)` 每次 `dbForTenant(tenantId)` 现造 writer
 *   （**不跨请求缓存**）；每 public 方法首参 tenantId，委托 writer。
 * - 持 `tx` 的复用方（MobileDeviceFacade/DeviceAvatarService/AvatarAutorunFacade/queue worker）定位 tenant 后
 *   **用同一 `AvatarWriter(resolvedTenantId, resolvedTx)`**（照 IdentityWriter seam），不 `new SingleDbResolver(tx)` 回退。
 */

import type { SyncWriteUnitOfWork, AvatarRow } from '@chrono/kernel';
import {
  avtQueryByIdForTenant, avtQueryByIdIdentityForTenant, avtQueryByIdentityForTenant,
  avtQueryDefaultForTenant, avtQueryCountActiveForTenant, avtQueryIdentityBelongsToTenant,
  avtCmdCreate, avtCmdUpdateForTenant, avtCmdSoftDeleteForTenant,
} from '@chrono/kernel';
import type { TenantDbResolver } from '../storage/tenant-db-resolver.js';
import { NotFoundError, ErrorCode } from '../errors/index.js';
import { generatePrefixedId } from '../utils/id-generator.js';
import type { Avatar, AvatarKind, BehaviorOverrides } from './types.js';
import { registerCoreSelfExecutors } from '../storage/executors/index.js';

function rowToAvatar(r: AvatarRow): Avatar {
  return {
    id: r.id,
    identityId: r.identity_id,
    label: r.label,
    kind: r.kind as AvatarKind,
    behaviorOverrides: r.behavior_overrides ? JSON.parse(r.behavior_overrides) as BehaviorOverrides : null,
    isDefault: r.is_default === 1,
    isActive: r.is_active === 1,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/**
 * tenant-bound 分身读写内核：ctor 同时绑定 `tenantId` + 已解析到该租户 shard 的 `tx`。
 * 方法不接 tenantId——tenantId 恒来自构造绑定（消双源不一致）。所有查询/命令经父表 identities 带 tenant predicate。
 *
 * 每个 `new AvatarWriter(...)` 是 Plan 0 inventory 里独立的 resolved-tx sink edge，逐调用点审计。
 */
export class AvatarWriter {
  constructor(
    private readonly tenantId: string,
    private readonly tx: SyncWriteUnitOfWork,
  ) {
    registerCoreSelfExecutors();
  }

  /** identity 是否属于该租户（父归属探针，供 create 前置校验 / 外部 avatar 端验复用）。 */
  identityBelongsToTenant(identityId: string): boolean {
    return this.tx.queryOne(avtQueryIdentityBelongsToTenant(this.tenantId, identityId)) !== null;
  }

  create(identityId: string, data: { label: string; kind?: AvatarKind; behaviorOverrides?: BehaviorOverrides }): Avatar {
    /* 父归属前置校验：identity 须属于本租户，否则拒（防跨租户在别人 identity 下建 avatar）。 */
    if (!this.identityBelongsToTenant(identityId)) {
      throw new NotFoundError(`身份 ${identityId} 不存在或不属于当前租户`, ErrorCode.NOT_FOUND_IDENTITY);
    }

    const id = generatePrefixedId('avt');
    const now = Date.now();
    const kind = data.kind ?? 'general';
    const overrides = data.behaviorOverrides ? JSON.stringify(data.behaviorOverrides) : null;

    this.tx.execute(avtCmdCreate({ id, identityId, label: data.label, kind, behaviorOverrides: overrides, now }));

    return {
      id, identityId, label: data.label, kind,
      behaviorOverrides: data.behaviorOverrides ?? null,
      isDefault: false, isActive: true, createdAt: now, updatedAt: now,
    };
  }

  getById(avatarId: string): Avatar | null {
    const row = this.tx.queryOne(avtQueryByIdForTenant(this.tenantId, avatarId));
    return row ? rowToAvatar(row) : null;
  }

  getByIdForIdentity(avatarId: string, identityId: string): Avatar | null {
    const row = this.tx.queryOne(avtQueryByIdIdentityForTenant(this.tenantId, avatarId, identityId));
    return row ? rowToAvatar(row) : null;
  }

  listByIdentity(identityId: string): Avatar[] {
    const rows = [...this.tx.queryMany(avtQueryByIdentityForTenant(this.tenantId, identityId))];
    return rows.map(rowToAvatar);
  }

  update(avatarId: string, data: Partial<{ label: string; kind: AvatarKind; behaviorOverrides: BehaviorOverrides }>): Avatar | null {
    const now = Date.now();
    this.tx.execute(avtCmdUpdateForTenant({
      tenantId: this.tenantId,
      avatarId,
      label: data.label,
      kind: data.kind,
      behaviorOverrides: data.behaviorOverrides !== undefined ? JSON.stringify(data.behaviorOverrides) : undefined,
      now,
    }));
    return this.getById(avatarId);
  }

  updateForIdentity(
    avatarId: string,
    identityId: string,
    data: Partial<{ label: string; kind: AvatarKind; behaviorOverrides: BehaviorOverrides }>,
  ): Avatar | null {
    /* update 已经父归属子查询约束租户；identityId 再收窄到具体 identity。命中后回读也带 identity 约束。 */
    const now = Date.now();
    this.tx.execute(avtCmdUpdateForTenant({
      tenantId: this.tenantId,
      avatarId,
      label: data.label,
      kind: data.kind,
      behaviorOverrides: data.behaviorOverrides !== undefined ? JSON.stringify(data.behaviorOverrides) : undefined,
      now,
    }));
    return this.getByIdForIdentity(avatarId, identityId);
  }

  softDelete(avatarId: string): boolean {
    const result = this.tx.execute(avtCmdSoftDeleteForTenant({ tenantId: this.tenantId, avatarId, now: Date.now() }));
    return result.rowsAffected > 0;
  }

  softDeleteForIdentity(avatarId: string, identityId: string): boolean {
    /* 先按 identity 收窄归属校验（父归属 + identity），命中才软删。 */
    if (!this.getByIdForIdentity(avatarId, identityId)) return false;
    const result = this.tx.execute(avtCmdSoftDeleteForTenant({ tenantId: this.tenantId, avatarId, now: Date.now() }));
    return result.rowsAffected > 0;
  }

  getDefault(identityId: string): Avatar | null {
    const row = this.tx.queryOne(avtQueryDefaultForTenant(this.tenantId, identityId));
    return row ? rowToAvatar(row) : null;
  }

  countActive(identityId: string): number {
    const row = this.tx.queryOne(avtQueryCountActiveForTenant(this.tenantId, identityId));
    return Number(row?.count ?? 0);
  }
}

export class AvatarService {
  constructor(private readonly resolver: TenantDbResolver) {
    registerCoreSelfExecutors();
  }

  /** 每 tenant-scoped 调用现造 tenant-bound writer（dbForTenant 选 shard），不跨请求缓存。 */
  private writerFor(tenantId: string): AvatarWriter {
    return new AvatarWriter(tenantId, this.resolver.dbForTenant(tenantId));
  }

  create(tenantId: string, identityId: string, data: { label: string; kind?: AvatarKind; behaviorOverrides?: BehaviorOverrides }): Avatar {
    return this.writerFor(tenantId).create(identityId, data);
  }

  getById(tenantId: string, avatarId: string): Avatar | null {
    return this.writerFor(tenantId).getById(avatarId);
  }

  getByIdForIdentity(tenantId: string, avatarId: string, identityId: string): Avatar | null {
    return this.writerFor(tenantId).getByIdForIdentity(avatarId, identityId);
  }

  listByIdentity(tenantId: string, identityId: string): Avatar[] {
    return this.writerFor(tenantId).listByIdentity(identityId);
  }

  update(tenantId: string, avatarId: string, data: Partial<{ label: string; kind: AvatarKind; behaviorOverrides: BehaviorOverrides }>): Avatar | null {
    return this.writerFor(tenantId).update(avatarId, data);
  }

  updateForIdentity(
    tenantId: string,
    avatarId: string,
    identityId: string,
    data: Partial<{ label: string; kind: AvatarKind; behaviorOverrides: BehaviorOverrides }>,
  ): Avatar | null {
    return this.writerFor(tenantId).updateForIdentity(avatarId, identityId, data);
  }

  softDelete(tenantId: string, avatarId: string): boolean {
    return this.writerFor(tenantId).softDelete(avatarId);
  }

  softDeleteForIdentity(tenantId: string, avatarId: string, identityId: string): boolean {
    return this.writerFor(tenantId).softDeleteForIdentity(avatarId, identityId);
  }

  getDefault(tenantId: string, identityId: string): Avatar | null {
    return this.writerFor(tenantId).getDefault(identityId);
  }

  countActive(tenantId: string, identityId: string): number {
    return this.writerFor(tenantId).countActive(identityId);
  }
}
