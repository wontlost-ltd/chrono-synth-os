/**
 * User Profile Application Service
 * 封装用户个人信息 CRUD 的数据访问与业务逻辑。
 *
 * 分片 Phase 0 · Plan 1b（Task 7）：users 表有 tenant_id 列（v013）→ `getProfile`/`changePassword` 为
 * **tenant-scoped**（JWT 带 tenantId，已认证路径穿 tenantId 进方法）。ctor 收 `TenantDbResolver`，每方法
 * 经 `dbForTenant(tenantId)` 选对 shard + SQL `WHERE tenant_id=? AND id=?` 双重约束防同库跨租户读改。
 *
 * **mixed-scope 的 `updateEmail`（全局 email 唯一性，无 tenantId 入参）已拆到 `UserEmailDirectoryService`**
 * ——避免「ctor resolver 化但 email 方法假全局」的半成品；真跨 shard 目录一致性 = Plan 1c。
 */

import { hash, verify } from '@node-rs/argon2';
import type { SyncWriteUnitOfWork } from '@chrono/kernel';
import {
  uprofQueryById, uprofQueryFullById,
  uprofCmdUpdatePassword,
} from '@chrono/kernel';
import type { UserProfileSummaryRow } from '@chrono/kernel';
import type { TenantDbResolver } from '../storage/tenant-db-resolver.js';
import { AuthenticationError, ValidationError, ErrorCode } from '../errors/index.js';
import { registerCoreSelfExecutors } from '../storage/executors/index.js';

function userToProfile(row: UserProfileSummaryRow) {
  return {
    userId: row.id,
    email: row.email,
    role: row.role,
    tenantId: row.tenant_id,
    createdAt: new Date(Number(row.created_at)).toISOString(),
  };
}

export class UserProfileService {
  constructor(private readonly resolver: TenantDbResolver) {
    registerCoreSelfExecutors();
  }

  /** 取该租户所在 shard 的 tx（单库下恒返回同一 db；SQL 层再加 tenant predicate 双重约束）。 */
  private txFor(tenantId: string): SyncWriteUnitOfWork {
    return this.resolver.dbForTenant(tenantId);
  }

  getProfile(tenantId: string, userId: string) {
    const row = this.txFor(tenantId).queryOne(uprofQueryById(tenantId, userId));
    if (!row) throw new AuthenticationError('用户不存在', ErrorCode.AUTH_INVALID_TOKEN);
    return userToProfile(row);
  }

  async changePassword(tenantId: string, userId: string, currentPassword: string, newPassword: string) {
    if (!currentPassword || !newPassword) {
      throw new ValidationError('缺少必要参数', ErrorCode.VALIDATION_RANGE);
    }
    if (newPassword.length < 8) {
      throw new ValidationError('新密码长度至少 8 个字符', ErrorCode.VALIDATION_RANGE);
    }

    const tx = this.txFor(tenantId);
    const row = tx.queryOne(uprofQueryFullById(tenantId, userId));
    if (!row) throw new AuthenticationError('用户不存在', ErrorCode.AUTH_INVALID_TOKEN);

    const valid = await verify(row.password_hash, currentPassword);
    if (!valid) {
      throw new ValidationError('当前密码错误', ErrorCode.VALIDATION_RANGE);
    }

    const newHash = await hash(newPassword);
    tx.execute(uprofCmdUpdatePassword({ tenantId, userId, passwordHash: newHash, now: Date.now() }));
    return { success: true };
  }
}
