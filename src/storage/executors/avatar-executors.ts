/**
 * 分身管理 SQL 执行器 — 将内核 Query/Command kind 映射到 db.prepare 调用
 */

import { registerQuery, registerCommand } from '../legacy-sync-bridge.js';
import type {
  AvatarRow,
  AvtCreateParams, AvtUpdateParams, AvtUpdateForIdentityParams,
  AvtSoftDeleteParams, AvtSoftDeleteForIdentityParams,
  AvtByIdIdentityParams,
  AvtByIdForTenantParams, AvtByIdIdentityForTenantParams, AvtByIdentityForTenantParams,
  AvtIdentityBelongsToTenantParams, AvtUpdateForTenantParams, AvtSoftDeleteForTenantParams,
} from '@chrono/kernel';
import {
  AVT_QUERY_BY_ID, AVT_QUERY_BY_ID_IDENTITY, AVT_QUERY_BY_IDENTITY,
  AVT_QUERY_DEFAULT, AVT_QUERY_COUNT_ACTIVE,
  AVT_CMD_CREATE, AVT_CMD_UPDATE, AVT_CMD_UPDATE_FOR_IDENTITY,
  AVT_CMD_SOFT_DELETE, AVT_CMD_SOFT_DELETE_FOR_IDENTITY,
  AVT_QUERY_BY_ID_FOR_TENANT, AVT_QUERY_BY_ID_IDENTITY_FOR_TENANT, AVT_QUERY_BY_IDENTITY_FOR_TENANT,
  AVT_QUERY_DEFAULT_FOR_TENANT, AVT_QUERY_COUNT_ACTIVE_FOR_TENANT, AVT_QUERY_IDENTITY_BELONGS_TO_TENANT,
  AVT_CMD_UPDATE_FOR_TENANT, AVT_CMD_SOFT_DELETE_FOR_TENANT,
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

  registerQuery<AvatarRow[], string>(AVT_QUERY_BY_IDENTITY, (db, identityId) => {
    return db.prepare<AvatarRow>(
      'SELECT * FROM avatars WHERE identity_id = ? AND is_active = 1 ORDER BY is_default DESC, created_at ASC',
    ).all(identityId);
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

  /* ── tenant-scoped 变体（父归属 JOIN identities / 子查询，Plan 1b Task 2）──
   * avatars 无 tenant_id 列，故租户约束全经父表 identities（a.identity_id → i.tenant_id）。 */

  registerQuery<AvatarRow | null, AvtByIdForTenantParams>(AVT_QUERY_BY_ID_FOR_TENANT, (db, p) => {
    return db.prepare<AvatarRow>(
      `SELECT a.* FROM avatars a
       JOIN identities i ON i.id = a.identity_id
       WHERE a.id = ? AND i.tenant_id = ? AND a.is_active = 1`,
    ).get(p.avatarId, p.tenantId) ?? null;
  });

  registerQuery<AvatarRow | null, AvtByIdIdentityForTenantParams>(AVT_QUERY_BY_ID_IDENTITY_FOR_TENANT, (db, p) => {
    return db.prepare<AvatarRow>(
      `SELECT a.* FROM avatars a
       JOIN identities i ON i.id = a.identity_id
       WHERE a.id = ? AND a.identity_id = ? AND i.tenant_id = ? AND a.is_active = 1`,
    ).get(p.avatarId, p.identityId, p.tenantId) ?? null;
  });

  registerQuery<AvatarRow[], AvtByIdentityForTenantParams>(AVT_QUERY_BY_IDENTITY_FOR_TENANT, (db, p) => {
    return db.prepare<AvatarRow>(
      `SELECT a.* FROM avatars a
       JOIN identities i ON i.id = a.identity_id
       WHERE a.identity_id = ? AND i.tenant_id = ? AND a.is_active = 1
       ORDER BY a.is_default DESC, a.created_at ASC`,
    ).all(p.identityId, p.tenantId);
  });

  registerQuery<AvatarRow | null, AvtByIdentityForTenantParams>(AVT_QUERY_DEFAULT_FOR_TENANT, (db, p) => {
    return db.prepare<AvatarRow>(
      `SELECT a.* FROM avatars a
       JOIN identities i ON i.id = a.identity_id
       WHERE a.identity_id = ? AND i.tenant_id = ? AND a.is_default = 1 AND a.is_active = 1`,
    ).get(p.identityId, p.tenantId) ?? null;
  });

  registerQuery<{ count: number } | null, AvtByIdentityForTenantParams>(AVT_QUERY_COUNT_ACTIVE_FOR_TENANT, (db, p) => {
    return db.prepare<{ count: number }>(
      `SELECT COUNT(*) as count FROM avatars a
       JOIN identities i ON i.id = a.identity_id
       WHERE a.identity_id = ? AND i.tenant_id = ? AND a.is_active = 1`,
    ).get(p.identityId, p.tenantId) ?? null;
  });

  /* 父归属探针：identity 是否属于该租户（create 前置校验 + DeviceAvatar avatar 端验）。 */
  registerQuery<{ id: string } | null, AvtIdentityBelongsToTenantParams>(AVT_QUERY_IDENTITY_BELONGS_TO_TENANT, (db, p) => {
    return db.prepare<{ id: string }>(
      'SELECT id FROM identities WHERE id = ? AND tenant_id = ?',
    ).get(p.identityId, p.tenantId) ?? null;
  });

  registerCommand<AvtUpdateForTenantParams>(AVT_CMD_UPDATE_FOR_TENANT, (db, p) => {
    const sets: string[] = ['updated_at = ?'];
    const params: SqlValue[] = [p.now];
    if (p.label !== undefined) { sets.push('label = ?'); params.push(p.label); }
    if (p.kind !== undefined) { sets.push('kind = ?'); params.push(p.kind); }
    if (p.behaviorOverrides !== undefined) { sets.push('behavior_overrides = ?'); params.push(p.behaviorOverrides); }
    params.push(p.avatarId, p.tenantId);
    /* 父归属子查询：identity_id 须属于该租户，否则不命中（防跨租户改）。 */
    const result = db.prepare<void>(
      `UPDATE avatars SET ${sets.join(', ')}
       WHERE id = ? AND is_active = 1
         AND identity_id IN (SELECT id FROM identities WHERE tenant_id = ?)`,
    ).run(...params);
    return { rowsAffected: result.changes };
  });

  registerCommand<AvtSoftDeleteForTenantParams>(AVT_CMD_SOFT_DELETE_FOR_TENANT, (db, p) => {
    /* 父归属子查询：identity_id 须属于该租户，否则不命中（防跨租户删）。默认分身不可删。 */
    const result = db.prepare<void>(
      `UPDATE avatars SET is_active = 0, updated_at = ?
       WHERE id = ? AND is_default = 0 AND is_active = 1
         AND identity_id IN (SELECT id FROM identities WHERE tenant_id = ?)`,
    ).run(p.now, p.avatarId, p.tenantId);
    return { rowsAffected: result.changes };
  });
}
