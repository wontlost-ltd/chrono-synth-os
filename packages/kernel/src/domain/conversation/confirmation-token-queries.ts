/**
 * 对话确认 Token Query/Command kind 常量与参数类型
 */

import type { Query, Command } from '../../ports/query.js';

/* ── Query Kinds ── */

export const CTOKEN_QUERY_BY_ID = 'confirmationToken.byId' as const;

/* ── Command Kinds ── */

export const CTOKEN_CMD_INSERT = 'confirmationToken.insert' as const;
export const CTOKEN_CMD_CONSUME = 'confirmationToken.consume' as const;
export const CTOKEN_CMD_PRUNE_EXPIRED = 'confirmationToken.pruneExpired' as const;

/* ── 行类型 ── */

export interface CtokenRow {
  readonly tenant_id: string;
  readonly persona_id: string;
  readonly session_id: string;
  readonly external_user_id: string;
  readonly input_hash: string;
  readonly expires_at: number;
  readonly consumed_at: number | null;
}

/* ── 参数类型 ── */

export interface CtokenInsertParams {
  id: string;
  tenantId: string;
  personaId: string;
  sessionId: string;
  externalUserId: string;
  topic: string;
  rule: string;
  inputHash: string;
  issuedAt: number;
  expiresAt: number;
}

export interface CtokenConsumeParams {
  id: string;
  consumedAt: number;
}

export interface CtokenPruneParams {
  before: number;
}

/* ── Query 工厂 ── */

export function ctokenQueryById(id: string): Query<CtokenRow | null, string> {
  return { kind: CTOKEN_QUERY_BY_ID, params: id };
}

/* ── Command 工厂 ── */

export function ctokenCmdInsert(params: CtokenInsertParams): Command<CtokenInsertParams> {
  return { kind: CTOKEN_CMD_INSERT, params };
}

export function ctokenCmdConsume(params: CtokenConsumeParams): Command<CtokenConsumeParams> {
  return { kind: CTOKEN_CMD_CONSUME, params };
}

export function ctokenCmdPruneExpired(params: CtokenPruneParams): Command<CtokenPruneParams> {
  return { kind: CTOKEN_CMD_PRUNE_EXPIRED, params };
}
