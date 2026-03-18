/**
 * 用户资料 Query/Command kind 常量与参数类型
 */

import type { Query, Command } from '../../ports/query.js';

/* ── Query Kinds ── */

export const UPROF_QUERY_BY_ID = 'userProfile.byId' as const;
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

export interface UprofByEmailExcludeParams {
  email: string;
  excludeUserId: string;
}

export interface UprofUpdateEmailParams {
  userId: string;
  email: string;
  now: number;
}

export interface UprofUpdatePasswordParams {
  userId: string;
  passwordHash: string;
  now: number;
}

/* ── Query 工厂 ── */

export function uprofQueryById(userId: string): Query<UserProfileSummaryRow | null, string> {
  return { kind: UPROF_QUERY_BY_ID, params: userId };
}

export function uprofQueryByEmailExclude(email: string, excludeUserId: string): Query<UserIdRow | null, UprofByEmailExcludeParams> {
  return { kind: UPROF_QUERY_BY_EMAIL_EXCLUDE, params: { email, excludeUserId } };
}

export function uprofQueryFullById(userId: string): Query<UserProfileRow | null, string> {
  return { kind: UPROF_QUERY_FULL_BY_ID, params: userId };
}

/* ── Command 工厂 ── */

export function uprofCmdUpdateEmail(params: UprofUpdateEmailParams): Command<UprofUpdateEmailParams> {
  return { kind: UPROF_CMD_UPDATE_EMAIL, params };
}

export function uprofCmdUpdatePassword(params: UprofUpdatePasswordParams): Command<UprofUpdatePasswordParams> {
  return { kind: UPROF_CMD_UPDATE_PASSWORD, params };
}
