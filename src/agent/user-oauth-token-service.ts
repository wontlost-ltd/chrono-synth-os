/**
 * 用户 OAuth Token Application Service
 *
 * 职责：
 *  1. upsert：保存用户级 access/refresh token（密文落盘）
 *  2. get：解密读取，调用方自行判断是否过期
 *  3. revoke：软删除 + 留审计原因
 *
 * 加密策略：
 *  - access/refresh 通过 FieldEncryption 在内存中加密；
 *  - 数据库只存密文 + 过期时间 + 元数据；
 *  - revoked_at IS NULL 才视为有效，撤销立即生效。
 */

import { randomUUID } from 'node:crypto';
import type {
  SyncWriteUnitOfWork,
  UserOauthToken,
  UserOauthTokenRow,
} from '@chrono/kernel';
import {
  uoauthQueryByUserProviderScope,
  uoauthQueryListByUser,
  uoauthCmdUpsert,
  uoauthCmdRevoke,
} from '@chrono/kernel';
import { registerCoreSelfExecutors } from '../storage/executors/index.js';
import type { FieldEncryption } from '../storage/encryption.js';
import { ValidationError, ErrorCode } from '../errors/index.js';

/**
 * 抽象出加密接口；FieldEncryption 已实现，测试可用 IdentityEncryption。
 */
export interface TokenEncryption {
  encrypt(plaintext: string): string;
  decrypt(ciphertext: string): string;
}

/** 明文直通（仅开发/测试或 encryption.enabled=false 时使用） */
export class IdentityEncryption implements TokenEncryption {
  encrypt(plaintext: string): string { return plaintext; }
  decrypt(ciphertext: string): string { return ciphertext; }
}

export interface UserOauthUpsertInput {
  readonly tenantId: string;
  readonly userId: string;
  readonly provider: 'google';
  readonly scope: string;
  readonly accessToken: string;
  /** refresh token；如果新鉴权流程未返回，则保留既有的 refresh */
  readonly refreshToken: string | null;
  readonly accessExpiresAt: number;
}

export class UserOauthTokenService {
  constructor(
    private readonly tx: SyncWriteUnitOfWork,
    private readonly encryption: TokenEncryption | FieldEncryption,
  ) {
    registerCoreSelfExecutors();
  }

  /** 写入或刷新 token；同 (tenantId,userId,provider,scope) 唯一 */
  upsert(input: UserOauthUpsertInput): { id: string } {
    if (!input.accessToken) {
      throw new ValidationError('accessToken 必填', ErrorCode.VALIDATION_REQUIRED);
    }
    if (input.accessExpiresAt <= Date.now()) {
      throw new ValidationError('accessExpiresAt 必须为未来时间', ErrorCode.VALIDATION_FORMAT);
    }
    const existing = this.tx.queryOne(uoauthQueryByUserProviderScope({
      tenantId: input.tenantId,
      userId: input.userId,
      provider: input.provider,
      scope: input.scope,
    }));
    const id = existing?.id ?? `uoauth_${randomUUID()}`;
    const now = Date.now();
    const accessTokenEncrypted = this.encryption.encrypt(input.accessToken);
    const refreshTokenEncrypted = input.refreshToken !== null
      ? this.encryption.encrypt(input.refreshToken)
      : null;

    this.tx.execute(uoauthCmdUpsert({
      id,
      tenantId: input.tenantId,
      userId: input.userId,
      provider: input.provider,
      scope: input.scope,
      accessTokenEncrypted,
      refreshTokenEncrypted,
      accessExpiresAt: input.accessExpiresAt,
      now,
    }));
    return { id };
  }

  /** 查询并解密单条 token；不存在或已撤销返回 null */
  get(input: { tenantId: string; userId: string; provider: string; scope: string }): UserOauthToken | null {
    const row = this.tx.queryOne(uoauthQueryByUserProviderScope(input));
    return row ? this.decryptRow(row) : null;
  }

  /** 列出用户全部活跃 token（已脱敏：仅元数据） */
  listByUser(tenantId: string, userId: string): readonly Omit<UserOauthToken, 'accessToken' | 'refreshToken'>[] {
    const rows = this.tx.queryMany(uoauthQueryListByUser({ tenantId, userId }));
    return rows.map(rowToMetadata);
  }

  /** 撤销 token（软删除）；返回是否成功 */
  revoke(id: string, reason: string): boolean {
    if (!reason || reason.trim().length === 0) {
      throw new ValidationError('撤销原因必填', ErrorCode.VALIDATION_REQUIRED);
    }
    const result = this.tx.execute(uoauthCmdRevoke({ id, reason: reason.trim(), now: Date.now() }));
    return result.rowsAffected > 0;
  }

  private decryptRow(row: UserOauthTokenRow): UserOauthToken {
    return {
      id: row.id,
      tenantId: row.tenant_id,
      userId: row.user_id,
      provider: row.provider as 'google',
      scope: row.scope,
      accessToken: this.encryption.decrypt(row.access_token_encrypted),
      refreshToken: row.refresh_token_encrypted !== null
        ? this.encryption.decrypt(row.refresh_token_encrypted)
        : null,
      accessExpiresAt: row.access_expires_at,
      grantedAt: row.granted_at,
      updatedAt: row.updated_at,
      revokedAt: row.revoked_at,
    };
  }
}

function rowToMetadata(row: UserOauthTokenRow): Omit<UserOauthToken, 'accessToken' | 'refreshToken'> {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    userId: row.user_id,
    provider: row.provider as 'google',
    scope: row.scope,
    accessExpiresAt: row.access_expires_at,
    grantedAt: row.granted_at,
    updatedAt: row.updated_at,
    revokedAt: row.revoked_at,
  };
}
