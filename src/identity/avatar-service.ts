/**
 * 分身管理服务
 * CRUD + 配额检查 + 软删除
 */

import type { SyncWriteUnitOfWork, AvatarRow } from '@chrono/kernel';
import {
  avtQueryById, avtQueryByIdIdentity, avtQueryByIdentity,
  avtQueryDefault, avtQueryCountActive,
  avtCmdCreate, avtCmdUpdate, avtCmdUpdateForIdentity,
  avtCmdSoftDelete, avtCmdSoftDeleteForIdentity,
} from '@chrono/kernel';
import { generatePrefixedId } from '../utils/id-generator.js';
import type { Avatar, AvatarKind, BehaviorOverrides } from './types.js';
import { registerCoreSelfExecutors } from '../storage/executors/index.js';

function rowToAvatar(r: AvatarRow): Avatar {
  return {
    id: r.id,
    identityId: r.identity_id,
    label: r.label,
    kind: r.kind as AvatarKind,
    behaviorOverrides: r.behavior_overrides ? JSON.parse(r.behavior_overrides) as BehaviorOverrides : null,
    isDefault: r.is_default === 1,
    isActive: r.is_active === 1,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export class AvatarService {
  constructor(private readonly tx: SyncWriteUnitOfWork) {
    registerCoreSelfExecutors();
  }

  create(identityId: string, data: { label: string; kind?: AvatarKind; behaviorOverrides?: BehaviorOverrides }): Avatar {
    const id = generatePrefixedId('avt');
    const now = Date.now();
    const kind = data.kind ?? 'general';
    const overrides = data.behaviorOverrides ? JSON.stringify(data.behaviorOverrides) : null;

    this.tx.execute(avtCmdCreate({ id, identityId, label: data.label, kind, behaviorOverrides: overrides, now }));

    return {
      id, identityId, label: data.label, kind,
      behaviorOverrides: data.behaviorOverrides ?? null,
      isDefault: false, isActive: true, createdAt: now, updatedAt: now,
    };
  }

  getById(avatarId: string): Avatar | null {
    const row = this.tx.queryOne(avtQueryById(avatarId));
    return row ? rowToAvatar(row) : null;
  }

  getByIdForIdentity(avatarId: string, identityId: string): Avatar | null {
    const row = this.tx.queryOne(avtQueryByIdIdentity(avatarId, identityId));
    return row ? rowToAvatar(row) : null;
  }

  listByIdentity(identityId: string): Avatar[] {
    const rows = [...this.tx.queryMany(avtQueryByIdentity(identityId))] as unknown as AvatarRow[];
    return rows.map(rowToAvatar);
  }

  update(avatarId: string, data: Partial<{ label: string; kind: AvatarKind; behaviorOverrides: BehaviorOverrides }>): Avatar | null {
    const now = Date.now();
    this.tx.execute(avtCmdUpdate({
      avatarId,
      label: data.label,
      kind: data.kind,
      behaviorOverrides: data.behaviorOverrides !== undefined ? JSON.stringify(data.behaviorOverrides) : undefined,
      now,
    }));
    return this.getById(avatarId);
  }

  updateForIdentity(
    avatarId: string,
    identityId: string,
    data: Partial<{ label: string; kind: AvatarKind; behaviorOverrides: BehaviorOverrides }>,
  ): Avatar | null {
    const now = Date.now();
    this.tx.execute(avtCmdUpdateForIdentity({
      avatarId,
      identityId,
      label: data.label,
      kind: data.kind,
      behaviorOverrides: data.behaviorOverrides !== undefined ? JSON.stringify(data.behaviorOverrides) : undefined,
      now,
    }));
    return this.getByIdForIdentity(avatarId, identityId);
  }

  softDelete(avatarId: string): boolean {
    const result = this.tx.execute(avtCmdSoftDelete({ avatarId, now: Date.now() }));
    return result.rowsAffected > 0;
  }

  softDeleteForIdentity(avatarId: string, identityId: string): boolean {
    const result = this.tx.execute(avtCmdSoftDeleteForIdentity({ avatarId, identityId, now: Date.now() }));
    return result.rowsAffected > 0;
  }

  getDefault(identityId: string): Avatar | null {
    const row = this.tx.queryOne(avtQueryDefault(identityId));
    return row ? rowToAvatar(row) : null;
  }

  countActive(identityId: string): number {
    const row = this.tx.queryOne(avtQueryCountActive(identityId));
    return Number(row?.count ?? 0);
  }
}
