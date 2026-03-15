/**
 * User Profile Application Service
 * 封装用户个人信息 CRUD 的数据访问与业务逻辑
 */

import { hash, verify } from '@node-rs/argon2';
import type { IDatabase } from '../storage/database.js';
import type { UserRow } from '../types/auth.js';
import { AuthenticationError, ValidationError, ErrorCode } from '../errors/index.js';

function userToProfile(row: UserRow) {
  return {
    userId: row.id,
    email: row.email,
    role: row.role,
    tenantId: row.tenant_id,
    createdAt: new Date(Number(row.created_at)).toISOString(),
  };
}

export class UserProfileService {
  constructor(private readonly db: IDatabase) {}

  getProfile(userId: string) {
    const row = this.db.prepare<UserRow>(
      'SELECT id, email, role, tenant_id, created_at FROM users WHERE id = ?',
    ).get(userId);
    if (!row) throw new AuthenticationError('用户不存在', ErrorCode.AUTH_INVALID_TOKEN);
    return userToProfile(row);
  }

  updateEmail(userId: string, email: string) {
    const existing = this.db.prepare<{ id: string }>('SELECT id FROM users WHERE email = ? AND id != ?').get(email, userId);
    if (existing) {
      throw new ValidationError('该邮箱已被使用', ErrorCode.AUTH_EMAIL_EXISTS);
    }
    this.db.prepare<void>('UPDATE users SET email = ?, updated_at = ? WHERE id = ?').run(email, Date.now(), userId);
    return this.getProfile(userId);
  }

  async changePassword(userId: string, currentPassword: string, newPassword: string) {
    if (!currentPassword || !newPassword) {
      throw new ValidationError('缺少必要参数', ErrorCode.VALIDATION_RANGE);
    }
    if (newPassword.length < 8) {
      throw new ValidationError('新密码长度至少 8 个字符', ErrorCode.VALIDATION_RANGE);
    }

    const row = this.db.prepare<UserRow>('SELECT * FROM users WHERE id = ?').get(userId);
    if (!row) throw new AuthenticationError('用户不存在', ErrorCode.AUTH_INVALID_TOKEN);

    const valid = await verify(row.password_hash, currentPassword);
    if (!valid) {
      throw new ValidationError('当前密码错误', ErrorCode.VALIDATION_RANGE);
    }

    const newHash = await hash(newPassword);
    this.db.prepare<void>('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?').run(newHash, Date.now(), userId);
    return { success: true };
  }
}
