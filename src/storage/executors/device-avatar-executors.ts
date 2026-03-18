/**
 * 设备-分身绑定 SQL 执行器
 */

import { registerQuery, registerCommand } from '../legacy-sync-bridge.js';
import {
  DAVT_QUERY_ACTIVE, DAVT_QUERY_LIST_BY_DEVICE, DAVT_QUERY_IS_INSTALLED,
  DAVT_CMD_INSTALL, DAVT_CMD_UNINSTALL, DAVT_CMD_DEACTIVATE_ALL, DAVT_CMD_ACTIVATE,
} from '@chrono/kernel';
import type {
  DavtRow, DavtInstalledRow, DavtDeviceAvatarParams, DavtInstallParams,
} from '@chrono/kernel';

export function registerDeviceAvatarExecutors(): void {
  registerQuery<DavtRow | null, string>(DAVT_QUERY_ACTIVE, (db, deviceId) => {
    return db.prepare<DavtRow>(
      'SELECT * FROM device_avatars WHERE device_id = ? AND is_active = 1',
    ).get(deviceId) ?? null;
  });

  registerQuery<readonly DavtRow[], string>(DAVT_QUERY_LIST_BY_DEVICE, (db, deviceId) => {
    return db.prepare<DavtRow>(
      'SELECT * FROM device_avatars WHERE device_id = ? ORDER BY installed_at DESC',
    ).all(deviceId);
  });

  registerQuery<DavtInstalledRow | null, DavtDeviceAvatarParams>(DAVT_QUERY_IS_INSTALLED, (db, p) => {
    return db.prepare<DavtInstalledRow>(
      'SELECT id FROM device_avatars WHERE device_id = ? AND avatar_id = ?',
    ).get(p.deviceId, p.avatarId) ?? null;
  });

  registerCommand<DavtInstallParams>(DAVT_CMD_INSTALL, (db, p) => {
    const result = db.prepare<void>(
      `INSERT INTO device_avatars (id, device_id, avatar_id, is_active, installed_at)
       VALUES (?, ?, ?, 0, ?)
       ON CONFLICT(device_id, avatar_id) DO UPDATE SET is_active = 0, installed_at = excluded.installed_at`,
    ).run(p.id, p.deviceId, p.avatarId, p.now);
    return { rowsAffected: result.changes };
  });

  registerCommand<DavtDeviceAvatarParams>(DAVT_CMD_UNINSTALL, (db, p) => {
    const result = db.prepare<void>(
      'DELETE FROM device_avatars WHERE device_id = ? AND avatar_id = ?',
    ).run(p.deviceId, p.avatarId);
    return { rowsAffected: result.changes };
  });

  registerCommand<string>(DAVT_CMD_DEACTIVATE_ALL, (db, deviceId) => {
    const result = db.prepare<void>(
      'UPDATE device_avatars SET is_active = 0 WHERE device_id = ?',
    ).run(deviceId);
    return { rowsAffected: result.changes };
  });

  registerCommand<DavtDeviceAvatarParams>(DAVT_CMD_ACTIVATE, (db, p) => {
    const result = db.prepare<void>(
      'UPDATE device_avatars SET is_active = 1 WHERE device_id = ? AND avatar_id = ?',
    ).run(p.deviceId, p.avatarId);
    return { rowsAffected: result.changes };
  });
}
