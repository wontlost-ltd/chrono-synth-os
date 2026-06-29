/**
 * 工具权限 / 代理授权 / 工具调用 SQL 执行器
 */

import { registerQuery, registerCommand } from '../legacy-sync-bridge.js';
import {
  TPERM_QUERY_BY_PERSONA_TOOL, TPERM_QUERY_LIST_BY_PERSONA, TPERM_QUERY_LIST_BY_TENANT,
  TPERM_QUERY_BY_REVOCATION_KEY, TPERM_QUERY_DAILY_USAGE, TPERM_QUERY_DAILY_COST,
  TPERM_CMD_GRANT, TPERM_CMD_REVOKE, TPERM_CMD_REVOKE_BY_REVOCATION_KEY,
  AGAUTH_QUERY_BY_ID, AGAUTH_QUERY_LIST_BY_PERSONA, AGAUTH_QUERY_LIST_BY_PRINCIPAL,
  AGAUTH_QUERY_BY_REVOCATION_KEY,
  AGAUTH_CMD_CREATE, AGAUTH_CMD_REVOKE, AGAUTH_CMD_SUSPEND, AGAUTH_CMD_RESUME,
  TINV_QUERY_BY_ID, TINV_QUERY_LIST_BY_PERSONA, TINV_QUERY_DAILY_COUNT,
  TINV_QUERY_PENDING_BY_USER, TINV_QUERY_BY_CONFIRMATION_TOKEN,
  TINV_CMD_RECORD, TINV_CMD_UPDATE_STATUS, TINV_CMD_PRUNE_BEFORE,
} from '@chrono/kernel';
import type {
  ToolPermissionRow, ToolPermissionGrantParams,
  TpermByPersonaToolParams, TpermListByPersonaParams,
  TpermDailyUsageParams, TpermRevokeParams, TpermRevokeByKeyParams,
  TpermByRevocationKeyParams, AgauthByRevocationKeyParams,
  AgencyAuthorizationRow, AgencyAuthorizationCreateParams,
  AgauthByIdParams, AgauthListByPersonaParams, AgauthListByPrincipalParams,
  AgauthRevokeParams, AgauthSuspendParams,
  ToolInvocationRow, ToolInvocationRecordParams,
  TinvByIdParams, TinvListByPersonaParams, TinvDailyCountParams,
  TinvUpdateStatusParams, TinvPendingByUserParams,
  TinvByConfirmationTokenParams, TinvPruneBeforeParams,
} from '@chrono/kernel';

const TPERM_SELECT = `
  SELECT id, tenant_id, persona_id, tool_id, scope, constraints_json,
         granted_by, granted_at, expires_at, revoked_at, revocation_reason, revocation_key
    FROM tool_permissions`;

const AGAUTH_SELECT = `
  SELECT id, tenant_id, persona_id, principal_user_id, scope, scope_description,
         allowed_tools_json, denied_tools_json, status,
         granted_at, expires_at, revoked_at, revocation_reason, revocation_key
    FROM agency_authorizations`;

const TINV_SELECT = `
  SELECT id, tenant_id, persona_id, tool_id, invoker_type, invoker_id, invoker_user_id, status,
         input_hash, output_size_bytes, error_message, cost_cents, duration_ms,
         invoked_at, completed_at, confirmation_token_id
    FROM tool_invocations`;

export function registerToolPermissionExecutors(): void {
  /* ── ToolPermission Queries ────────────────────────────────────── */

  registerQuery<ToolPermissionRow | null, TpermByPersonaToolParams>(TPERM_QUERY_BY_PERSONA_TOOL, (db, p) => {
    return db.prepare<ToolPermissionRow>(
      `${TPERM_SELECT} WHERE tenant_id = ? AND persona_id = ? AND tool_id = ? LIMIT 1`,
    ).get(p.tenantId, p.personaId, p.toolId) ?? null;
  });

  registerQuery<readonly ToolPermissionRow[], TpermListByPersonaParams>(TPERM_QUERY_LIST_BY_PERSONA, (db, p) => {
    return db.prepare<ToolPermissionRow>(
      `${TPERM_SELECT} WHERE tenant_id = ? AND persona_id = ? ORDER BY granted_at DESC`,
    ).all(p.tenantId, p.personaId);
  });

  registerQuery<readonly ToolPermissionRow[], string>(TPERM_QUERY_LIST_BY_TENANT, (db, tenantId) => {
    return db.prepare<ToolPermissionRow>(
      `${TPERM_SELECT} WHERE tenant_id = ? ORDER BY granted_at DESC`,
    ).all(tenantId);
  });

  registerQuery<ToolPermissionRow | null, TpermByRevocationKeyParams>(TPERM_QUERY_BY_REVOCATION_KEY, (db, p) => {
    /* 租户隔离：revocation_key 是密钥，但查询仍须限定 tenant_id，防跨租户按 key 越权查 */
    return db.prepare<ToolPermissionRow>(
      `${TPERM_SELECT} WHERE tenant_id = ? AND revocation_key = ? LIMIT 1`,
    ).get(p.tenantId, p.revocationKey) ?? null;
  });

  registerQuery<{ count: number } | null, TpermDailyUsageParams>(TPERM_QUERY_DAILY_USAGE, (db, p) => {
    return db.prepare<{ count: number }>(
      `SELECT COUNT(*) AS count
         FROM tool_invocations
        WHERE tenant_id = ? AND persona_id = ? AND tool_id = ?
          AND invoked_at >= ? AND status = 'success'`,
    ).get(p.tenantId, p.personaId, p.toolId, p.sinceMs) ?? null;
  });

  /* 当日累计成本（分）：仅计成功调用；COALESCE 防 NULL（无记录返回 0） */
  registerQuery<{ cost_cents: number } | null, TpermDailyUsageParams>(TPERM_QUERY_DAILY_COST, (db, p) => {
    return db.prepare<{ cost_cents: number }>(
      `SELECT COALESCE(SUM(cost_cents), 0) AS cost_cents
         FROM tool_invocations
        WHERE tenant_id = ? AND persona_id = ? AND tool_id = ?
          AND invoked_at >= ? AND status = 'success'`,
    ).get(p.tenantId, p.personaId, p.toolId, p.sinceMs) ?? null;
  });

  /* ── ToolPermission Commands ───────────────────────────────────── */

  registerCommand<ToolPermissionGrantParams>(TPERM_CMD_GRANT, (db, p) => {
    const result = db.prepare<void>(
      `INSERT INTO tool_permissions
         (id, tenant_id, persona_id, tool_id, scope, constraints_json,
          granted_by, granted_at, expires_at, revoked_at, revocation_reason, revocation_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)
       ON CONFLICT(tenant_id, persona_id, tool_id) DO UPDATE SET
         scope = excluded.scope,
         constraints_json = excluded.constraints_json,
         granted_by = excluded.granted_by,
         granted_at = excluded.granted_at,
         expires_at = excluded.expires_at,
         revoked_at = NULL,
         revocation_reason = NULL,
         revocation_key = excluded.revocation_key`,
    ).run(
      p.id, p.tenantId, p.personaId, p.toolId, p.scope, p.constraintsJson,
      p.grantedBy, p.now, p.expiresAt, p.revocationKey,
    );
    return { rowsAffected: result.changes };
  });

  registerCommand<TpermRevokeParams>(TPERM_CMD_REVOKE, (db, p) => {
    const result = db.prepare<void>(
      `UPDATE tool_permissions
          SET revoked_at = ?, revocation_reason = ?
        WHERE id = ? AND revoked_at IS NULL`,
    ).run(p.now, p.reason, p.id);
    return { rowsAffected: result.changes };
  });

  registerCommand<TpermRevokeByKeyParams>(TPERM_CMD_REVOKE_BY_REVOCATION_KEY, (db, p) => {
    /* 租户隔离：撤销同样须限定 tenant_id，防跨租户按 key 越权撤销 */
    const result = db.prepare<void>(
      `UPDATE tool_permissions
          SET revoked_at = ?, revocation_reason = ?
        WHERE tenant_id = ? AND revocation_key = ? AND revoked_at IS NULL`,
    ).run(p.now, p.reason, p.tenantId, p.revocationKey);
    return { rowsAffected: result.changes };
  });

  /* ── AgencyAuthorization Queries ───────────────────────────────── */

  registerQuery<AgencyAuthorizationRow | null, AgauthByIdParams>(AGAUTH_QUERY_BY_ID, (db, p) => {
    return db.prepare<AgencyAuthorizationRow>(
      `${AGAUTH_SELECT} WHERE id = ? AND tenant_id = ? LIMIT 1`,
    ).get(p.id, p.tenantId) ?? null;
  });

  registerQuery<readonly AgencyAuthorizationRow[], AgauthListByPersonaParams>(AGAUTH_QUERY_LIST_BY_PERSONA, (db, p) => {
    return db.prepare<AgencyAuthorizationRow>(
      `${AGAUTH_SELECT} WHERE tenant_id = ? AND persona_id = ? ORDER BY granted_at DESC`,
    ).all(p.tenantId, p.personaId);
  });

  registerQuery<readonly AgencyAuthorizationRow[], AgauthListByPrincipalParams>(AGAUTH_QUERY_LIST_BY_PRINCIPAL, (db, p) => {
    return db.prepare<AgencyAuthorizationRow>(
      `${AGAUTH_SELECT} WHERE tenant_id = ? AND principal_user_id = ? ORDER BY granted_at DESC`,
    ).all(p.tenantId, p.principalUserId);
  });

  registerQuery<AgencyAuthorizationRow | null, AgauthByRevocationKeyParams>(AGAUTH_QUERY_BY_REVOCATION_KEY, (db, p) => {
    /* 租户隔离：同 tperm，按 key 查代理授权书须限定 tenant_id */
    return db.prepare<AgencyAuthorizationRow>(
      `${AGAUTH_SELECT} WHERE tenant_id = ? AND revocation_key = ? LIMIT 1`,
    ).get(p.tenantId, p.revocationKey) ?? null;
  });

  /* ── AgencyAuthorization Commands ──────────────────────────────── */

  registerCommand<AgencyAuthorizationCreateParams>(AGAUTH_CMD_CREATE, (db, p) => {
    const result = db.prepare<void>(
      `INSERT INTO agency_authorizations
         (id, tenant_id, persona_id, principal_user_id, scope, scope_description,
          allowed_tools_json, denied_tools_json, status,
          granted_at, expires_at, revoked_at, revocation_reason, revocation_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, NULL, NULL, ?)`,
    ).run(
      p.id, p.tenantId, p.personaId, p.principalUserId, p.scope, p.scopeDescription,
      p.allowedToolsJson, p.deniedToolsJson, p.grantedAt, p.expiresAt, p.revocationKey,
    );
    return { rowsAffected: result.changes };
  });

  registerCommand<AgauthRevokeParams>(AGAUTH_CMD_REVOKE, (db, p) => {
    const result = db.prepare<void>(
      `UPDATE agency_authorizations
          SET status = 'revoked', revoked_at = ?, revocation_reason = ?
        WHERE id = ? AND tenant_id = ? AND revoked_at IS NULL`,
    ).run(p.now, p.reason, p.id, p.tenantId);
    return { rowsAffected: result.changes };
  });

  registerCommand<AgauthSuspendParams>(AGAUTH_CMD_SUSPEND, (db, p) => {
    const result = db.prepare<void>(
      `UPDATE agency_authorizations SET status = 'suspended'
        WHERE id = ? AND tenant_id = ? AND status = 'active'`,
    ).run(p.id, p.tenantId);
    return { rowsAffected: result.changes };
  });

  registerCommand<AgauthSuspendParams>(AGAUTH_CMD_RESUME, (db, p) => {
    const result = db.prepare<void>(
      `UPDATE agency_authorizations SET status = 'active'
        WHERE id = ? AND tenant_id = ? AND status = 'suspended'`,
    ).run(p.id, p.tenantId);
    return { rowsAffected: result.changes };
  });

  /* ── ToolInvocation Queries ────────────────────────────────────── */

  registerQuery<ToolInvocationRow | null, TinvByIdParams>(TINV_QUERY_BY_ID, (db, p) => {
    return db.prepare<ToolInvocationRow>(
      `${TINV_SELECT} WHERE id = ? AND tenant_id = ? LIMIT 1`,
    ).get(p.id, p.tenantId) ?? null;
  });

  registerQuery<readonly ToolInvocationRow[], TinvListByPersonaParams>(TINV_QUERY_LIST_BY_PERSONA, (db, p) => {
    return db.prepare<ToolInvocationRow>(
      `${TINV_SELECT} WHERE tenant_id = ? AND persona_id = ?
        ORDER BY invoked_at DESC LIMIT ? OFFSET ?`,
    ).all(p.tenantId, p.personaId, p.limit, p.offset);
  });

  registerQuery<{ count: number } | null, TinvDailyCountParams>(TINV_QUERY_DAILY_COUNT, (db, p) => {
    const statusFilter = p.successOnly ? `AND status = 'success'` : '';
    return db.prepare<{ count: number }>(
      `SELECT COUNT(*) AS count
         FROM tool_invocations
        WHERE tenant_id = ? AND persona_id = ? AND tool_id = ?
          AND invoked_at >= ? ${statusFilter}`,
    ).get(p.tenantId, p.personaId, p.toolId, p.sinceMs) ?? null;
  });

  /* ── ToolInvocation Commands ───────────────────────────────────── */

  registerCommand<ToolInvocationRecordParams>(TINV_CMD_RECORD, (db, p) => {
    const result = db.prepare<void>(
      `INSERT INTO tool_invocations
         (id, tenant_id, persona_id, tool_id, invoker_type, invoker_id, invoker_user_id, status,
          input_hash, output_size_bytes, error_message, cost_cents, duration_ms,
          invoked_at, completed_at, confirmation_token_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      p.id, p.tenantId, p.personaId, p.toolId, p.invokerType, p.invokerId, p.invokerUserId, p.status,
      p.inputHash, p.outputSizeBytes, p.errorMessage, p.costCents, p.durationMs,
      p.invokedAt, p.completedAt, p.confirmationTokenId,
    );
    return { rowsAffected: result.changes };
  });

  registerCommand<TinvUpdateStatusParams>(TINV_CMD_UPDATE_STATUS, (db, p) => {
    const result = db.prepare<void>(
      `UPDATE tool_invocations
          SET status = ?, output_size_bytes = ?, error_message = ?,
              cost_cents = ?, duration_ms = ?, completed_at = ?
        WHERE id = ?`,
    ).run(
      p.status, p.outputSizeBytes, p.errorMessage,
      p.costCents, p.durationMs, p.completedAt, p.id,
    );
    return { rowsAffected: result.changes };
  });

  /* ── F3 待确认列表 / Token 反查 ────────────────────────────────────── */

  registerQuery<readonly ToolInvocationRow[], TinvPendingByUserParams>(TINV_QUERY_PENDING_BY_USER, (db, p) => {
    return db.prepare<ToolInvocationRow>(
      `${TINV_SELECT}
        WHERE tenant_id = ? AND invoker_user_id = ? AND status = 'pending_confirmation'
        ORDER BY invoked_at DESC
        LIMIT ?`,
    ).all(p.tenantId, p.userId, p.limit);
  });

  registerQuery<ToolInvocationRow | null, TinvByConfirmationTokenParams>(TINV_QUERY_BY_CONFIRMATION_TOKEN, (db, p) => {
    return db.prepare<ToolInvocationRow>(
      `${TINV_SELECT}
        WHERE tenant_id = ? AND confirmation_token_id = ?
        ORDER BY invoked_at DESC LIMIT 1`,
    ).get(p.tenantId, p.confirmationTokenId) ?? null;
  });

  /* ── F4 留存清理 ──────────────────────────────────────────────────── */

  registerCommand<TinvPruneBeforeParams>(TINV_CMD_PRUNE_BEFORE, (db, p) => {
    /* SQLite DELETE ... LIMIT 在标准发行版未启用，改用子查询限制批次 */
    const result = db.prepare<void>(
      `DELETE FROM tool_invocations
        WHERE id IN (
          SELECT id FROM tool_invocations
           WHERE invoked_at < ? AND status != 'pending_confirmation'
           ORDER BY invoked_at ASC
           LIMIT ?
        )`,
    ).run(p.cutoff, p.batchSize);
    return { rowsAffected: result.changes };
  });
}
