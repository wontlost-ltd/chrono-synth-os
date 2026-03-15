/**
 * SCIM Provisioning Application Service
 * 封装 SCIM 用户同步的数据访问与业务逻辑
 */

import { randomUUID } from 'node:crypto';
import type { IDatabase } from '../storage/database.js';
import type { UserRow } from '../types/auth.js';
import { StateError, ErrorCode } from '../errors/index.js';
import { IdentityService } from '../identity/identity-service.js';

function toScimUser(row: Pick<UserRow, 'id' | 'email' | 'created_at' | 'updated_at'>) {
  return {
    schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
    id: row.id,
    userName: row.email,
    active: true,
    emails: [{ value: row.email, primary: true }],
    meta: {
      resourceType: 'User',
      created: new Date(Number(row.created_at)).toISOString(),
      lastModified: new Date(Number(row.updated_at)).toISOString(),
    },
  };
}

export interface ScimListInput {
  userName?: string;
  startIndex: number;
  count: number;
}

export interface ScimCreateInput {
  email: string;
  displayName: string;
}

export class ScimProvisioningService {
  constructor(private readonly db: IDatabase) {}

  listUsers(tenantId: string, input: ScimListInput) {
    const offset = input.startIndex - 1;

    let rows: UserRow[];
    let total: number;
    if (input.userName) {
      rows = this.db.prepare<UserRow>(
        'SELECT * FROM users WHERE tenant_id = ? AND email = ? ORDER BY created_at ASC LIMIT ? OFFSET ?',
      ).all(tenantId, input.userName, input.count, offset);
      total = this.db.prepare<{ count: number }>(
        'SELECT COUNT(*) AS count FROM users WHERE tenant_id = ? AND email = ?',
      ).get(tenantId, input.userName)?.count ?? 0;
    } else {
      rows = this.db.prepare<UserRow>(
        'SELECT * FROM users WHERE tenant_id = ? ORDER BY created_at ASC LIMIT ? OFFSET ?',
      ).all(tenantId, input.count, offset);
      total = this.db.prepare<{ count: number }>(
        'SELECT COUNT(*) AS count FROM users WHERE tenant_id = ?',
      ).get(tenantId)?.count ?? 0;
    }

    return {
      schemas: ['urn:ietf:params:scim:api:messages:2.0:ListResponse'],
      totalResults: total,
      startIndex: input.startIndex,
      itemsPerPage: rows.length,
      Resources: rows.map(toScimUser),
    };
  }

  createUser(tenantId: string, input: ScimCreateInput) {
    const existing = this.db.prepare<{ id: string; tenant_id: string }>(
      'SELECT id, tenant_id FROM users WHERE email = ? LIMIT 1',
    ).get(input.email);
    if (existing && existing.tenant_id !== tenantId) {
      throw new StateError('该邮箱已存在于其他 tenant，无法通过 SCIM 导入', ErrorCode.STATE_INVALID_TRANSITION);
    }

    const now = Date.now();
    const userId = existing?.id ?? `user_${randomUUID()}`;
    const identityService = new IdentityService(this.db);
    if (!existing) {
      this.db.prepare<void>(
        `INSERT INTO users (id, email, password_hash, role, tenant_id, created_at, updated_at)
         VALUES (?, ?, ?, 'member', ?, ?, ?)`,
      ).run(userId, input.email, 'scim-managed', tenantId, now, now);
    }
    identityService.ensureForUser(userId, tenantId, input.displayName);

    const row = this.db.prepare<UserRow>('SELECT * FROM users WHERE id = ? LIMIT 1').get(userId);
    return { user: toScimUser(row!), isNew: !existing };
  }

  deleteUser(tenantId: string, userId: string): boolean {
    const row = this.db.prepare<{ id: string }>(
      'SELECT id FROM users WHERE tenant_id = ? AND id = ? LIMIT 1',
    ).get(tenantId, userId);
    if (!row) return false;

    try {
      this.db.transaction(() => {
        const avatarIds = this.db.prepare<{ id: string }>(
          `SELECT a.id
           FROM avatars a
           INNER JOIN identities i ON i.id = a.identity_id
           WHERE i.user_id = ?`,
        ).all(userId).map((r) => r.id);
        for (const avatarId of avatarIds) {
          this.db.prepare<void>('DELETE FROM device_avatars WHERE avatar_id = ?').run(avatarId);
          this.db.prepare<void>('DELETE FROM avatar_autorun_runlog WHERE avatar_id = ?').run(avatarId);
          this.db.prepare<void>('DELETE FROM avatar_autorun_config WHERE avatar_id = ?').run(avatarId);
        }
        this.db.prepare<void>(
          'DELETE FROM avatars WHERE identity_id IN (SELECT id FROM identities WHERE user_id = ?)',
        ).run(userId);
        this.db.prepare<void>('DELETE FROM refresh_tokens WHERE user_id = ?').run(userId);
        this.db.prepare<void>('DELETE FROM identities WHERE user_id = ?').run(userId);
        this.db.prepare<void>('DELETE FROM users WHERE id = ? AND tenant_id = ?').run(userId, tenantId);
      });
    } catch (error) {
      throw new StateError(
        `SCIM 删除失败，用户可能仍有关联业务数据: ${error instanceof Error ? error.message : String(error)}`,
        ErrorCode.STATE_INVALID_TRANSITION,
      );
    }

    return true;
  }
}
