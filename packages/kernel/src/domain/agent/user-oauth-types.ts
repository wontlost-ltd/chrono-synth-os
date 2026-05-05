/**
 * 用户 OAuth2 token 存储类型
 *
 * 设计原则：
 *  1. 一个 (tenantId, userId, provider, scope) 对应一条 token 记录
 *  2. access_token 加密存储（使用 FieldEncryption）
 *  3. refresh_token 加密存储（同上）
 *  4. 撤销 = soft delete（保留审计）
 *  5. 过期判定：access token 用 expires_at；refresh 不过期但可被 provider 强制失效
 */

export type OauthProvider = 'google';

export interface UserOauthToken {
  readonly id: string;
  readonly tenantId: string;
  readonly userId: string;
  readonly provider: OauthProvider;
  readonly scope: string;
  /** 解密后的 access token（仅 service 层使用） */
  readonly accessToken: string;
  readonly refreshToken: string | null;
  /** access token 过期时间（绝对毫秒） */
  readonly accessExpiresAt: number;
  readonly grantedAt: number;
  readonly updatedAt: number;
  readonly revokedAt: number | null;
}

/** SQL 行类型（access/refresh 是密文） */
export interface UserOauthTokenRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly user_id: string;
  readonly provider: string;
  readonly scope: string;
  readonly access_token_encrypted: string;
  readonly refresh_token_encrypted: string | null;
  readonly access_expires_at: number;
  readonly granted_at: number;
  readonly updated_at: number;
  readonly revoked_at: number | null;
}

export interface UserOauthUpsertParams {
  readonly id: string;
  readonly tenantId: string;
  readonly userId: string;
  readonly provider: string;
  readonly scope: string;
  readonly accessTokenEncrypted: string;
  readonly refreshTokenEncrypted: string | null;
  readonly accessExpiresAt: number;
  readonly now: number;
}

export interface UserOauthQueryParams {
  readonly tenantId: string;
  readonly userId: string;
  readonly provider: string;
  readonly scope: string;
}

export interface UserOauthRevokeParams {
  readonly id: string;
  readonly reason: string;
  readonly now: number;
}
