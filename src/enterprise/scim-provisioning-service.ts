/**
 * SCIM Provisioning Application Service
 * 封装 SCIM 用户同步的数据访问与业务逻辑
 */

import { randomUUID } from 'node:crypto';
import type { SyncWriteUnitOfWork, ScimUserRow, ScimAvatarIdRow } from '@chrono/kernel';
import {
  scimQueryUsers, scimQueryUsersByEmail,
  scimQueryUserCount, scimQueryUserCountByEmail,
  scimQueryUserByEmailGlobal, scimQueryUserById,
  scimQueryUserExists, scimQueryAvatarIdsByUser,
  scimCmdCreateUser, scimCmdDeleteDeviceAvatars,
  scimCmdDeleteAutorunRunlog, scimCmdDeleteAutorunConfig,
  scimCmdDeleteAvatarsByIdentity, scimCmdDeleteRefreshTokens,
  scimCmdDeleteIdentities, scimCmdDeleteUser,
} from '@chrono/kernel';
import type { IDatabase } from '../storage/database.js';
import { directUnitOfWork } from '../storage/direct-uow-adapter.js';
import { registerCoreSelfExecutors } from '../storage/executors/index.js';
import { StateError, ErrorCode } from '../errors/index.js';
import { IdentityService } from '../identity/identity-service.js';

function toScimUser(row: Pick<ScimUserRow, 'id' | 'email' | 'created_at' | 'updated_at'>) {
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
  private readonly tx: SyncWriteUnitOfWork;

  constructor(private readonly db: IDatabase) {
    registerCoreSelfExecutors();
    this.tx = directUnitOfWork(db);
  }

  listUsers(tenantId: string, input: ScimListInput) {
    const offset = input.startIndex - 1;

    let rows: ScimUserRow[];
    let total: number;
    if (input.userName) {
      rows = this.tx.queryMany(scimQueryUsersByEmail({ tenantId, email: input.userName, count: input.count, offset })) as unknown as ScimUserRow[];
      total = this.tx.queryOne(scimQueryUserCountByEmail({ tenantId, email: input.userName }))?.count ?? 0;
    } else {
      rows = this.tx.queryMany(scimQueryUsers({ tenantId, count: input.count, offset })) as unknown as ScimUserRow[];
      total = this.tx.queryOne(scimQueryUserCount(tenantId))?.count ?? 0;
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
    const existing = this.tx.queryOne(scimQueryUserByEmailGlobal(input.email));
    if (existing && existing.tenant_id !== tenantId) {
      throw new StateError('该邮箱已存在于其他 tenant，无法通过 SCIM 导入', ErrorCode.STATE_INVALID_TRANSITION);
    }

    const now = Date.now();
    const userId = existing?.id ?? `user_${randomUUID()}`;
    const identityService = new IdentityService(this.db);
    if (!existing) {
      this.tx.execute(scimCmdCreateUser({ id: userId, email: input.email, tenantId, now }));
    }
    identityService.ensureForUser(userId, tenantId, input.displayName);

    const row = this.tx.queryOne(scimQueryUserById(userId));
    return { user: toScimUser(row!), isNew: !existing };
  }

  deleteUser(tenantId: string, userId: string): boolean {
    const row = this.tx.queryOne(scimQueryUserExists({ tenantId, userId }));
    if (!row) return false;

    try {
      this.db.transaction(() => {
        const avatarIds = this.tx.queryMany(scimQueryAvatarIdsByUser(userId)) as unknown as ScimAvatarIdRow[];
        for (const avatar of avatarIds) {
          this.tx.execute(scimCmdDeleteDeviceAvatars(avatar.id));
          this.tx.execute(scimCmdDeleteAutorunRunlog(avatar.id));
          this.tx.execute(scimCmdDeleteAutorunConfig(avatar.id));
        }
        this.tx.execute(scimCmdDeleteAvatarsByIdentity(userId));
        this.tx.execute(scimCmdDeleteRefreshTokens(userId));
        this.tx.execute(scimCmdDeleteIdentities(userId));
        this.tx.execute(scimCmdDeleteUser({ userId, tenantId }));
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
