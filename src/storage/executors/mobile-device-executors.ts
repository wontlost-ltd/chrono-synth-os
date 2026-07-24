/**
 * 移动设备 SQL 执行器
 */

import { registerQuery, registerCommand } from '../legacy-sync-bridge.js';
import {
  MDEV_QUERY_BY_UID, MDEV_QUERY_BY_ID, MDEV_QUERY_LIST_BY_TENANT_USER, MDEV_QUERY_OWNED,
  MDEV_CMD_CREATE, MDEV_CMD_UPDATE_ON_REGISTER, MDEV_CMD_UPDATE_PUSH_TOKEN,
  MDEV_CMD_MARK_TOKEN_INVALID, MDEV_CMD_DELETE,
} from '@chrono/kernel';
import type {
  MdevDeviceRow, MdevByUidParams, MdevByIdParams, MdevListByTenantUserParams, MdevOwnedParams,
  MdevCreateParams, MdevUpdateOnRegisterParams, MdevUpdatePushTokenParams,
  MdevMarkTokenInvalidParams, MdevDeleteParams,
} from '@chrono/kernel';

export function registerMobileDeviceExecutors(): void {
  registerQuery<MdevDeviceRow | null, MdevByUidParams>(MDEV_QUERY_BY_UID, (db, p) => {
    return db.prepare<MdevDeviceRow>(
      'SELECT * FROM devices WHERE tenant_id = ? AND user_id = ? AND device_uid = ?',
    ).get(p.tenantId, p.userId, p.deviceUid) ?? null;
  });

  /* 分片 Plan 1b（Task 3）：按主键查询带 tenant predicate（WHERE tenant_id=? AND id=?）——
   * 选对 shard + 同库跨租户隔离。 */
  registerQuery<MdevDeviceRow | null, MdevByIdParams>(MDEV_QUERY_BY_ID, (db, p) => {
    return db.prepare<MdevDeviceRow>(
      'SELECT * FROM devices WHERE tenant_id = ? AND id = ?',
    ).get(p.tenantId, p.deviceId) ?? null;
  });

  /* 显式 (tenant_id, user_id) 列设备——devices 表有 tenant_id 列，直接租户隔离。 */
  registerQuery<readonly MdevDeviceRow[], MdevListByTenantUserParams>(MDEV_QUERY_LIST_BY_TENANT_USER, (db, p) => {
    return db.prepare<MdevDeviceRow>(
      'SELECT * FROM devices WHERE tenant_id = ? AND user_id = ? ORDER BY last_seen_at DESC',
    ).all(p.tenantId, p.userId);
  });

  registerQuery<MdevDeviceRow | null, MdevOwnedParams>(MDEV_QUERY_OWNED, (db, p) => {
    return db.prepare<MdevDeviceRow>(
      'SELECT * FROM devices WHERE tenant_id = ? AND id = ? AND user_id = ?',
    ).get(p.tenantId, p.deviceId, p.userId) ?? null;
  });

  registerCommand<MdevCreateParams>(MDEV_CMD_CREATE, (db, p) => {
    const result = db.prepare<void>(
      `INSERT INTO devices (id, tenant_id, user_id, device_uid, platform, push_token, app_version, last_seen_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(p.id, p.tenantId, p.userId, p.deviceUid, p.platform, p.pushToken, p.appVersion, p.now, p.now);
    return { rowsAffected: result.changes };
  });

  registerCommand<MdevUpdateOnRegisterParams>(MDEV_CMD_UPDATE_ON_REGISTER, (db, p) => {
    /* 携带新 push_token 的重注册清除失效标记——新 token 在下次 provider 失败前推定有效
     * （与 MDEV_CMD_UPDATE_PUSH_TOKEN 同语义）。移动端现把 /api/v1/devices 注册作为 push token
     * 注册路径（usePushSync），若此处不清 is_invalid_at，token 失效后重注册新 token 仍被 dispatcher
     * 当失效跳过 → push 永久不可用。仅当本次带非空 pushToken 时清；纯元数据重注册（pushToken=null）
     * 不动失效标记。 */
    /* 分片 Plan 1b（Task 3）：带 tenant predicate（WHERE tenant_id=? AND id=?）防同库跨租户误改。 */
    const result = db.prepare<void>(
      `UPDATE devices SET platform = ?, push_token = ?, app_version = ?, last_seen_at = ?,
         is_invalid_at = CASE WHEN ? IS NOT NULL THEN NULL ELSE is_invalid_at END
       WHERE tenant_id = ? AND id = ?`,
    ).run(p.platform, p.pushToken, p.appVersion, p.now, p.pushToken, p.tenantId, p.deviceId);
    return { rowsAffected: result.changes };
  });

  registerCommand<MdevUpdatePushTokenParams>(MDEV_CMD_UPDATE_PUSH_TOKEN, (db, p) => {
    const result = db.prepare<void>(
      /* Re-registering a token clears any prior invalidation marker —
       * the new token is presumed valid until the next provider failure.
       * 分片 Plan 1b（Task 3）：带 tenant predicate 防同库跨租户误改。 */
      'UPDATE devices SET push_token = ?, last_seen_at = ?, is_invalid_at = NULL WHERE tenant_id = ? AND id = ?',
    ).run(p.pushToken, p.now, p.tenantId, p.deviceId);
    return { rowsAffected: result.changes };
  });

  registerCommand<MdevMarkTokenInvalidParams>(MDEV_CMD_MARK_TOKEN_INVALID, (db, p) => {
    /* Idempotent: re-marking an already-invalidated row keeps the
     * earliest invalidation timestamp (COALESCE on the read side; the
     * write here only updates when the column is currently NULL,
     * preserving the historical signal).
     * 分片 Plan 1b（Task 3）：带 tenant predicate 防同库跨租户误标。 */
    const result = db.prepare<void>(
      'UPDATE devices SET is_invalid_at = COALESCE(is_invalid_at, ?) WHERE tenant_id = ? AND id = ?',
    ).run(p.now, p.tenantId, p.deviceId);
    return { rowsAffected: result.changes };
  });

  registerCommand<MdevDeleteParams>(MDEV_CMD_DELETE, (db, p) => {
    /* 分片 Plan 1b（Task 3）：带 tenant predicate 防同库跨租户误删。 */
    const result = db.prepare<void>('DELETE FROM devices WHERE tenant_id = ? AND id = ?').run(p.tenantId, p.deviceId);
    return { rowsAffected: result.changes };
  });
}
