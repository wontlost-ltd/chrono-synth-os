/**
 * 移动设备 SQL 执行器
 */

import { registerQuery, registerCommand } from '../legacy-sync-bridge.js';
import {
  MDEV_QUERY_BY_UID, MDEV_QUERY_BY_ID, MDEV_QUERY_LIST_BY_USER, MDEV_QUERY_LIST_BY_TENANT_USER, MDEV_QUERY_OWNED,
  MDEV_CMD_CREATE, MDEV_CMD_UPDATE_ON_REGISTER, MDEV_CMD_UPDATE_PUSH_TOKEN,
  MDEV_CMD_MARK_TOKEN_INVALID, MDEV_CMD_DELETE,
} from '@chrono/kernel';
import type {
  MdevDeviceRow, MdevByUidParams, MdevListByTenantUserParams, MdevOwnedParams,
  MdevCreateParams, MdevUpdateOnRegisterParams, MdevUpdatePushTokenParams,
  MdevMarkTokenInvalidParams,
} from '@chrono/kernel';

export function registerMobileDeviceExecutors(): void {
  registerQuery<MdevDeviceRow | null, MdevByUidParams>(MDEV_QUERY_BY_UID, (db, p) => {
    return db.prepare<MdevDeviceRow>(
      'SELECT * FROM devices WHERE tenant_id = ? AND user_id = ? AND device_uid = ?',
    ).get(p.tenantId, p.userId, p.deviceUid) ?? null;
  });

  registerQuery<MdevDeviceRow | null, string>(MDEV_QUERY_BY_ID, (db, deviceId) => {
    return db.prepare<MdevDeviceRow>(
      'SELECT * FROM devices WHERE id = ?',
    ).get(deviceId) ?? null;
  });

  registerQuery<readonly MdevDeviceRow[], string>(MDEV_QUERY_LIST_BY_USER, (db, userId) => {
    return db.prepare<MdevDeviceRow>(
      'SELECT * FROM devices WHERE user_id = ? ORDER BY last_seen_at DESC',
    ).all(userId);
  });

  /* 显式 (tenant_id, user_id) 列设备——宿主 DB 上的租户隔离（listByUser 无 tenant 谓词在宿主 DB
   * 不隔离，跨租户推送风险，Codex 退回 High）。 */
  registerQuery<readonly MdevDeviceRow[], MdevListByTenantUserParams>(MDEV_QUERY_LIST_BY_TENANT_USER, (db, p) => {
    return db.prepare<MdevDeviceRow>(
      'SELECT * FROM devices WHERE tenant_id = ? AND user_id = ? ORDER BY last_seen_at DESC',
    ).all(p.tenantId, p.userId);
  });

  registerQuery<MdevDeviceRow | null, MdevOwnedParams>(MDEV_QUERY_OWNED, (db, p) => {
    return db.prepare<MdevDeviceRow>(
      'SELECT * FROM devices WHERE id = ? AND user_id = ?',
    ).get(p.deviceId, p.userId) ?? null;
  });

  registerCommand<MdevCreateParams>(MDEV_CMD_CREATE, (db, p) => {
    const result = db.prepare<void>(
      `INSERT INTO devices (id, tenant_id, user_id, device_uid, platform, push_token, app_version, last_seen_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(p.id, p.tenantId, p.userId, p.deviceUid, p.platform, p.pushToken, p.appVersion, p.now, p.now);
    return { rowsAffected: result.changes };
  });

  registerCommand<MdevUpdateOnRegisterParams>(MDEV_CMD_UPDATE_ON_REGISTER, (db, p) => {
    const result = db.prepare<void>(
      'UPDATE devices SET platform = ?, push_token = ?, app_version = ?, last_seen_at = ? WHERE id = ?',
    ).run(p.platform, p.pushToken, p.appVersion, p.now, p.deviceId);
    return { rowsAffected: result.changes };
  });

  registerCommand<MdevUpdatePushTokenParams>(MDEV_CMD_UPDATE_PUSH_TOKEN, (db, p) => {
    const result = db.prepare<void>(
      /* Re-registering a token clears any prior invalidation marker —
       * the new token is presumed valid until the next provider failure. */
      'UPDATE devices SET push_token = ?, last_seen_at = ?, is_invalid_at = NULL WHERE id = ?',
    ).run(p.pushToken, p.now, p.deviceId);
    return { rowsAffected: result.changes };
  });

  registerCommand<MdevMarkTokenInvalidParams>(MDEV_CMD_MARK_TOKEN_INVALID, (db, p) => {
    /* Idempotent: re-marking an already-invalidated row keeps the
     * earliest invalidation timestamp (COALESCE on the read side; the
     * write here only updates when the column is currently NULL,
     * preserving the historical signal). */
    const result = db.prepare<void>(
      'UPDATE devices SET is_invalid_at = COALESCE(is_invalid_at, ?) WHERE id = ?',
    ).run(p.now, p.deviceId);
    return { rowsAffected: result.changes };
  });

  registerCommand<string>(MDEV_CMD_DELETE, (db, deviceId) => {
    const result = db.prepare<void>('DELETE FROM devices WHERE id = ?').run(deviceId);
    return { rowsAffected: result.changes };
  });
}
