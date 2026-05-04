/**
 * Mobile Device Application Service
 * 封装设备 CRUD 的数据访问与业务逻辑
 */

import { randomUUID } from 'node:crypto';
import type { SyncWriteUnitOfWork, MdevDeviceRow } from '@chrono/kernel';
import {
  mdevQueryByUid, mdevQueryListByUser, mdevQueryOwned,
  mdevCmdCreate, mdevCmdUpdateOnRegister, mdevCmdUpdatePushToken, mdevCmdDelete,
} from '@chrono/kernel';
import { asUow, type UowOrDb } from '../storage/uow-helpers.js';
import { registerCoreSelfExecutors } from '../storage/executors/index.js';
import { NotFoundError, ErrorCode } from '../errors/index.js';

export interface RegisterDeviceInput {
  deviceUid: string;
  platform: string;
  pushToken?: string | null;
  appVersion?: string | null;
}

export class MobileDeviceService {
  private readonly tx: SyncWriteUnitOfWork;

  constructor(uowOrDb: UowOrDb) {
    registerCoreSelfExecutors();
    this.tx = asUow(uowOrDb);
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
    const rows = this.tx.queryMany(mdevQueryListByUser(userId)) as unknown as MdevDeviceRow[];

    return rows.map(r => ({
      id: r.id,
      deviceUid: r.device_uid,
      platform: r.platform,
      pushToken: r.push_token,
      appVersion: r.app_version,
      lastSeenAt: r.last_seen_at,
      createdAt: r.created_at,
    }));
  }

  updatePushToken(deviceId: string, userId: string, pushToken: string) {
    this.requireOwnedDevice(deviceId, userId);
    this.tx.execute(mdevCmdUpdatePushToken({ deviceId, pushToken, now: Date.now() }));
    return { id: deviceId, pushToken, updated: true };
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
