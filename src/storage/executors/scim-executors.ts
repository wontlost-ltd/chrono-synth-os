/**
 * SCIM Provisioning SQL 执行器
 */

import { registerQuery, registerCommand } from '../legacy-sync-bridge.js';
import {
  SCIM_QUERY_USERS, SCIM_QUERY_USERS_BY_EMAIL,
  SCIM_QUERY_USER_COUNT, SCIM_QUERY_USER_COUNT_BY_EMAIL,
  SCIM_QUERY_USER_BY_EMAIL_GLOBAL, SCIM_QUERY_USER_BY_ID,
  SCIM_QUERY_USER_EXISTS, SCIM_QUERY_AVATAR_IDS_BY_USER,
  SCIM_CMD_CREATE_USER, SCIM_CMD_DELETE_DEVICE_AVATARS,
  SCIM_CMD_DELETE_AUTORUN_RUNLOG, SCIM_CMD_DELETE_AUTORUN_CONFIG,
  SCIM_CMD_DELETE_AVATARS_BY_IDENTITY, SCIM_CMD_DELETE_REFRESH_TOKENS,
  SCIM_CMD_DELETE_IDENTITIES, SCIM_CMD_DELETE_USER,
} from '@chrono/kernel';
import type {
  ScimUserRow, ScimUserCountRow, ScimUserBriefRow, ScimAvatarIdRow,
  ScimUsersParams, ScimUsersByEmailParams, ScimTenantEmailParams,
  ScimTenantIdParams, ScimCreateUserParams, ScimDeleteUserParams,
} from '@chrono/kernel';

export function registerScimExecutors(): void {
  registerQuery<readonly ScimUserRow[], ScimUsersParams>(SCIM_QUERY_USERS, (db, p) => {
    return db.prepare<ScimUserRow>(
      'SELECT * FROM users WHERE tenant_id = ? ORDER BY created_at ASC LIMIT ? OFFSET ?',
    ).all(p.tenantId, p.count, p.offset);
  });

  registerQuery<readonly ScimUserRow[], ScimUsersByEmailParams>(SCIM_QUERY_USERS_BY_EMAIL, (db, p) => {
    return db.prepare<ScimUserRow>(
      'SELECT * FROM users WHERE tenant_id = ? AND email = ? ORDER BY created_at ASC LIMIT ? OFFSET ?',
    ).all(p.tenantId, p.email, p.count, p.offset);
  });

  registerQuery<ScimUserCountRow | null, string>(SCIM_QUERY_USER_COUNT, (db, tenantId) => {
    const row = db.prepare<{ count: number | bigint }>(
      'SELECT COUNT(*) AS count FROM users WHERE tenant_id = ?',
    ).get(tenantId);
    if (!row) return null;
    return { count: Number(row.count) };
  });

  registerQuery<ScimUserCountRow | null, ScimTenantEmailParams>(SCIM_QUERY_USER_COUNT_BY_EMAIL, (db, p) => {
    const row = db.prepare<{ count: number | bigint }>(
      'SELECT COUNT(*) AS count FROM users WHERE tenant_id = ? AND email = ?',
    ).get(p.tenantId, p.email);
    if (!row) return null;
    return { count: Number(row.count) };
  });

  registerQuery<ScimUserBriefRow | null, string>(SCIM_QUERY_USER_BY_EMAIL_GLOBAL, (db, email) => {
    return db.prepare<ScimUserBriefRow>(
      'SELECT id, tenant_id FROM users WHERE email = ? LIMIT 1',
    ).get(email) ?? null;
  });

  registerQuery<ScimUserRow | null, string>(SCIM_QUERY_USER_BY_ID, (db, userId) => {
    return db.prepare<ScimUserRow>(
      'SELECT * FROM users WHERE id = ? LIMIT 1',
    ).get(userId) ?? null;
  });

  registerQuery<ScimAvatarIdRow | null, ScimTenantIdParams>(SCIM_QUERY_USER_EXISTS, (db, p) => {
    return db.prepare<ScimAvatarIdRow>(
      'SELECT id FROM users WHERE tenant_id = ? AND id = ? LIMIT 1',
    ).get(p.tenantId, p.userId) ?? null;
  });

  registerQuery<readonly ScimAvatarIdRow[], string>(SCIM_QUERY_AVATAR_IDS_BY_USER, (db, userId) => {
    return db.prepare<ScimAvatarIdRow>(
      `SELECT a.id
       FROM avatars a
       INNER JOIN identities i ON i.id = a.identity_id
       WHERE i.user_id = ?`,
    ).all(userId);
  });

  registerCommand<ScimCreateUserParams>(SCIM_CMD_CREATE_USER, (db, p) => {
    const result = db.prepare<void>(
      `INSERT INTO users (id, email, password_hash, role, tenant_id, created_at, updated_at)
       VALUES (?, ?, 'scim-managed', 'member', ?, ?, ?)`,
    ).run(p.id, p.email, p.tenantId, p.now, p.now);
    return { rowsAffected: result.changes };
  });

  registerCommand<string>(SCIM_CMD_DELETE_DEVICE_AVATARS, (db, avatarId) => {
    const result = db.prepare<void>('DELETE FROM device_avatars WHERE avatar_id = ?').run(avatarId);
    return { rowsAffected: result.changes };
  });

  registerCommand<string>(SCIM_CMD_DELETE_AUTORUN_RUNLOG, (db, avatarId) => {
    const result = db.prepare<void>('DELETE FROM avatar_autorun_runlog WHERE avatar_id = ?').run(avatarId);
    return { rowsAffected: result.changes };
  });

  registerCommand<string>(SCIM_CMD_DELETE_AUTORUN_CONFIG, (db, avatarId) => {
    const result = db.prepare<void>('DELETE FROM avatar_autorun_config WHERE avatar_id = ?').run(avatarId);
    return { rowsAffected: result.changes };
  });

  registerCommand<string>(SCIM_CMD_DELETE_AVATARS_BY_IDENTITY, (db, userId) => {
    const result = db.prepare<void>(
      'DELETE FROM avatars WHERE identity_id IN (SELECT id FROM identities WHERE user_id = ?)',
    ).run(userId);
    return { rowsAffected: result.changes };
  });

  registerCommand<string>(SCIM_CMD_DELETE_REFRESH_TOKENS, (db, userId) => {
    const result = db.prepare<void>('DELETE FROM refresh_tokens WHERE user_id = ?').run(userId);
    return { rowsAffected: result.changes };
  });

  registerCommand<string>(SCIM_CMD_DELETE_IDENTITIES, (db, userId) => {
    const result = db.prepare<void>('DELETE FROM identities WHERE user_id = ?').run(userId);
    return { rowsAffected: result.changes };
  });

  registerCommand<ScimDeleteUserParams>(SCIM_CMD_DELETE_USER, (db, p) => {
    const result = db.prepare<void>('DELETE FROM users WHERE id = ? AND tenant_id = ?').run(p.userId, p.tenantId);
    return { rowsAffected: result.changes };
  });
}
