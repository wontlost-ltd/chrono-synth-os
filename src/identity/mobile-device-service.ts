/**
 * Mobile Device Application Service
 * 封装设备 CRUD 的数据访问与业务逻辑
 */

import { randomUUID } from 'node:crypto';
import type { SyncWriteUnitOfWork, MdevDeviceRow } from '@chrono/kernel';
import {
  mdevQueryByUid, mdevQueryById, mdevQueryListByUser, mdevQueryListByTenantUser, mdevQueryOwned,
  mdevCmdCreate, mdevCmdUpdateOnRegister, mdevCmdUpdatePushToken,
  mdevCmdMarkTokenInvalid, mdevCmdDelete,
} from '@chrono/kernel';
import { registerCoreSelfExecutors } from '../storage/executors/index.js';
import { NotFoundError, ErrorCode } from '../errors/index.js';

export interface RegisterDeviceInput {
  deviceUid: string;
  platform: string;
  pushToken?: string | null;
  appVersion?: string | null;
}

/** device row → C 端 DTO（listByUser / listByTenantUser 共用）。 */
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
  constructor(private readonly tx: SyncWriteUnitOfWork) {
    registerCoreSelfExecutors();
  }

  register(tenantId: string, userId: string, input: RegisterDeviceInput) {
    const now = Date.now();
    const existing = this.tx.queryOne(mdevQueryByUid({ tenantId, userId, deviceUid: input.deviceUid }));

    if (existing) {
      this.tx.execute(mdevCmdUpdateOnRegister({
        deviceId: existing.id,
        platform: input.platform,
        pushToken: input.pushToken ?? null,
        appVersion: input.appVersion ?? null,
        now,
      }));
      return { id: existing.id, deviceUid: input.deviceUid, platform: input.platform, updated: true };
    }

    const id = `dev_${randomUUID()}`;
    this.tx.execute(mdevCmdCreate({
      id, tenantId, userId,
      deviceUid: input.deviceUid,
      platform: input.platform,
      pushToken: input.pushToken ?? null,
      appVersion: input.appVersion ?? null,
      now,
    }));
    return { id, deviceUid: input.deviceUid, platform: input.platform, updated: false };
  }

  listByUser(userId: string) {
    const rows = this.tx.queryMany(mdevQueryListByUser(userId));
    return rows.map(mapDeviceRow);
  }

  /**
   * 显式按 (tenantId, userId) 列设备——宿主 DB 上必须用它（listByUser 只按 user_id，在宿主 DB
   * 无租户隔离，跨租户场景有风险，Codex 退回 High）。租户 scoped 调用方（如 push 桥）一律用此方法。
   */
  listByTenantUser(tenantId: string, userId: string) {
    const rows = this.tx.queryMany(mdevQueryListByTenantUser({ tenantId, userId }));
    return rows.map(mapDeviceRow);
  }

  updatePushToken(deviceId: string, userId: string, pushToken: string) {
    this.requireOwnedDevice(deviceId, userId);
    this.tx.execute(mdevCmdUpdatePushToken({ deviceId, pushToken, now: Date.now() }));
    return { id: deviceId, pushToken, updated: true };
  }

  /**
   * EP-3.5: dispatcher 收到平台 BadDeviceToken / UNREGISTERED 时调用。
   *
   * 不要求 user 上下文：dispatcher 在 agent 层从 deviceId 直接拿到结果，
   * 没有 JWT。这里也不查 ownership——deviceId 是不可猜的随机串。
   *
   * 行为是 idempotent 的（COALESCE 保证只首次写入时间戳）；reason 当前
   * 不持久化，由调用方记到日志/审计。
   */
  markTokenInvalid(deviceId: string, reason?: string): void {
    this.tx.execute(
      mdevCmdMarkTokenInvalid({ deviceId, now: Date.now(), reason }),
    );
  }

  /** 按主键拿设备行；EP-3.5 dispatcher 用来构造 DeviceLookupResult。 */
  findById(deviceId: string): MdevDeviceRow | null {
    return this.tx.queryOne(mdevQueryById(deviceId));
  }

  delete(deviceId: string, userId: string) {
    this.requireOwnedDevice(deviceId, userId);
    this.tx.execute(mdevCmdDelete(deviceId));
  }

  requireOwnedDevice(deviceId: string, userId: string): MdevDeviceRow {
    const device = this.tx.queryOne(mdevQueryOwned({ deviceId, userId }));
    if (!device) {
      throw new NotFoundError('设备不存在', ErrorCode.NOT_FOUND_DEVICE);
    }
    return device;
  }
}
