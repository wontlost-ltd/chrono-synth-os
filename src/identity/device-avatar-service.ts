/**
 * 设备-分身绑定服务
 * 管理 Avatar 在设备上的安装、卸载和激活切换
 */

import type { SyncWriteUnitOfWork, DavtRow } from '@chrono/kernel';
import {
  davtQueryActive, davtQueryListByDevice, davtQueryIsInstalled,
  davtCmdInstall, davtCmdUninstall, davtCmdDeactivateAll, davtCmdActivate,
} from '@chrono/kernel';
import type { IDatabase } from '../storage/database.js';
import { asUow, unwrapDb, type UowOrDb } from '../storage/uow-helpers.js';
import { registerCoreSelfExecutors } from '../storage/executors/index.js';
import { generatePrefixedId } from '../utils/id-generator.js';
import type { Avatar, DeviceAvatar } from './types.js';
import { AvatarService } from './avatar-service.js';

export class DeviceAvatarService {
  private readonly avatarService: AvatarService;
  private readonly tx: SyncWriteUnitOfWork;
  private readonly db: IDatabase | null;

  constructor(uowOrDb: UowOrDb) {
    registerCoreSelfExecutors();
    this.tx = asUow(uowOrDb);
    this.db = unwrapDb(uowOrDb);
    this.avatarService = new AvatarService(uowOrDb);
  }

  private runAtomic<T>(fn: () => T): T {
    if (this.db) return this.db.transaction(fn);
    return fn();
  }

  install(deviceId: string, avatarId: string): DeviceAvatar {
    const id = generatePrefixedId('da');
    const now = Date.now();

    this.tx.execute(davtCmdInstall({ id, deviceId, avatarId, now }));

    return { id, deviceId, avatarId, isActive: false, installedAt: now };
  }

  uninstall(deviceId: string, avatarId: string): boolean {
    const result = this.tx.execute(davtCmdUninstall({ deviceId, avatarId }));
    return result.rowsAffected > 0;
  }

  /** 设置活跃分身（同一设备仅一个活跃） */
  activate(deviceId: string, avatarId: string): boolean {
    let ok = false;
    this.runAtomic(() => {
      this.tx.execute(davtCmdDeactivateAll(deviceId));
      const result = this.tx.execute(davtCmdActivate({ deviceId, avatarId }));
      ok = result.rowsAffected > 0;
    });
    return ok;
  }

  getActive(deviceId: string): Avatar | null {
    const row = this.tx.queryOne(davtQueryActive(deviceId));
    if (!row) return null;
    return this.avatarService.getById(row.avatar_id);
  }

  listByDevice(deviceId: string): Avatar[] {
    const rows = this.tx.queryMany(davtQueryListByDevice(deviceId)) as unknown as DavtRow[];
    const avatars: Avatar[] = [];
    for (const row of rows) {
      const avatar = this.avatarService.getById(row.avatar_id);
      if (avatar) avatars.push(avatar);
    }
    return avatars;
  }

  isInstalled(deviceId: string, avatarId: string): boolean {
    const row = this.tx.queryOne(davtQueryIsInstalled({ deviceId, avatarId }));
    return !!row;
  }
}
