/**
 * 工具权限 Query/Command kind 常量与工厂
 */

import type { Query, Command } from '../../ports/query.js';
import type {
  ToolPermissionRow,
  ToolPermissionGrantParams,
} from './tool-permission-types.js';
import type {
  AgencyAuthorizationRow,
  AgencyAuthorizationCreateParams,
} from './agency-authorization-types.js';
import type {
  ToolInvocationRow,
  ToolInvocationRecordParams,
} from './tool-invocation-types.js';

/* ── Query kinds ─────────────────────────────────────────────────────── */

export const TPERM_QUERY_BY_PERSONA_TOOL = 'toolPermission.byPersonaTool' as const;
export const TPERM_QUERY_LIST_BY_PERSONA = 'toolPermission.listByPersona' as const;
export const TPERM_QUERY_LIST_BY_TENANT = 'toolPermission.listByTenant' as const;
export const TPERM_QUERY_BY_REVOCATION_KEY = 'toolPermission.byRevocationKey' as const;
export const TPERM_QUERY_DAILY_USAGE = 'toolPermission.dailyUsage' as const;

export const AGAUTH_QUERY_BY_ID = 'agencyAuth.byId' as const;
export const AGAUTH_QUERY_LIST_BY_PERSONA = 'agencyAuth.listByPersona' as const;
export const AGAUTH_QUERY_LIST_BY_PRINCIPAL = 'agencyAuth.listByPrincipal' as const;
export const AGAUTH_QUERY_BY_REVOCATION_KEY = 'agencyAuth.byRevocationKey' as const;

export const TINV_QUERY_BY_ID = 'toolInvocation.byId' as const;
export const TINV_QUERY_LIST_BY_PERSONA = 'toolInvocation.listByPersona' as const;
export const TINV_QUERY_DAILY_COUNT = 'toolInvocation.dailyCount' as const;
export const TINV_QUERY_PENDING_BY_USER = 'toolInvocation.pendingByUser' as const;
export const TINV_QUERY_BY_CONFIRMATION_TOKEN = 'toolInvocation.byConfirmationToken' as const;

/* ── Command kinds ───────────────────────────────────────────────────── */

export const TPERM_CMD_GRANT = 'toolPermission.grant' as const;
export const TPERM_CMD_REVOKE = 'toolPermission.revoke' as const;
export const TPERM_CMD_REVOKE_BY_REVOCATION_KEY = 'toolPermission.revokeByKey' as const;

export const AGAUTH_CMD_CREATE = 'agencyAuth.create' as const;
export const AGAUTH_CMD_REVOKE = 'agencyAuth.revoke' as const;
export const AGAUTH_CMD_SUSPEND = 'agencyAuth.suspend' as const;
export const AGAUTH_CMD_RESUME = 'agencyAuth.resume' as const;

export const TINV_CMD_RECORD = 'toolInvocation.record' as const;
export const TINV_CMD_UPDATE_STATUS = 'toolInvocation.updateStatus' as const;
export const TINV_CMD_PRUNE_BEFORE = 'toolInvocation.pruneBefore' as const;

/* ── 参数类型 ────────────────────────────────────────────────────────── */

export interface TpermByPersonaToolParams {
  readonly tenantId: string;
  readonly personaId: string;
  readonly toolId: string;
}

export interface TpermListByPersonaParams {
  readonly tenantId: string;
  readonly personaId: string;
}

export interface TpermDailyUsageParams {
  readonly tenantId: string;
  readonly personaId: string;
  readonly toolId: string;
  readonly sinceMs: number;
}

export interface TpermRevokeParams {
  readonly id: string;
  readonly reason: string;
  readonly now: number;
}

export interface TpermRevokeByKeyParams {
  readonly revocationKey: string;
  readonly reason: string;
  readonly now: number;
}

export interface AgauthByIdParams {
  readonly id: string;
  readonly tenantId: string;
}

export interface AgauthListByPersonaParams {
  readonly tenantId: string;
  readonly personaId: string;
}

export interface AgauthListByPrincipalParams {
  readonly tenantId: string;
  readonly principalUserId: string;
}

export interface AgauthRevokeParams {
  readonly id: string;
  readonly tenantId: string;
  readonly reason: string;
  readonly now: number;
}

export interface AgauthSuspendParams {
  readonly id: string;
  readonly tenantId: string;
  readonly now: number;
}

export interface TinvByIdParams {
  readonly id: string;
  readonly tenantId: string;
}

export interface TinvListByPersonaParams {
  readonly tenantId: string;
  readonly personaId: string;
  readonly limit: number;
  readonly offset: number;
}

export interface TinvDailyCountParams {
  readonly tenantId: string;
  readonly personaId: string;
  readonly toolId: string;
  readonly sinceMs: number;
  /** 仅统计成功调用作为配额计数 */
  readonly successOnly: boolean;
}

export interface TinvUpdateStatusParams {
  readonly id: string;
  readonly status: string;
  readonly outputSizeBytes: number;
  readonly errorMessage: string | null;
  readonly costCents: number;
  readonly durationMs: number;
  readonly completedAt: number;
}

export interface TinvPendingByUserParams {
  readonly tenantId: string;
  readonly userId: string;
  readonly limit: number;
}

export interface TinvByConfirmationTokenParams {
  readonly tenantId: string;
  readonly confirmationTokenId: string;
}

export interface TinvPruneBeforeParams {
  readonly cutoff: number;
  readonly batchSize: number;
}

/* ── Query 工厂 ─────────────────────────────────────────────────────── */

export function tpermQueryByPersonaTool(p: TpermByPersonaToolParams): Query<ToolPermissionRow | null, TpermByPersonaToolParams> {
  return { kind: TPERM_QUERY_BY_PERSONA_TOOL, params: p };
}

export function tpermQueryListByPersona(p: TpermListByPersonaParams): Query<readonly ToolPermissionRow[], TpermListByPersonaParams> {
  return { kind: TPERM_QUERY_LIST_BY_PERSONA, params: p };
}

export function tpermQueryListByTenant(tenantId: string): Query<readonly ToolPermissionRow[], string> {
  return { kind: TPERM_QUERY_LIST_BY_TENANT, params: tenantId };
}

export function tpermQueryByRevocationKey(key: string): Query<ToolPermissionRow | null, string> {
  return { kind: TPERM_QUERY_BY_REVOCATION_KEY, params: key };
}

export function tpermQueryDailyUsage(p: TpermDailyUsageParams): Query<{ count: number } | null, TpermDailyUsageParams> {
  return { kind: TPERM_QUERY_DAILY_USAGE, params: p };
}

export function agauthQueryById(p: AgauthByIdParams): Query<AgencyAuthorizationRow | null, AgauthByIdParams> {
  return { kind: AGAUTH_QUERY_BY_ID, params: p };
}

export function agauthQueryListByPersona(p: AgauthListByPersonaParams): Query<readonly AgencyAuthorizationRow[], AgauthListByPersonaParams> {
  return { kind: AGAUTH_QUERY_LIST_BY_PERSONA, params: p };
}

export function agauthQueryListByPrincipal(p: AgauthListByPrincipalParams): Query<readonly AgencyAuthorizationRow[], AgauthListByPrincipalParams> {
  return { kind: AGAUTH_QUERY_LIST_BY_PRINCIPAL, params: p };
}

export function agauthQueryByRevocationKey(key: string): Query<AgencyAuthorizationRow | null, string> {
  return { kind: AGAUTH_QUERY_BY_REVOCATION_KEY, params: key };
}

export function tinvQueryById(p: TinvByIdParams): Query<ToolInvocationRow | null, TinvByIdParams> {
  return { kind: TINV_QUERY_BY_ID, params: p };
}

export function tinvQueryListByPersona(p: TinvListByPersonaParams): Query<readonly ToolInvocationRow[], TinvListByPersonaParams> {
  return { kind: TINV_QUERY_LIST_BY_PERSONA, params: p };
}

export function tinvQueryDailyCount(p: TinvDailyCountParams): Query<{ count: number } | null, TinvDailyCountParams> {
  return { kind: TINV_QUERY_DAILY_COUNT, params: p };
}

export function tinvQueryPendingByUser(p: TinvPendingByUserParams): Query<readonly ToolInvocationRow[], TinvPendingByUserParams> {
  return { kind: TINV_QUERY_PENDING_BY_USER, params: p };
}

export function tinvQueryByConfirmationToken(p: TinvByConfirmationTokenParams): Query<ToolInvocationRow | null, TinvByConfirmationTokenParams> {
  return { kind: TINV_QUERY_BY_CONFIRMATION_TOKEN, params: p };
}

/* ── Command 工厂 ───────────────────────────────────────────────────── */

export function tpermCmdGrant(p: ToolPermissionGrantParams): Command<ToolPermissionGrantParams> {
  return { kind: TPERM_CMD_GRANT, params: p };
}

export function tpermCmdRevoke(p: TpermRevokeParams): Command<TpermRevokeParams> {
  return { kind: TPERM_CMD_REVOKE, params: p };
}

export function tpermCmdRevokeByKey(p: TpermRevokeByKeyParams): Command<TpermRevokeByKeyParams> {
  return { kind: TPERM_CMD_REVOKE_BY_REVOCATION_KEY, params: p };
}

export function agauthCmdCreate(p: AgencyAuthorizationCreateParams): Command<AgencyAuthorizationCreateParams> {
  return { kind: AGAUTH_CMD_CREATE, params: p };
}

export function agauthCmdRevoke(p: AgauthRevokeParams): Command<AgauthRevokeParams> {
  return { kind: AGAUTH_CMD_REVOKE, params: p };
}

export function agauthCmdSuspend(p: AgauthSuspendParams): Command<AgauthSuspendParams> {
  return { kind: AGAUTH_CMD_SUSPEND, params: p };
}

export function agauthCmdResume(p: AgauthSuspendParams): Command<AgauthSuspendParams> {
  return { kind: AGAUTH_CMD_RESUME, params: p };
}

export function tinvCmdRecord(p: ToolInvocationRecordParams): Command<ToolInvocationRecordParams> {
  return { kind: TINV_CMD_RECORD, params: p };
}

export function tinvCmdUpdateStatus(p: TinvUpdateStatusParams): Command<TinvUpdateStatusParams> {
  return { kind: TINV_CMD_UPDATE_STATUS, params: p };
}

export function tinvCmdPruneBefore(p: TinvPruneBeforeParams): Command<TinvPruneBeforeParams> {
  return { kind: TINV_CMD_PRUNE_BEFORE, params: p };
}
