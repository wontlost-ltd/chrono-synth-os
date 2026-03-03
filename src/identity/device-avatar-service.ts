/**
 * 设备-分身绑定服务
 * 管理 Avatar 在设备上的安装、卸载和激活切换
 */

import type { IDatabase } from '../storage/database.js';
import { generatePrefixedId } from '../utils/id-generator.js';
import type { Avatar, DeviceAvatar } from './types.js';
import { AvatarService } from './avatar-service.js';

interface DeviceAvatarRow {
  readonly id: string;
  readonly device_id: string;
  readonly avatar_id: string;
  readonly is_active: number;
  readonly installed_at: number;
}

export class DeviceAvatarService {
  private readonly avatarService: AvatarService;

  constructor(private readonly db: IDatabase) {
    this.avatarService = new AvatarService(db);
  }

  install(deviceId: string, avatarId: string): DeviceAvatar {
    const id = generatePrefixedId('da');
    const now = Date.now();

    this.db.prepare<void>(
      `INSERT INTO device_avatars (id, device_id, avatar_id, is_active, installed_at)
       VALUES (?, ?, ?, 0, ?)
       ON CONFLICT(device_id, avatar_id) DO UPDATE SET is_active = 0, installed_at = excluded.installed_at`,
    ).run(id, deviceId, avatarId, now);

    return { id, deviceId, avatarId, isActive: false, installedAt: now };
  }

  uninstall(deviceId: string, avatarId: string): boolean {
    const result = this.db.prepare<void>(
      'DELETE FROM device_avatars WHERE device_id = ? AND avatar_id = ?',
    ).run(deviceId, avatarId);
    return result.changes > 0;
  }

  /** 设置活跃分身（同一设备仅一个活跃） */
  activate(deviceId: string, avatarId: string): boolean {
    let ok = false;
    this.db.transaction(() => {
      this.db.prepare<void>(
        'UPDATE device_avatars SET is_active = 0 WHERE device_id = ?',
      ).run(deviceId);
      const result = this.db.prepare<void>(
        'UPDATE device_avatars SET is_active = 1 WHERE device_id = ? AND avatar_id = ?',
      ).run(deviceId, avatarId);
      ok = result.changes > 0;
    });
    return ok;
  }

  getActive(deviceId: string): Avatar | null {
    const row = this.db.prepare<DeviceAvatarRow>(
      'SELECT * FROM device_avatars WHERE device_id = ? AND is_active = 1',
    ).get(deviceId);
    if (!row) return null;
    return this.avatarService.getById(row.avatar_id);
  }

  listByDevice(deviceId: string): Avatar[] {
    const rows = this.db.prepare<DeviceAvatarRow>(
      'SELECT * FROM device_avatars WHERE device_id = ? ORDER BY installed_at DESC',
    ).all(deviceId);
    const avatars: Avatar[] = [];
    for (const row of rows) {
      const avatar = this.avatarService.getById(row.avatar_id);
      if (avatar) avatars.push(avatar);
    }
    return avatars;
  }

  isInstalled(deviceId: string, avatarId: string): boolean {
    const row = this.db.prepare<DeviceAvatarRow>(
      'SELECT id FROM device_avatars WHERE device_id = ? AND avatar_id = ?',
    ).get(deviceId, avatarId);
    return !!row;
  }
}
