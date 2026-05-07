/**
 * 身份管理 SQL 执行器 — 将内核 Query/Command kind 映射到 db.prepare 调用
 */

import { registerQuery, registerCommand } from '../legacy-sync-bridge.js';
import type {
  IdentityRow,
  IdentCreateParams, IdentCreateDefaultAvatarParams, IdentUpdateParams,
} from '@chrono/kernel';
import {
  IDENT_QUERY_BY_USER, IDENT_QUERY_BY_ID, IDENT_QUERY_BY_TENANT,
  IDENT_CMD_CREATE, IDENT_CMD_CREATE_DEFAULT_AVATAR, IDENT_CMD_UPDATE,
} from '@chrono/kernel';
import type { SqlValue } from '../database.js';

export function registerIdentityExecutors(): void {
  /* ── Queries ── */

  registerQuery<IdentityRow | null, string>(IDENT_QUERY_BY_USER, (db, userId) => {
    return db.prepare<IdentityRow>(
      'SELECT * FROM identities WHERE user_id = ?',
    ).get(userId) ?? null;
  });

  registerQuery<IdentityRow | null, string>(IDENT_QUERY_BY_ID, (db, identityId) => {
    return db.prepare<IdentityRow>(
      'SELECT * FROM identities WHERE id = ?',
    ).get(identityId) ?? null;
  });

  registerQuery<IdentityRow[], string>(IDENT_QUERY_BY_TENANT, (db, tenantId) => {
    return db.prepare<IdentityRow>(
      'SELECT * FROM identities WHERE tenant_id = ? ORDER BY created_at ASC',
    ).all(tenantId);
  });

  /* ── Commands ── */

  registerCommand<IdentCreateParams>(IDENT_CMD_CREATE, (db, p) => {
    const result = db.prepare<void>(
      `INSERT INTO identities (id, user_id, tenant_id, display_name, bio, created_at, updated_at)
       VALUES (?, ?, ?, ?, NULL, ?, ?)`,
    ).run(p.identityId, p.userId, p.tenantId, p.displayName, p.now, p.now);
    return { rowsAffected: result.changes };
  });

  registerCommand<IdentCreateDefaultAvatarParams>(IDENT_CMD_CREATE_DEFAULT_AVATAR, (db, p) => {
    const result = db.prepare<void>(
      `INSERT INTO avatars (id, identity_id, label, kind, behavior_overrides, is_default, is_active, created_at, updated_at)
       VALUES (?, ?, '默认', 'general', NULL, 1, 1, ?, ?)`,
    ).run(p.avatarId, p.identityId, p.now, p.now);
    return { rowsAffected: result.changes };
  });

  registerCommand<IdentUpdateParams>(IDENT_CMD_UPDATE, (db, p) => {
    const sets: string[] = ['updated_at = ?'];
    const params: SqlValue[] = [p.now];
    if (p.displayName !== undefined) { sets.push('display_name = ?'); params.push(p.displayName); }
    if (p.bio !== undefined) { sets.push('bio = ?'); params.push(p.bio); }
    params.push(p.identityId);
    const result = db.prepare<void>(
      `UPDATE identities SET ${sets.join(', ')} WHERE id = ?`,
    ).run(...params);
    return { rowsAffected: result.changes };
  });
}
