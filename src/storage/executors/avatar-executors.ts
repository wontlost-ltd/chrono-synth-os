/**
 * 分身管理 SQL 执行器 — 将内核 Query/Command kind 映射到 db.prepare 调用
 */

import { registerQuery, registerCommand } from '../legacy-sync-bridge.js';
import type {
  AvatarRow,
  AvtCreateParams, AvtUpdateParams, AvtUpdateForIdentityParams,
  AvtSoftDeleteParams, AvtSoftDeleteForIdentityParams,
  AvtByIdIdentityParams,
} from '@chrono/kernel';
import {
  AVT_QUERY_BY_ID, AVT_QUERY_BY_ID_IDENTITY, AVT_QUERY_BY_IDENTITY,
  AVT_QUERY_DEFAULT, AVT_QUERY_COUNT_ACTIVE,
  AVT_CMD_CREATE, AVT_CMD_UPDATE, AVT_CMD_UPDATE_FOR_IDENTITY,
  AVT_CMD_SOFT_DELETE, AVT_CMD_SOFT_DELETE_FOR_IDENTITY,
} from '@chrono/kernel';
import type { SqlValue } from '../database.js';

export function registerAvatarExecutors(): void {
  /* ── Queries ── */

  registerQuery<AvatarRow | null, string>(AVT_QUERY_BY_ID, (db, avatarId) => {
    return db.prepare<AvatarRow>(
      'SELECT * FROM avatars WHERE id = ? AND is_active = 1',
    ).get(avatarId) ?? null;
  });

  registerQuery<AvatarRow | null, AvtByIdIdentityParams>(AVT_QUERY_BY_ID_IDENTITY, (db, p) => {
    return db.prepare<AvatarRow>(
      'SELECT * FROM avatars WHERE id = ? AND identity_id = ? AND is_active = 1',
    ).get(p.avatarId, p.identityId) ?? null;
  });

  registerQuery<AvatarRow, string>(AVT_QUERY_BY_IDENTITY, (db, identityId) => {
    return db.prepare<AvatarRow>(
      'SELECT * FROM avatars WHERE identity_id = ? AND is_active = 1 ORDER BY is_default DESC, created_at ASC',
    ).all(identityId) as unknown as AvatarRow;
  });

  registerQuery<AvatarRow | null, string>(AVT_QUERY_DEFAULT, (db, identityId) => {
    return db.prepare<AvatarRow>(
      'SELECT * FROM avatars WHERE identity_id = ? AND is_default = 1 AND is_active = 1',
    ).get(identityId) ?? null;
  });

  registerQuery<{ count: number } | null, string>(AVT_QUERY_COUNT_ACTIVE, (db, identityId) => {
    return db.prepare<{ count: number }>(
      'SELECT COUNT(*) as count FROM avatars WHERE identity_id = ? AND is_active = 1',
    ).get(identityId) ?? null;
  });

  /* ── Commands ── */

  registerCommand<AvtCreateParams>(AVT_CMD_CREATE, (db, p) => {
    const result = db.prepare<void>(
      `INSERT INTO avatars (id, identity_id, label, kind, behavior_overrides, is_default, is_active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 0, 1, ?, ?)`,
    ).run(p.id, p.identityId, p.label, p.kind, p.behaviorOverrides, p.now, p.now);
    return { rowsAffected: result.changes };
  });

  registerCommand<AvtUpdateParams>(AVT_CMD_UPDATE, (db, p) => {
    const sets: string[] = ['updated_at = ?'];
    const params: SqlValue[] = [p.now];
    if (p.label !== undefined) { sets.push('label = ?'); params.push(p.label); }
    if (p.kind !== undefined) { sets.push('kind = ?'); params.push(p.kind); }
    if (p.behaviorOverrides !== undefined) { sets.push('behavior_overrides = ?'); params.push(p.behaviorOverrides); }
    params.push(p.avatarId);
    const result = db.prepare<void>(
      `UPDATE avatars SET ${sets.join(', ')} WHERE id = ? AND is_active = 1`,
    ).run(...params);
    return { rowsAffected: result.changes };
  });

  registerCommand<AvtUpdateForIdentityParams>(AVT_CMD_UPDATE_FOR_IDENTITY, (db, p) => {
    const sets: string[] = ['updated_at = ?'];
    const params: SqlValue[] = [p.now];
    if (p.label !== undefined) { sets.push('label = ?'); params.push(p.label); }
    if (p.kind !== undefined) { sets.push('kind = ?'); params.push(p.kind); }
    if (p.behaviorOverrides !== undefined) { sets.push('behavior_overrides = ?'); params.push(p.behaviorOverrides); }
    params.push(p.avatarId, p.identityId);
    const result = db.prepare<void>(
      `UPDATE avatars SET ${sets.join(', ')} WHERE id = ? AND identity_id = ? AND is_active = 1`,
    ).run(...params);
    return { rowsAffected: result.changes };
  });

  registerCommand<AvtSoftDeleteParams>(AVT_CMD_SOFT_DELETE, (db, p) => {
    const result = db.prepare<void>(
      'UPDATE avatars SET is_active = 0, updated_at = ? WHERE id = ? AND is_default = 0 AND is_active = 1',
    ).run(p.now, p.avatarId);
    return { rowsAffected: result.changes };
  });

  registerCommand<AvtSoftDeleteForIdentityParams>(AVT_CMD_SOFT_DELETE_FOR_IDENTITY, (db, p) => {
    const result = db.prepare<void>(
      'UPDATE avatars SET is_active = 0, updated_at = ? WHERE id = ? AND identity_id = ? AND is_default = 0 AND is_active = 1',
    ).run(p.now, p.avatarId, p.identityId);
    return { rowsAffected: result.changes };
  });
}
