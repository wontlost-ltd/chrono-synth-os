/**
 * 租户企业配置 Query/Command kind 常量与参数类型
 */

import type { Query, Command } from '../../ports/query.js';

/* ── Query Kinds ── */

export const TPROF_QUERY_BY_TENANT = 'tenantProfile.byTenant' as const;
export const TPROF_QUERY_BY_SCIM_TOKEN = 'tenantProfile.byScimToken' as const;

/* ── Command Kinds ── */

export const TPROF_CMD_UPDATE = 'tenantProfile.update' as const;
export const TPROF_CMD_INSERT = 'tenantProfile.insert' as const;
export const TPROF_CMD_UPDATE_SCIM_TOKEN = 'tenantProfile.updateScimToken' as const;
export const TPROF_CMD_INSERT_WITH_SCIM_TOKEN = 'tenantProfile.insertWithScimToken' as const;

/* ── 行类型 ── */

export interface TprofRow {
  readonly tenant_id: string;
  readonly deployment_mode: string;
  readonly database_isolation_mode: string;
  readonly kafka_namespace: string;
  readonly encryption_mode: string;
  readonly kms_key_ref: string | null;
  readonly scim_token_hash: string | null;
  readonly oidc_enabled: number;
  readonly oidc_issuer_url: string;
  readonly oidc_client_id: string;
  readonly oidc_client_secret_encrypted: string;
  readonly oidc_audience: string;
  readonly oidc_scope: string;
  readonly oidc_email_claim: string;
  readonly oidc_name_claim: string;
  readonly created_at: number;
  readonly updated_at: number;
}

export interface TprofScimTenantRow {
  readonly tenant_id: string;
}

/* ── 参数类型 ── */

export interface TprofUpdateParams {
  tenantId: string;
  deploymentMode: string;
  databaseIsolationMode: string;
  kafkaNamespace: string;
  encryptionMode: string;
  kmsKeyRef: string | null;
  oidcEnabled: number;
  oidcIssuerUrl: string;
  oidcClientId: string;
  oidcClientSecretEncrypted: string;
  oidcAudience: string;
  oidcScope: string;
  oidcEmailClaim: string;
  oidcNameClaim: string;
  now: number;
}

export interface TprofInsertParams extends TprofUpdateParams {}

export interface TprofUpdateScimTokenParams {
  tenantId: string;
  tokenHash: string;
  now: number;
}

export interface TprofInsertWithScimTokenParams {
  tenantId: string;
  tokenHash: string;
  now: number;
}

/* ── Query 工厂 ── */

export function tprofQueryByTenant(tenantId: string): Query<TprofRow | null, string> {
  return { kind: TPROF_QUERY_BY_TENANT, params: tenantId };
}

export function tprofQueryByScimToken(tokenHash: string): Query<TprofScimTenantRow | null, string> {
  return { kind: TPROF_QUERY_BY_SCIM_TOKEN, params: tokenHash };
}

/* ── Command 工厂 ── */

export function tprofCmdUpdate(params: TprofUpdateParams): Command<TprofUpdateParams> {
  return { kind: TPROF_CMD_UPDATE, params };
}

export function tprofCmdInsert(params: TprofInsertParams): Command<TprofInsertParams> {
  return { kind: TPROF_CMD_INSERT, params };
}

export function tprofCmdUpdateScimToken(params: TprofUpdateScimTokenParams): Command<TprofUpdateScimTokenParams> {
  return { kind: TPROF_CMD_UPDATE_SCIM_TOKEN, params };
}

export function tprofCmdInsertWithScimToken(params: TprofInsertWithScimTokenParams): Command<TprofInsertWithScimTokenParams> {
  return { kind: TPROF_CMD_INSERT_WITH_SCIM_TOKEN, params };
}
