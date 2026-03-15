/**
 * Mobile Device Application Service
 * 封装设备 CRUD 的数据访问与业务逻辑
 */

import { randomUUID } from 'node:crypto';
import type { IDatabase } from '../storage/database.js';
import { NotFoundError, ErrorCode } from '../errors/index.js';

interface DeviceRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly user_id: string;
  readonly device_uid: string;
  readonly platform: string;
  readonly push_token: string | null;
  readonly app_version: string | null;
  readonly last_seen_at: number;
  readonly created_at: number;
}

export interface RegisterDeviceInput {
  deviceUid: string;
  platform: string;
  pushToken?: string | null;
  appVersion?: string | null;
}

export class MobileDeviceService {
  constructor(private readonly db: IDatabase) {}

  register(tenantId: string, userId: string, input: RegisterDeviceInput) {
    const now = Date.now();
    const existing = this.db.prepare<DeviceRow>(
      'SELECT * FROM devices WHERE tenant_id = ? AND user_id = ? AND device_uid = ?',
    ).get(tenantId, userId, input.deviceUid);

    if (existing) {
      this.db.prepare<void>(
        'UPDATE devices SET platform = ?, push_token = ?, app_version = ?, last_seen_at = ? WHERE id = ?',
      ).run(input.platform, input.pushToken ?? null, input.appVersion ?? null, now, existing.id);
      return { id: existing.id, deviceUid: input.deviceUid, platform: input.platform, updated: true };
    }

    const id = `dev_${randomUUID()}`;
    this.db.prepare<void>(
      `INSERT INTO devices (id, tenant_id, user_id, device_uid, platform, push_token, app_version, last_seen_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, tenantId, userId, input.deviceUid, input.platform, input.pushToken ?? null, input.appVersion ?? null, now, now);
    return { id, deviceUid: input.deviceUid, platform: input.platform, updated: false };
  }

  listByUser(userId: string) {
    const rows = this.db.prepare<DeviceRow>(
      'SELECT * FROM devices WHERE user_id = ? ORDER BY last_seen_at DESC',
    ).all(userId);

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
    this.db.prepare<void>(
      'UPDATE devices SET push_token = ?, last_seen_at = ? WHERE id = ?',
    ).run(pushToken, Date.now(), deviceId);
    return { id: deviceId, pushToken, updated: true };
  }

  delete(deviceId: string, userId: string) {
    this.requireOwnedDevice(deviceId, userId);
    this.db.prepare<void>('DELETE FROM devices WHERE id = ?').run(deviceId);
  }

  requireOwnedDevice(deviceId: string, userId: string): DeviceRow {
    const device = this.db.prepare<DeviceRow>(
      'SELECT * FROM devices WHERE id = ? AND user_id = ?',
    ).get(deviceId, userId);
    if (!device) {
      throw new NotFoundError('设备不存在', ErrorCode.NOT_FOUND_DEVICE);
    }
    return device;
  }
}
