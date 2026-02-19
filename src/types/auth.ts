/**
 * 认证相关类型定义
 * JWT 令牌载荷、用户角色与用户实体
 */

/** 用户角色枚举 */
export type UserRole = 'admin' | 'member' | 'viewer';

/** JWT 令牌载荷 */
export interface JwtPayload {
  /** 用户 ID */
  readonly sub: string;
  /** 租户 ID */
  readonly tenantId: string;
  /** 用户角色 */
  readonly role: UserRole;
  /** 当前订阅计划 ID（用于计划感知限流） */
  readonly planId?: string;
  /** 签发时间（Unix 秒） */
  readonly iat: number;
  /** 过期时间（Unix 秒） */
  readonly exp: number;
}

/** 用户实体（数据库行映射） */
export interface UserRow {
  readonly id: string;
  readonly email: string;
  readonly password_hash: string;
  readonly role: string;
  readonly tenant_id: string;
  readonly created_at: number;
  readonly updated_at: number;
}

/** 刷新令牌行 */
export interface RefreshTokenRow {
  readonly id: string;
  readonly user_id: string;
  readonly token_hash: string;
  readonly is_revoked: number;
  readonly expires_at: number;
  readonly created_at: number;
}
