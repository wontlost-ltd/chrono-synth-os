/**
 * BYOK LLM provider 凭据 SQL 执行器。
 *
 * api_key_encrypted 列只存密文（store 层 FieldEncryption 加密后传入）。upsert 同
 * (tenant, provider) 覆盖更新（secret 不留版本史）。全部 tenant scoped。
 */

import { registerQuery, registerCommand } from '../legacy-sync-bridge.js';
import type {
  LlmCredentialRow, LlmCredByTenantProviderParams, LlmCredUpsertParams,
} from '@chrono/kernel';
import {
  LLMCRED_QUERY_BY_TENANT_PROVIDER, LLMCRED_QUERY_BY_TENANT,
  LLMCRED_CMD_UPSERT, LLMCRED_CMD_DELETE,
} from '@chrono/kernel';

export function registerLlmCredentialExecutors(): void {
  /* ── Queries ── */

  registerQuery<LlmCredentialRow | null, LlmCredByTenantProviderParams>(LLMCRED_QUERY_BY_TENANT_PROVIDER, (db, p) => {
    return db.prepare<LlmCredentialRow>(
      'SELECT * FROM llm_provider_credentials WHERE tenant_id = ? AND provider = ?',
    ).get(p.tenantId, p.provider) ?? null;
  });

  registerQuery<LlmCredentialRow[], string>(LLMCRED_QUERY_BY_TENANT, (db, tenantId) => {
    return db.prepare<LlmCredentialRow>(
      'SELECT * FROM llm_provider_credentials WHERE tenant_id = ? ORDER BY provider ASC',
    ).all(tenantId);
  });

  /* ── Commands ── */

  registerCommand<LlmCredUpsertParams>(LLMCRED_CMD_UPSERT, (db, p) => {
    const result = db.prepare<void>(
      `INSERT INTO llm_provider_credentials (tenant_id, provider, api_key_encrypted, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(tenant_id, provider) DO UPDATE SET
         api_key_encrypted = excluded.api_key_encrypted,
         updated_at = excluded.updated_at`,
    ).run(p.tenantId, p.provider, p.apiKeyEncrypted, p.createdBy, p.now, p.now);
    return { rowsAffected: result.changes };
  });

  registerCommand<LlmCredByTenantProviderParams>(LLMCRED_CMD_DELETE, (db, p) => {
    const result = db.prepare<void>(
      'DELETE FROM llm_provider_credentials WHERE tenant_id = ? AND provider = ?',
    ).run(p.tenantId, p.provider);
    return { rowsAffected: result.changes };
  });
}
