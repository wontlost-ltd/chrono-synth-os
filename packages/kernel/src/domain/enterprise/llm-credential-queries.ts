/**
 * BYOK LLM provider 凭据的 Query/Command kind 契约（BYOK，per-tenant 加密 api key）。
 *
 * kernel 只声明形状；执行器在 src/storage/executors。api_key_encrypted 列只存密文
 * （FieldEncryption），kernel 契约层不碰加解密（那是应用层 store 的事）。
 */

import type { Query, Command } from '../../ports/query.js';

/* ── Query / Command kinds ── */

export const LLMCRED_QUERY_BY_TENANT_PROVIDER = 'llmCred.byTenantProvider' as const;
export const LLMCRED_QUERY_BY_TENANT = 'llmCred.byTenant' as const;
export const LLMCRED_CMD_UPSERT = 'llmCred.upsert' as const;
export const LLMCRED_CMD_DELETE = 'llmCred.delete' as const;

/* ── Row ── */

export interface LlmCredentialRow {
  readonly tenant_id: string;
  readonly provider: string;
  /** FieldEncryption 密文（明文绝不落库）。 */
  readonly api_key_encrypted: string;
  readonly created_by: string | null;
  readonly created_at: number;
  readonly updated_at: number;
}

/* ── Params ── */

export interface LlmCredByTenantProviderParams {
  tenantId: string;
  provider: string;
}

export interface LlmCredUpsertParams {
  tenantId: string;
  provider: string;
  apiKeyEncrypted: string;
  createdBy: string | null;
  now: number;
}

/* ── 工厂 ── */

/** 取某租户某 provider 的 active 凭据（供 ModelRouter 优先用 per-tenant key）。 */
export function llmCredQueryByTenantProvider(params: LlmCredByTenantProviderParams): Query<LlmCredentialRow | null, LlmCredByTenantProviderParams> {
  return { kind: LLMCRED_QUERY_BY_TENANT_PROVIDER, params };
}

/** 列某租户全部 provider 凭据（管理/导出；调用方负责脱敏，不导出密文列）。 */
export function llmCredQueryByTenant(tenantId: string): Query<LlmCredentialRow, string> {
  return { kind: LLMCRED_QUERY_BY_TENANT, params: tenantId };
}

/** upsert：同 (tenant, provider) 覆盖更新（api key 是 secret 不留版本史）。 */
export function llmCredCmdUpsert(params: LlmCredUpsertParams): Command<LlmCredUpsertParams> {
  return { kind: LLMCRED_CMD_UPSERT, params };
}

/** 删除某租户某 provider 凭据（用户撤销 / GDPR 擦除）。 */
export function llmCredCmdDelete(params: LlmCredByTenantProviderParams): Command<LlmCredByTenantProviderParams> {
  return { kind: LLMCRED_CMD_DELETE, params };
}
