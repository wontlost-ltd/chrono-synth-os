/**
 * User Profile Application Service
 * 封装用户个人信息 CRUD 的数据访问与业务逻辑
 */

import { hash, verify } from '@node-rs/argon2';
import type { SyncWriteUnitOfWork } from '@chrono/kernel';
import {
  uprofQueryById, uprofQueryByEmailExclude, uprofQueryFullById,
  uprofCmdUpdateEmail, uprofCmdUpdatePassword,
} from '@chrono/kernel';
import type { UserProfileSummaryRow } from '@chrono/kernel';
import { AuthenticationError, ValidationError, ErrorCode } from '../errors/index.js';
import { asUow, type UowOrDb } from '../storage/uow-helpers.js';
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
  private readonly tx: SyncWriteUnitOfWork;

  constructor(uowOrDb: UowOrDb) {
    registerCoreSelfExecutors();
    this.tx = asUow(uowOrDb);
  }

  getProfile(userId: string) {
    const row = this.tx.queryOne(uprofQueryById(userId));
    if (!row) throw new AuthenticationError('用户不存在', ErrorCode.AUTH_INVALID_TOKEN);
    return userToProfile(row);
  }

  updateEmail(userId: string, email: string) {
    const existing = this.tx.queryOne(uprofQueryByEmailExclude(email, userId));
    if (existing) {
      throw new ValidationError('该邮箱已被使用', ErrorCode.AUTH_EMAIL_EXISTS);
    }
    this.tx.execute(uprofCmdUpdateEmail({ userId, email, now: Date.now() }));
    return this.getProfile(userId);
  }

  async changePassword(userId: string, currentPassword: string, newPassword: string) {
    if (!currentPassword || !newPassword) {
      throw new ValidationError('缺少必要参数', ErrorCode.VALIDATION_RANGE);
    }
    if (newPassword.length < 8) {
      throw new ValidationError('新密码长度至少 8 个字符', ErrorCode.VALIDATION_RANGE);
    }

    const row = this.tx.queryOne(uprofQueryFullById(userId));
    if (!row) throw new AuthenticationError('用户不存在', ErrorCode.AUTH_INVALID_TOKEN);

    const valid = await verify(row.password_hash, currentPassword);
    if (!valid) {
      throw new ValidationError('当前密码错误', ErrorCode.VALIDATION_RANGE);
    }

    const newHash = await hash(newPassword);
    this.tx.execute(uprofCmdUpdatePassword({ userId, passwordHash: newHash, now: Date.now() }));
    return { success: true };
  }
}
