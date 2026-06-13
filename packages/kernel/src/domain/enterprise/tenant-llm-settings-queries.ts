/**
 * 租户级 active LLM provider 偏好的 Query/Command kind 契约（BYOK 后续）。
 *
 * kernel 只声明形状；执行器在 src/storage/executors。偏好是**非 secret 配置**
 * （active provider + 可选 model/embedding/base_url 覆盖），与 llm_provider_credentials
 * 密钥表分离。无 row 时调用方完全回退全局 config（向后兼容）。
 */

import type { Query, Command } from '../../ports/query.js';

/* ── Query / Command kinds ── */

export const TENANT_LLM_SETTINGS_QUERY_BY_TENANT = 'tenantLlmSettings.byTenant' as const;
export const TENANT_LLM_SETTINGS_CMD_UPSERT = 'tenantLlmSettings.upsert' as const;
export const TENANT_LLM_SETTINGS_CMD_DELETE = 'tenantLlmSettings.delete' as const;

/* ── Row ── */

export interface TenantLlmSettingsRow {
  readonly tenant_id: string;
  readonly active_provider: string;
  /** 可空覆盖项：NULL = 沿用全局 config / provider 默认。 */
  readonly model: string | null;
  readonly embedding_model: string | null;
  readonly base_url: string | null;
  readonly updated_by: string | null;
  readonly created_at: number;
  readonly updated_at: number;
}

/* ── Params ── */

export interface TenantLlmSettingsUpsertParams {
  tenantId: string;
  activeProvider: string;
  model: string | null;
  embeddingModel: string | null;
  baseUrl: string | null;
  updatedBy: string | null;
  now: number;
}

/* ── 工厂 ── */

/** 取某租户的 active provider 偏好（无 row → 调用方回退全局 config）。 */
export function tenantLlmSettingsQueryByTenant(tenantId: string): Query<TenantLlmSettingsRow | null, string> {
  return { kind: TENANT_LLM_SETTINGS_QUERY_BY_TENANT, params: tenantId };
}

/** upsert：一租户一行，覆盖更新（偏好是当前生效配置，非审计资产）。 */
export function tenantLlmSettingsCmdUpsert(params: TenantLlmSettingsUpsertParams): Command<TenantLlmSettingsUpsertParams> {
  return { kind: TENANT_LLM_SETTINGS_CMD_UPSERT, params };
}

/** 删除某租户偏好（恢复全局默认 / GDPR 擦除）。 */
export function tenantLlmSettingsCmdDelete(tenantId: string): Command<string> {
  return { kind: TENANT_LLM_SETTINGS_CMD_DELETE, params: tenantId };
}
