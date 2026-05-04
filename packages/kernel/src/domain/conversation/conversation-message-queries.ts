/**
 * 对话消息持久化 Query/Command kind 常量与参数类型
 */

import type { Query, Command } from '../../ports/query.js';

/* ── Query Kinds ── */

export const CMSG_QUERY_BY_IDEMPOTENCY = 'conversationMessage.byIdempotency' as const;
export const CMSG_QUERY_LIST_BY_SESSION = 'conversationMessage.listBySession' as const;
export const CMSG_QUERY_COUNT_BY_SESSION = 'conversationMessage.countBySession' as const;

/* ── Command Kinds ── */

export const CMSG_CMD_INSERT = 'conversationMessage.insert' as const;
export const CMSG_CMD_DELETE_BY_PERSONA = 'conversationMessage.deleteByPersona' as const;
export const CMSG_CMD_PRUNE_BY_RETENTION = 'conversationMessage.pruneByRetention' as const;

/* ── 行类型 ── */

export interface CmsgRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly persona_id: string;
  readonly session_id: string;
  readonly message_id: string;
  readonly external_user_id: string;
  readonly user_input: string;
  readonly assistant_output: string;
  readonly memories_used_json: string;
  readonly should_escalate: number;
  readonly confidence_score: number;
  readonly confidence_factors_json: string;
  readonly guard_action: string | null;
  readonly guard_reason: string | null;
  readonly duration_ms: number;
  readonly prompt_tokens: number;
  readonly completion_tokens: number;
  readonly encryption_key_ref: string | null;
  readonly input_redacted_pii_count: number;
  readonly output_redacted_pii_count: number;
  readonly retention_class: 'standard' | 'extended' | 'litigation_hold';
  readonly created_at: number;
}

/* ── 参数类型 ── */

export interface CmsgIdempotencyParams {
  tenantId: string;
  personaId: string;
  sessionId: string;
  messageId: string;
}

export interface CmsgListParams {
  tenantId: string;
  personaId: string;
  sessionId: string;
  limit: number;
}

export interface CmsgCountParams {
  tenantId: string;
  personaId: string;
  sessionId: string;
}

export interface CmsgInsertParams {
  id: string;
  tenantId: string;
  personaId: string;
  sessionId: string;
  messageId: string;
  externalUserId: string;
  userInput: string;
  assistantOutput: string;
  memoriesUsedJson: string;
  shouldEscalate: number;
  confidenceScore: number;
  confidenceFactorsJson: string;
  guardAction: string | null;
  guardReason: string | null;
  durationMs: number;
  promptTokens: number;
  completionTokens: number;
  encryptionKeyRef: string | null;
  inputRedactedPiiCount: number;
  outputRedactedPiiCount: number;
  retentionClass: 'standard' | 'extended' | 'litigation_hold';
  now: number;
}

export interface CmsgDeleteByPersonaParams {
  tenantId: string;
  personaId: string;
}

export interface CmsgPruneByRetentionParams {
  standardCutoff: number;
  extendedCutoff: number;
}

/* ── Query 工厂 ── */

export function cmsgQueryByIdempotency(params: CmsgIdempotencyParams): Query<CmsgRow | null, CmsgIdempotencyParams> {
  return { kind: CMSG_QUERY_BY_IDEMPOTENCY, params };
}

export function cmsgQueryListBySession(params: CmsgListParams): Query<readonly CmsgRow[], CmsgListParams> {
  return { kind: CMSG_QUERY_LIST_BY_SESSION, params };
}

export function cmsgQueryCountBySession(params: CmsgCountParams): Query<{ n: number } | null, CmsgCountParams> {
  return { kind: CMSG_QUERY_COUNT_BY_SESSION, params };
}

/* ── Command 工厂 ── */

export function cmsgCmdInsert(params: CmsgInsertParams): Command<CmsgInsertParams> {
  return { kind: CMSG_CMD_INSERT, params };
}

export function cmsgCmdDeleteByPersona(params: CmsgDeleteByPersonaParams): Command<CmsgDeleteByPersonaParams> {
  return { kind: CMSG_CMD_DELETE_BY_PERSONA, params };
}

export function cmsgCmdPruneByRetention(params: CmsgPruneByRetentionParams): Command<CmsgPruneByRetentionParams> {
  return { kind: CMSG_CMD_PRUNE_BY_RETENTION, params };
}
