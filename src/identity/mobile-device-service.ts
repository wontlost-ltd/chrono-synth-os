/**
 * Mobile Device Application Service
 * 封装设备 CRUD 的数据访问与业务逻辑
 *
 * 分片 Phase 0 · Plan 1b（Task 3 Mobile 组）：
 * - devices 表**有 tenant_id 列**（不同于 avatars 的父归属），故租户约束直接 `WHERE tenant_id=? AND …`。
 * - ctor 收 `TenantDbResolver`；`txFor(tenantId)` 每次 `dbForTenant(tenantId)` 现取该租户 shard 的 tx（不缓存）。
 * - 每 public 方法首参加 `tenantId`，在 query/executor 层带 tenant predicate（双重约束：选对 shard + 同库跨租户隔离）。
 * - device 表不被 mixed-scope coordinator 复用（不同于 IdentityWriter），故不抽 writer seam，照 DeviceAvatarService 直取 tx。
 */

import { randomUUID } from 'node:crypto';
import type { SyncWriteUnitOfWork, MdevDeviceRow } from '@chrono/kernel';
import {
  mdevQueryByUid, mdevQueryById, mdevQueryListByTenantUser, mdevQueryOwned,
  mdevCmdCreate, mdevCmdUpdateOnRegister, mdevCmdUpdatePushToken,
  mdevCmdMarkTokenInvalid, mdevCmdDelete,
} from '@chrono/kernel';
import type { TenantDbResolver } from '../storage/tenant-db-resolver.js';
import { registerCoreSelfExecutors } from '../storage/executors/index.js';
import { NotFoundError, ErrorCode } from '../errors/index.js';

export interface RegisterDeviceInput {
  deviceUid: string;
  platform: string;
  pushToken?: string | null;
  appVersion?: string | null;
}

/** device row → C 端 DTO（listByUser 共用）。 */
function mapDeviceRow(r: MdevDeviceRow) {
  return {
    id: r.id,
    deviceUid: r.device_uid,
    platform: r.platform,
    pushToken: r.push_token,
    appVersion: r.app_version,
    lastSeenAt: r.last_seen_at,
    createdAt: r.created_at,
  };
}

export class MobileDeviceService {
  constructor(private readonly resolver: TenantDbResolver) {
    registerCoreSelfExecutors();
  }

  /** 每 tenant-scoped 调用现取该租户 shard 的 tx（dbForTenant 选 shard），不跨请求缓存。 */
  private txFor(tenantId: string): SyncWriteUnitOfWork {
    return this.resolver.dbForTenant(tenantId);
  }

  register(tenantId: string, userId: string, input: RegisterDeviceInput) {
    const tx = this.txFor(tenantId);
    const now = Date.now();
    const existing = tx.queryOne(mdevQueryByUid({ tenantId, userId, deviceUid: input.deviceUid }));

    if (existing) {
      tx.execute(mdevCmdUpdateOnRegister({
        tenantId,
        deviceId: existing.id,
        platform: input.platform,
        pushToken: input.pushToken ?? null,
        appVersion: input.appVersion ?? null,
        now,
      }));
      return { id: existing.id, deviceUid: input.deviceUid, platform: input.platform, updated: true };
    }

    const id = `dev_${randomUUID()}`;
    tx.execute(mdevCmdCreate({
      id, tenantId, userId,
      deviceUid: input.deviceUid,
      platform: input.platform,
      pushToken: input.pushToken ?? null,
      appVersion: input.appVersion ?? null,
      now,
    }));
    return { id, deviceUid: input.deviceUid, platform: input.platform, updated: false };
  }

  /**
   * 按 (tenantId, userId) 列设备。devices 表有 tenant_id 列 → `WHERE tenant_id=? AND user_id=?`
   * 直接隔离（含选对 shard）。租户 scoped 调用方（如 push 桥、facade）一律用此方法。
   */
  listByUser(tenantId: string, userId: string) {
    const rows = this.txFor(tenantId).queryMany(mdevQueryListByTenantUser({ tenantId, userId }));
    return rows.map(mapDeviceRow);
  }

  updatePushToken(tenantId: string, deviceId: string, userId: string, pushToken: string) {
    const tx = this.txFor(tenantId);
    /* ownership 校验带 tenant predicate（WHERE tenant_id=? AND id=? AND user_id=?）。 */
    const owned = tx.queryOne(mdevQueryOwned({ tenantId, deviceId, userId }));
    if (!owned) {
      return { id: deviceId, pushToken, updated: false };
    }
    const result = tx.execute(mdevCmdUpdatePushToken({ tenantId, deviceId, pushToken, now: Date.now() }));
    return { id: deviceId, pushToken, updated: result.rowsAffected > 0 };
  }

  /**
   * EP-3.5: dispatcher 收到平台 BadDeviceToken / UNREGISTERED 时调用。
   *
   * 不要求 user 上下文：dispatcher 在 agent 层从 (tenantId, deviceId) 拿到结果，
   * 没有 JWT。这里也不查 user ownership——deviceId 是不可猜的随机串。
   * 但**带 tenantId 全链**：选对 shard + `WHERE tenant_id=? AND id=?`（防同库跨租户误标）。
   *
   * 行为是 idempotent 的（COALESCE 保证只首次写入时间戳）；reason 当前
   * 不持久化，由调用方记到日志/审计。
   */
  markTokenInvalid(tenantId: string, deviceId: string, reason?: string): void {
    this.txFor(tenantId).execute(
      mdevCmdMarkTokenInvalid({ tenantId, deviceId, now: Date.now(), reason }),
    );
  }

  /** 按 (tenantId, 主键) 拿设备行；EP-3.5 dispatcher 用来构造 DeviceLookupResult。
   *  `WHERE tenant_id=? AND id=?`——选对 shard + 同库跨租户隔离。 */
  findById(tenantId: string, deviceId: string): MdevDeviceRow | null {
    return this.txFor(tenantId).queryOne(mdevQueryById({ tenantId, deviceId }));
  }

  delete(tenantId: string, deviceId: string, userId: string) {
    const tx = this.txFor(tenantId);
    this.requireOwnedDevice(tx, tenantId, deviceId, userId);
    tx.execute(mdevCmdDelete({ tenantId, deviceId }));
  }

  requireOwnedDevice(tx: SyncWriteUnitOfWork, tenantId: string, deviceId: string, userId: string): MdevDeviceRow {
    const device = tx.queryOne(mdevQueryOwned({ tenantId, deviceId, userId }));
    if (!device) {
      throw new NotFoundError('设备不存在', ErrorCode.NOT_FOUND_DEVICE);
    }
    return device;
  }

  /** facade 复用：以外部已解析的 tx 校验设备归属（同 tenant predicate）。 */
  requireOwnedDeviceForTenant(tenantId: string, deviceId: string, userId: string): MdevDeviceRow {
    return this.requireOwnedDevice(this.txFor(tenantId), tenantId, deviceId, userId);
  }
}
