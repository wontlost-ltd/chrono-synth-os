/**
 * 用户资料 Query/Command kind 常量与参数类型
 */

import type { Query, Command } from '../../ports/query.js';

/* ── Query Kinds ── */

export const UPROF_QUERY_BY_ID = 'userProfile.byId' as const;
/** 全局 by-id 查询 kind（无 tenant predicate，供 UserEmailDirectoryService coordinatorDb 取回 profile）。 */
export const UPROF_QUERY_BY_ID_GLOBAL = 'userProfile.byIdGlobal' as const;
export const UPROF_QUERY_BY_EMAIL_EXCLUDE = 'userProfile.byEmailExclude' as const;
export const UPROF_QUERY_FULL_BY_ID = 'userProfile.fullById' as const;

/* ── Command Kinds ── */

export const UPROF_CMD_UPDATE_EMAIL = 'userProfile.updateEmail' as const;
export const UPROF_CMD_UPDATE_PASSWORD = 'userProfile.updatePassword' as const;

/* ── 行类型 ── */

/** 摘要行（不含密码哈希和 updated_at） */
export interface UserProfileSummaryRow {
  readonly id: string;
  readonly email: string;
  readonly role: string;
  readonly tenant_id: string;
  readonly created_at: number;
}

/** 完整行（含密码哈希，用于凭证验证） */
export interface UserProfileRow {
  readonly id: string;
  readonly email: string;
  readonly password_hash: string;
  readonly role: string;
  readonly tenant_id: string;
  readonly created_at: number;
  readonly updated_at: number;
}

export interface UserIdRow {
  readonly id: string;
}

/* ── 参数类型 ── */

/**
 * tenant-scoped 主键查询参数（分片 Phase 0 · Plan 1b Task 7）。
 * users 表有 tenant_id 列（v013），getProfile/changePassword 为 tenant-scoped → WHERE tenant_id=? AND id=?。
 */
export interface UprofByTenantAndIdParams {
  tenantId: string;
  userId: string;
}

export interface UprofByEmailExcludeParams {
  email: string;
  excludeUserId: string;
}

export interface UprofUpdateEmailParams {
  userId: string;
  email: string;
  now: number;
}

/**
 * tenant-scoped 改密参数（Task 7）：加 tenantId → UPDATE 前 WHERE tenant_id=? AND id=? 防同库跨租户改密。
 */
export interface UprofUpdatePasswordParams {
  tenantId: string;
  userId: string;
  passwordHash: string;
  now: number;
}

/* ── Query 工厂 ── */

/**
 * tenant-scoped 摘要查询（Task 7）：WHERE tenant_id=? AND id=?（`/users/me` getProfile 用，JWT 带 tenantId）。
 */
export function uprofQueryById(tenantId: string, userId: string): Query<UserProfileSummaryRow | null, UprofByTenantAndIdParams> {
  return { kind: UPROF_QUERY_BY_ID, params: { tenantId, userId } };
}

/**
 * 全局摘要查询（Task 7）：WHERE id=?（无 tenant predicate）——供 `UserEmailDirectoryService` 经 coordinatorDb
 * 更新 email 后取回 profile（email 全局唯一性=coordinator 定位，不携带 tenantId）。
 */
export function uprofQueryByIdGlobal(userId: string): Query<UserProfileSummaryRow | null, string> {
  return { kind: UPROF_QUERY_BY_ID_GLOBAL, params: userId };
}

export function uprofQueryByEmailExclude(email: string, excludeUserId: string): Query<UserIdRow | null, UprofByEmailExcludeParams> {
  return { kind: UPROF_QUERY_BY_EMAIL_EXCLUDE, params: { email, excludeUserId } };
}

/**
 * tenant-scoped 完整行查询（Task 7）：WHERE tenant_id=? AND id=?（changePassword 验证凭证用）。
 */
export function uprofQueryFullById(tenantId: string, userId: string): Query<UserProfileRow | null, UprofByTenantAndIdParams> {
  return { kind: UPROF_QUERY_FULL_BY_ID, params: { tenantId, userId } };
}

/* ── Command 工厂 ── */

export function uprofCmdUpdateEmail(params: UprofUpdateEmailParams): Command<UprofUpdateEmailParams> {
  return { kind: UPROF_CMD_UPDATE_EMAIL, params };
}

export function uprofCmdUpdatePassword(params: UprofUpdatePasswordParams): Command<UprofUpdatePasswordParams> {
  return { kind: UPROF_CMD_UPDATE_PASSWORD, params };
}
