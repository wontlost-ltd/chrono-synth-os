/**
 * 租户级 active LLM provider 偏好 SQL 执行器（BYOK 后续）。
 *
 * 偏好是非 secret 配置（active provider + 可选 model/embedding/base_url 覆盖）。
 * 一租户一行，upsert 覆盖。全部 tenant scoped。
 */

import { registerQuery, registerCommand } from '../legacy-sync-bridge.js';
import type {
  TenantLlmSettingsRow, TenantLlmSettingsUpsertParams,
} from '@chrono/kernel';
import {
  TENANT_LLM_SETTINGS_QUERY_BY_TENANT,
  TENANT_LLM_SETTINGS_CMD_UPSERT, TENANT_LLM_SETTINGS_CMD_DELETE,
} from '@chrono/kernel';

export function registerTenantLlmSettingsExecutors(): void {
  /* ── Queries ── */

  registerQuery<TenantLlmSettingsRow | null, string>(TENANT_LLM_SETTINGS_QUERY_BY_TENANT, (db, tenantId) => {
    return db.prepare<TenantLlmSettingsRow>(
      'SELECT * FROM tenant_llm_settings WHERE tenant_id = ?',
    ).get(tenantId) ?? null;
  });

  /* ── Commands ── */

  registerCommand<TenantLlmSettingsUpsertParams>(TENANT_LLM_SETTINGS_CMD_UPSERT, (db, p) => {
    const result = db.prepare<void>(
      `INSERT INTO tenant_llm_settings (tenant_id, active_provider, model, embedding_model, base_url, updated_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(tenant_id) DO UPDATE SET
         active_provider = excluded.active_provider,
         model = excluded.model,
         embedding_model = excluded.embedding_model,
         base_url = excluded.base_url,
         updated_by = excluded.updated_by,
         updated_at = excluded.updated_at`,
    ).run(p.tenantId, p.activeProvider, p.model, p.embeddingModel, p.baseUrl, p.updatedBy, p.now, p.now);
    return { rowsAffected: result.changes };
  });

  registerCommand<string>(TENANT_LLM_SETTINGS_CMD_DELETE, (db, tenantId) => {
    const result = db.prepare<void>(
      'DELETE FROM tenant_llm_settings WHERE tenant_id = ?',
    ).run(tenantId);
    return { rowsAffected: result.changes };
  });
}
