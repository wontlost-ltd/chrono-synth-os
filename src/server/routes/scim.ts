import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { IDatabase } from '../../storage/database.js';
import type { AppConfig } from '../../config/schema.js';
import type { UserRow } from '../../types/auth.js';
import { AuthenticationError, ErrorCode, StateError, ValidationError } from '../../errors/index.js';
import { IdentityService } from '../../identity/identity-service.js';
import { ScimCreateUserSchema } from '../schemas/api-schemas.js';
import { TenantEnterpriseProfileService } from '../../enterprise/tenant-enterprise-profile-service.js';

function getScimBearerToken(headers: { authorization?: string }): string {
  const value = headers.authorization;
  if (!value?.startsWith('Bearer ')) {
    throw new AuthenticationError('SCIM Bearer token 缺失', ErrorCode.AUTH_INVALID_TOKEN);
  }
  return value.slice('Bearer '.length).trim();
}

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

function parseScimFilter(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const match = /^userName\s+eq\s+"([^"]+)"$/i.exec(raw.trim());
  return match?.[1];
}

export function registerScimRoutes(app: FastifyInstance, db: IDatabase, config: AppConfig): void {
  const profileService = new TenantEnterpriseProfileService(db, config);

  async function resolveTenantId(authHeader: string | undefined): Promise<string> {
    const token = getScimBearerToken({ authorization: authHeader });
    const principal = profileService.resolveScimTenant(token);
    if (!principal) {
      throw new AuthenticationError('SCIM token 无效', ErrorCode.AUTH_INVALID_TOKEN);
    }
    return principal.tenantId;
  }

  app.get('/scim/v2/Users', async (request) => {
    const tenantId = await resolveTenantId(request.headers.authorization);
    const query = request.query as { filter?: string; startIndex?: string; count?: string };
    const userName = parseScimFilter(query.filter);
    const startIndex = Math.max(parseInt(query.startIndex ?? '1', 10) || 1, 1);
    const count = Math.min(Math.max(parseInt(query.count ?? '100', 10) || 100, 1), 100);
    const offset = startIndex - 1;

    let rows: UserRow[];
    let total: number;
    if (userName) {
      rows = db.prepare<UserRow>(
        'SELECT * FROM users WHERE tenant_id = ? AND email = ? ORDER BY created_at ASC LIMIT ? OFFSET ?',
      ).all(tenantId, userName, count, offset);
      total = db.prepare<{ count: number }>(
        'SELECT COUNT(*) AS count FROM users WHERE tenant_id = ? AND email = ?',
      ).get(tenantId, userName)?.count ?? 0;
    } else {
      rows = db.prepare<UserRow>(
        'SELECT * FROM users WHERE tenant_id = ? ORDER BY created_at ASC LIMIT ? OFFSET ?',
      ).all(tenantId, count, offset);
      total = db.prepare<{ count: number }>(
        'SELECT COUNT(*) AS count FROM users WHERE tenant_id = ?',
      ).get(tenantId)?.count ?? 0;
    }

    return {
      schemas: ['urn:ietf:params:scim:api:messages:2.0:ListResponse'],
      totalResults: total,
      startIndex,
      itemsPerPage: rows.length,
      Resources: rows.map(toScimUser),
    };
  });

  app.post('/scim/v2/Users', async (request, reply) => {
    const tenantId = await resolveTenantId(request.headers.authorization);
    const payload = ScimCreateUserSchema.parse(request.body);
    const email = payload.userName || payload.emails?.find((item) => item.primary)?.value || payload.emails?.[0]?.value;
    if (!email) {
      throw new ValidationError('SCIM userName/email 缺失', ErrorCode.VALIDATION_REQUIRED);
    }
    if (!payload.active) {
      throw new ValidationError('当前 SCIM 实现仅接受 active=true 的用户创建', ErrorCode.VALIDATION_FORMAT);
    }

    const existing = db.prepare<{ id: string; tenant_id: string }>(
      'SELECT id, tenant_id FROM users WHERE email = ? LIMIT 1',
    ).get(email);
    if (existing && existing.tenant_id !== tenantId) {
      throw new StateError('该邮箱已存在于其他 tenant，无法通过 SCIM 导入', ErrorCode.STATE_INVALID_TRANSITION);
    }

    const now = Date.now();
    const userId = existing?.id ?? `user_${randomUUID()}`;
    const identityService = new IdentityService(db);
    if (!existing) {
      db.prepare<void>(
        `INSERT INTO users (id, email, password_hash, role, tenant_id, created_at, updated_at)
         VALUES (?, ?, ?, 'member', ?, ?, ?)`,
      ).run(userId, email, 'scim-managed', tenantId, now, now);
    }
    identityService.ensureForUser(userId, tenantId, payload.name?.formatted || email.split('@')[0]);

    const row = db.prepare<UserRow>('SELECT * FROM users WHERE id = ? LIMIT 1').get(userId);
    return reply.status(existing ? 200 : 201).send(toScimUser(row!));
  });

  app.delete<{ Params: { id: string } }>('/scim/v2/Users/:id', async (request, reply) => {
    const tenantId = await resolveTenantId(request.headers.authorization);
    const row = db.prepare<{ id: string }>(
      'SELECT id FROM users WHERE tenant_id = ? AND id = ? LIMIT 1',
    ).get(tenantId, request.params.id);
    if (!row) {
      return reply.status(404).send({
        schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'],
        status: '404',
        detail: 'User not found',
      });
    }

    try {
      db.transaction(() => {
        const avatarIds = db.prepare<{ id: string }>(
          `SELECT a.id
           FROM avatars a
           INNER JOIN identities i ON i.id = a.identity_id
           WHERE i.user_id = ?`,
        ).all(request.params.id).map((row) => row.id);
        for (const avatarId of avatarIds) {
          db.prepare<void>('DELETE FROM device_avatars WHERE avatar_id = ?').run(avatarId);
          db.prepare<void>('DELETE FROM avatar_autorun_runlog WHERE avatar_id = ?').run(avatarId);
          db.prepare<void>('DELETE FROM avatar_autorun_config WHERE avatar_id = ?').run(avatarId);
        }
        db.prepare<void>(
          'DELETE FROM avatars WHERE identity_id IN (SELECT id FROM identities WHERE user_id = ?)',
        ).run(request.params.id);
        db.prepare<void>('DELETE FROM refresh_tokens WHERE user_id = ?').run(request.params.id);
        db.prepare<void>('DELETE FROM identities WHERE user_id = ?').run(request.params.id);
        db.prepare<void>('DELETE FROM users WHERE id = ? AND tenant_id = ?').run(request.params.id, tenantId);
      });
    } catch (error) {
      throw new StateError(
        `SCIM 删除失败，用户可能仍有关联业务数据: ${error instanceof Error ? error.message : String(error)}`,
        ErrorCode.STATE_INVALID_TRANSITION,
      );
    }

    return reply.status(204).send();
  });
}
