/**
 * 设备-分身绑定服务
 * 管理 Avatar 在设备上的安装、卸载和激活切换
 *
 * 分片 Phase 0 · Plan 1b（Task 2 Avatar 组）：
 * device_avatars **无 tenant_id 列**（只 device_id/avatar_id）→ link 两端归属分别经父表验：
 * - device 端：`devices.tenant_id`；
 * - avatar 端：`avatars.identity_id → identities.tenant_id`（经 identity 父归属）。
 * install/uninstall/activate/getActive/listByDevice/isInstalled 首参加 `tenantId`，写路径前先跑两端 belongs 探针（防跨租户 link）。
 * ctor 收 `TenantDbResolver`；`txFor(tenantId)` 现取该租户 shard 的 tx；avatar 端读经 tenant-bound `AvatarWriter`。
 */

import type { SyncWriteUnitOfWork } from '@chrono/kernel';
import {
  davtQueryActive, davtQueryListByDevice, davtQueryIsInstalled,
  davtQueryDeviceBelongsToTenant, davtQueryAvatarBelongsToTenant,
  davtCmdInstall, davtCmdUninstall, davtCmdDeactivateAll, davtCmdActivate,
} from '@chrono/kernel';
import type { TenantDbResolver } from '../storage/tenant-db-resolver.js';
import { registerCoreSelfExecutors } from '../storage/executors/index.js';
import { generatePrefixedId } from '../utils/id-generator.js';
import { NotFoundError, ErrorCode } from '../errors/index.js';
import type { Avatar, DeviceAvatar } from './types.js';
import { AvatarWriter } from './avatar-service.js';

export class DeviceAvatarService {
  constructor(private readonly resolver: TenantDbResolver) {
    registerCoreSelfExecutors();
  }

  private txFor(tenantId: string): SyncWriteUnitOfWork {
    return this.resolver.dbForTenant(tenantId);
  }

  /** device 端归属校验：device 须属于该租户（devices.tenant_id）。 */
  private requireOwnedDevice(tx: SyncWriteUnitOfWork, tenantId: string, deviceId: string): void {
    if (tx.queryOne(davtQueryDeviceBelongsToTenant(tenantId, deviceId)) === null) {
      throw new NotFoundError(`设备 ${deviceId} 不存在或不属于当前租户`, ErrorCode.NOT_FOUND_DEVICE);
    }
  }

  /** avatar 端归属校验：avatar 经 identity 父归属须属于该租户。 */
  private requireOwnedAvatar(tx: SyncWriteUnitOfWork, tenantId: string, avatarId: string): void {
    if (tx.queryOne(davtQueryAvatarBelongsToTenant(tenantId, avatarId)) === null) {
      throw new NotFoundError(`分身 ${avatarId} 不存在或不属于当前租户`, ErrorCode.NOT_FOUND_AVATAR);
    }
  }

  install(tenantId: string, deviceId: string, avatarId: string): DeviceAvatar {
    const tx = this.txFor(tenantId);
    /* 两端验：device 端 + avatar 端都须属于该租户（防跨租户 link）。 */
    this.requireOwnedDevice(tx, tenantId, deviceId);
    this.requireOwnedAvatar(tx, tenantId, avatarId);

    const id = generatePrefixedId('da');
    const now = Date.now();
    tx.execute(davtCmdInstall({ id, deviceId, avatarId, now }));
    return { id, deviceId, avatarId, isActive: false, installedAt: now };
  }

  uninstall(tenantId: string, deviceId: string, avatarId: string): boolean {
    const tx = this.txFor(tenantId);
    this.requireOwnedDevice(tx, tenantId, deviceId);
    this.requireOwnedAvatar(tx, tenantId, avatarId);
    const result = tx.execute(davtCmdUninstall({ deviceId, avatarId }));
    return result.rowsAffected > 0;
  }

  /** 设置活跃分身（同一设备仅一个活跃） */
  activate(tenantId: string, deviceId: string, avatarId: string): boolean {
    const tx = this.txFor(tenantId);
    this.requireOwnedDevice(tx, tenantId, deviceId);
    this.requireOwnedAvatar(tx, tenantId, avatarId);
    let ok = false;
    tx.transaction(() => {
      tx.execute(davtCmdDeactivateAll(deviceId));
      const result = tx.execute(davtCmdActivate({ deviceId, avatarId }));
      ok = result.rowsAffected > 0;
    });
    return ok;
  }

  getActive(tenantId: string, deviceId: string): Avatar | null {
    const tx = this.txFor(tenantId);
    this.requireOwnedDevice(tx, tenantId, deviceId);
    const row = tx.queryOne(davtQueryActive(deviceId));
    if (!row) return null;
    return new AvatarWriter(tenantId, tx).getById(row.avatar_id);
  }

  listByDevice(tenantId: string, deviceId: string): Avatar[] {
    const tx = this.txFor(tenantId);
    this.requireOwnedDevice(tx, tenantId, deviceId);
    const rows = tx.queryMany(davtQueryListByDevice(deviceId));
    const writer = new AvatarWriter(tenantId, tx);
    const avatars: Avatar[] = [];
    for (const row of rows) {
      const avatar = writer.getById(row.avatar_id);
      if (avatar) avatars.push(avatar);
    }
    return avatars;
  }

  isInstalled(tenantId: string, deviceId: string, avatarId: string): boolean {
    const tx = this.txFor(tenantId);
    this.requireOwnedDevice(tx, tenantId, deviceId);
    const row = tx.queryOne(davtQueryIsInstalled({ deviceId, avatarId }));
    return !!row;
  }
}
