/**
 * 身份管理服务
 * 维护 User ↔ Identity (1:1) 映射；同一 tenant 可包含多个用户身份。
 * 创建身份时同时生成默认 Avatar
 */

import type { IDatabase } from '../storage/database.js';
import type { SyncWriteUnitOfWork, IdentityRow } from '@chrono/kernel';
import {
  identQueryByUser, identQueryById, identQueryByTenant,
  identCmdCreate, identCmdCreateDefaultAvatar, identCmdUpdate,
} from '@chrono/kernel';
import { generatePrefixedId } from '../utils/id-generator.js';
import type { Identity } from './types.js';
import { directUnitOfWork } from '../storage/direct-uow-adapter.js';
import { registerCoreSelfExecutors } from '../storage/executors/index.js';

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
  private readonly db: IDatabase;
  private readonly tx: SyncWriteUnitOfWork;

  constructor(db: IDatabase) {
    this.db = db;
    registerCoreSelfExecutors();
    this.tx = directUnitOfWork(db);
  }

  listByTenant(tenantId: string): Identity[] {
    const rows = [...this.tx.queryMany(identQueryByTenant(tenantId))] as unknown as IdentityRow[];
    return rows.map(rowToIdentity);
  }

  getByUser(userId: string): Identity | null {
    const row = this.tx.queryOne(identQueryByUser(userId));
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
      this.tx.execute(identCmdCreate({ identityId, userId, tenantId, displayName, now }));
      this.tx.execute(identCmdCreateDefaultAvatar({ avatarId, identityId, now }));
    });

    return { id: identityId, userId, tenantId, displayName, bio: null, createdAt: now, updatedAt: now };
  }

  update(identityId: string, data: { displayName?: string; bio?: string }): Identity | null {
    const now = Date.now();
    this.tx.execute(identCmdUpdate({
      identityId,
      displayName: data.displayName,
      bio: data.bio,
      now,
    }));

    const row = this.tx.queryOne(identQueryById(identityId));
    return row ? rowToIdentity(row) : null;
  }
}
