/**
 * API Key SQL 执行器
 */

import { registerQuery, registerCommand } from '../legacy-sync-bridge.js';
import {
  APIKEY_QUERY_LIST, APIKEY_QUERY_BY_HASH, APIKEY_CMD_CREATE, APIKEY_CMD_REVOKE,
} from '@chrono/kernel';
import type { ApiKeyRow, ApiKeyCreateParams, ApiKeyRevokeParams } from '@chrono/kernel';

export function registerApiKeyExecutors(): void {
  /* ── Queries ── */

  registerQuery<readonly ApiKeyRow[], string>(APIKEY_QUERY_LIST, (db, tenantId) => {
    return db.prepare<ApiKeyRow>(
      'SELECT id, tenant_id, key_hash, plan_id, is_revoked, created_at FROM api_keys WHERE tenant_id = ? ORDER BY created_at DESC',
    ).all(tenantId);
  });

  registerQuery<ApiKeyRow | null, string>(APIKEY_QUERY_BY_HASH, (db, keyHash) => {
    return db.prepare<ApiKeyRow>(
      'SELECT id, tenant_id, key_hash, plan_id, is_revoked FROM api_keys WHERE key_hash = ? AND is_revoked = 0',
    ).get(keyHash) ?? null;
  });

  /* ── Commands ── */

  registerCommand<ApiKeyCreateParams>(APIKEY_CMD_CREATE, (db, p) => {
    const result = db.prepare<void>(
      'INSERT INTO api_keys (id, tenant_id, key_hash, plan_id, is_revoked, created_at) VALUES (?, ?, ?, ?, 0, ?)',
    ).run(p.id, p.tenantId, p.keyHash, p.planId, p.now);
    return { rowsAffected: result.changes };
  });

  registerCommand<ApiKeyRevokeParams>(APIKEY_CMD_REVOKE, (db, p) => {
    const result = db.prepare<void>(
      'UPDATE api_keys SET is_revoked = 1 WHERE id = ? AND tenant_id = ? AND is_revoked = 0',
    ).run(p.id, p.tenantId);
    return { rowsAffected: result.changes };
  });
}
