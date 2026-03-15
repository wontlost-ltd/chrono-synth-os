/**
 * 分身管理服务
 * CRUD + 配额检查 + 软删除
 */

import type { IDatabase } from '../storage/database.js';
import { generatePrefixedId } from '../utils/id-generator.js';
import type { Avatar, AvatarKind, BehaviorOverrides } from './types.js';
import type { SqlValue } from '../storage/database.js';

interface AvatarRow {
  readonly id: string;
  readonly identity_id: string;
  readonly label: string;
  readonly kind: string;
  readonly behavior_overrides: string | null;
  readonly is_default: number;
  readonly is_active: number;
  readonly created_at: number;
  readonly updated_at: number;
}

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
  constructor(private readonly db: IDatabase) {}

  create(identityId: string, data: { label: string; kind?: AvatarKind; behaviorOverrides?: BehaviorOverrides }): Avatar {
    const id = generatePrefixedId('avt');
    const now = Date.now();
    const kind = data.kind ?? 'general';
    const overrides = data.behaviorOverrides ? JSON.stringify(data.behaviorOverrides) : null;

    this.db.prepare<void>(
      `INSERT INTO avatars (id, identity_id, label, kind, behavior_overrides, is_default, is_active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 0, 1, ?, ?)`,
    ).run(id, identityId, data.label, kind, overrides, now, now);

    return {
      id, identityId, label: data.label, kind,
      behaviorOverrides: data.behaviorOverrides ?? null,
      isDefault: false, isActive: true, createdAt: now, updatedAt: now,
    };
  }

  getById(avatarId: string): Avatar | null {
    const row = this.db.prepare<AvatarRow>(
      'SELECT * FROM avatars WHERE id = ? AND is_active = 1',
    ).get(avatarId);
    return row ? rowToAvatar(row) : null;
  }

  getByIdForIdentity(avatarId: string, identityId: string): Avatar | null {
    const row = this.db.prepare<AvatarRow>(
      'SELECT * FROM avatars WHERE id = ? AND identity_id = ? AND is_active = 1',
    ).get(avatarId, identityId);
    return row ? rowToAvatar(row) : null;
  }

  listByIdentity(identityId: string): Avatar[] {
    const rows = this.db.prepare<AvatarRow>(
      'SELECT * FROM avatars WHERE identity_id = ? AND is_active = 1 ORDER BY is_default DESC, created_at ASC',
    ).all(identityId);
    return rows.map(rowToAvatar);
  }

  update(avatarId: string, data: Partial<{ label: string; kind: AvatarKind; behaviorOverrides: BehaviorOverrides }>): Avatar | null {
    const now = Date.now();
    const sets: string[] = ['updated_at = ?'];
    const params: SqlValue[] = [now];

    if (data.label !== undefined) { sets.push('label = ?'); params.push(data.label); }
    if (data.kind !== undefined) { sets.push('kind = ?'); params.push(data.kind); }
    if (data.behaviorOverrides !== undefined) {
      sets.push('behavior_overrides = ?');
      params.push(JSON.stringify(data.behaviorOverrides));
    }
    params.push(avatarId);

    this.db.prepare<void>(
      `UPDATE avatars SET ${sets.join(', ')} WHERE id = ? AND is_active = 1`,
    ).run(...params);

    return this.getById(avatarId);
  }

  updateForIdentity(
    avatarId: string,
    identityId: string,
    data: Partial<{ label: string; kind: AvatarKind; behaviorOverrides: BehaviorOverrides }>,
  ): Avatar | null {
    const now = Date.now();
    const sets: string[] = ['updated_at = ?'];
    const params: SqlValue[] = [now];

    if (data.label !== undefined) { sets.push('label = ?'); params.push(data.label); }
    if (data.kind !== undefined) { sets.push('kind = ?'); params.push(data.kind); }
    if (data.behaviorOverrides !== undefined) {
      sets.push('behavior_overrides = ?');
      params.push(JSON.stringify(data.behaviorOverrides));
    }
    params.push(avatarId, identityId);

    this.db.prepare<void>(
      `UPDATE avatars SET ${sets.join(', ')} WHERE id = ? AND identity_id = ? AND is_active = 1`,
    ).run(...params);

    return this.getByIdForIdentity(avatarId, identityId);
  }

  softDelete(avatarId: string): boolean {
    const result = this.db.prepare<void>(
      'UPDATE avatars SET is_active = 0, updated_at = ? WHERE id = ? AND is_default = 0 AND is_active = 1',
    ).run(Date.now(), avatarId);
    return result.changes > 0;
  }

  softDeleteForIdentity(avatarId: string, identityId: string): boolean {
    const result = this.db.prepare<void>(
      'UPDATE avatars SET is_active = 0, updated_at = ? WHERE id = ? AND identity_id = ? AND is_default = 0 AND is_active = 1',
    ).run(Date.now(), avatarId, identityId);
    return result.changes > 0;
  }

  getDefault(identityId: string): Avatar | null {
    const row = this.db.prepare<AvatarRow>(
      'SELECT * FROM avatars WHERE identity_id = ? AND is_default = 1 AND is_active = 1',
    ).get(identityId);
    return row ? rowToAvatar(row) : null;
  }

  countActive(identityId: string): number {
    const row = this.db.prepare<{ count: number }>(
      'SELECT COUNT(*) as count FROM avatars WHERE identity_id = ? AND is_active = 1',
    ).get(identityId);
    return row?.count ?? 0;
  }
}
