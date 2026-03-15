/**
 * 身份管理服务
 * 维护 User ↔ Identity (1:1) 映射；同一 tenant 可包含多个用户身份。
 * 创建身份时同时生成默认 Avatar
 */

import type { IDatabase } from '../storage/database.js';
import { generatePrefixedId } from '../utils/id-generator.js';
import type { Identity } from './types.js';
import type { SqlValue } from '../storage/database.js';

interface IdentityRow {
  readonly id: string;
  readonly user_id: string;
  readonly tenant_id: string;
  readonly display_name: string;
  readonly bio: string | null;
  readonly created_at: number;
  readonly updated_at: number;
}

function rowToIdentity(r: IdentityRow): Identity {
  return {
    id: r.id,
    userId: r.user_id,
    tenantId: r.tenant_id,
    displayName: r.display_name,
    bio: r.bio,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export class IdentityService {
  constructor(private readonly db: IDatabase) {}

  listByTenant(tenantId: string): Identity[] {
    const rows = this.db.prepare<IdentityRow>(
      'SELECT * FROM identities WHERE tenant_id = ? ORDER BY created_at ASC',
    ).all(tenantId);
    return rows.map(rowToIdentity);
  }

  getByUser(userId: string): Identity | null {
    const row = this.db.prepare<IdentityRow>(
      'SELECT * FROM identities WHERE user_id = ?',
    ).get(userId);
    return row ? rowToIdentity(row) : null;
  }

  ensureForUser(userId: string, tenantId: string, displayName: string): Identity {
    const existing = this.getByUser(userId);
    if (existing) return existing;
    return this.create(userId, tenantId, displayName);
  }

  /** 创建身份 + 默认分身（事务内） */
  create(userId: string, tenantId: string, displayName: string): Identity {
    const identityId = generatePrefixedId('ident');
    const avatarId = generatePrefixedId('avt');
    const now = Date.now();

    this.db.transaction(() => {
      this.db.prepare<void>(
        `INSERT INTO identities (id, user_id, tenant_id, display_name, bio, created_at, updated_at)
         VALUES (?, ?, ?, ?, NULL, ?, ?)`,
      ).run(identityId, userId, tenantId, displayName, now, now);

      this.db.prepare<void>(
        `INSERT INTO avatars (id, identity_id, label, kind, behavior_overrides, is_default, is_active, created_at, updated_at)
         VALUES (?, ?, '默认', 'general', NULL, 1, 1, ?, ?)`,
      ).run(avatarId, identityId, now, now);
    });

    return { id: identityId, userId, tenantId, displayName, bio: null, createdAt: now, updatedAt: now };
  }

  update(identityId: string, data: { displayName?: string; bio?: string }): Identity | null {
    const now = Date.now();
    const sets: string[] = ['updated_at = ?'];
    const params: SqlValue[] = [now];

    if (data.displayName !== undefined) {
      sets.push('display_name = ?');
      params.push(data.displayName);
    }
    if (data.bio !== undefined) {
      sets.push('bio = ?');
      params.push(data.bio);
    }
    params.push(identityId);

    this.db.prepare<void>(
      `UPDATE identities SET ${sets.join(', ')} WHERE id = ?`,
    ).run(...params);

    const row = this.db.prepare<IdentityRow>(
      'SELECT * FROM identities WHERE id = ?',
    ).get(identityId);
    return row ? rowToIdentity(row) : null;
  }
}
