/**
 * Web adapter: tool_permission executors.
 *
 * Mirrors the SQLite executor surface but reads/writes through InMemoryTables.
 * Only the subset needed to demonstrate the round-trip is implemented;
 * extending coverage is mechanical.
 */

import {
  TPERM_QUERY_BY_PERSONA_TOOL,
  TPERM_QUERY_LIST_BY_PERSONA,
  TPERM_QUERY_BY_REVOCATION_KEY,
  TPERM_CMD_GRANT,
  TPERM_CMD_REVOKE,
  TPERM_CMD_REVOKE_BY_REVOCATION_KEY,
  type ToolPermissionGrantParams,
  type ToolPermissionRow,
  type TpermByPersonaToolParams,
  type TpermListByPersonaParams,
  type TpermByRevocationKeyParams,
  type TpermRevokeParams,
  type TpermRevokeByKeyParams,
} from '@chrono/kernel';
import type { ExecutorRegistry } from '../web-unit-of-work.js';
import { type Row } from '../in-memory-tables.js';

const TABLE = 'tool_permissions';

function rowToToolPermissionRow(row: Row): ToolPermissionRow {
  return row as unknown as ToolPermissionRow;
}

export function registerToolPermissionExecutors(registry: ExecutorRegistry): void {
  registry.registerQuery<ToolPermissionRow, TpermByPersonaToolParams>(
    TPERM_QUERY_BY_PERSONA_TOOL,
    (tables, p) => {
      if (!tables.hasTable(TABLE)) tables.defineTable(TABLE);
      const found = tables.find(TABLE, (row) =>
        row.tenant_id === p.tenantId
        && row.persona_id === p.personaId
        && row.tool_id === p.toolId,
      );
      return found ? rowToToolPermissionRow(found) : null;
    },
  );

  registry.registerQuery<readonly ToolPermissionRow[], TpermListByPersonaParams>(
    TPERM_QUERY_LIST_BY_PERSONA,
    (tables, p) => {
      if (!tables.hasTable(TABLE)) tables.defineTable(TABLE);
      const rows = tables.filter(TABLE, (row) =>
        row.tenant_id === p.tenantId && row.persona_id === p.personaId,
      );
      rows.sort((a, b) => Number(b.granted_at) - Number(a.granted_at));
      return rows.map(rowToToolPermissionRow);
    },
  );

  registry.registerQuery<ToolPermissionRow, TpermByRevocationKeyParams>(
    TPERM_QUERY_BY_REVOCATION_KEY,
    (tables, p) => {
      if (!tables.hasTable(TABLE)) tables.defineTable(TABLE);
      /* 租户隔离：与 SQLite 后端一致，按 key 查须同时限定 tenant_id */
      const found = tables.find(TABLE, (row) =>
        row.tenant_id === p.tenantId && row.revocation_key === p.revocationKey,
      );
      return found ? rowToToolPermissionRow(found) : null;
    },
  );

  registry.registerCommand<ToolPermissionGrantParams>(
    TPERM_CMD_GRANT,
    (tables, p) => {
      if (!tables.hasTable(TABLE)) tables.defineTable(TABLE);
      const existing = tables.find(TABLE, (row) =>
        row.tenant_id === p.tenantId
        && row.persona_id === p.personaId
        && row.tool_id === p.toolId,
      );
      const id = (existing?.id as string | undefined) ?? p.id;
      tables.upsert(TABLE, {
        id,
        tenant_id: p.tenantId,
        persona_id: p.personaId,
        tool_id: p.toolId,
        scope: p.scope,
        constraints_json: p.constraintsJson,
        granted_by: p.grantedBy,
        granted_at: p.now,
        expires_at: p.expiresAt,
        revoked_at: null,
        revocation_reason: null,
        revocation_key: p.revocationKey,
      });
      return { rowsAffected: 1 };
    },
  );

  registry.registerCommand<TpermRevokeParams>(TPERM_CMD_REVOKE, (tables, p) => {
    const existing = tables.find(TABLE, (row) => row.id === p.id && row.revoked_at === null);
    if (!existing) return { rowsAffected: 0 };
    tables.upsert(TABLE, { ...existing, revoked_at: p.now, revocation_reason: p.reason });
    return { rowsAffected: 1 };
  });

  registry.registerCommand<TpermRevokeByKeyParams>(
    TPERM_CMD_REVOKE_BY_REVOCATION_KEY,
    (tables, p) => {
      /* 租户隔离：撤销须同时限定 tenant_id，与 SQLite 后端一致 */
      const existing = tables.find(TABLE, (row) =>
        row.tenant_id === p.tenantId && row.revocation_key === p.revocationKey && row.revoked_at === null,
      );
      if (!existing) return { rowsAffected: 0 };
      tables.upsert(TABLE, { ...existing, revoked_at: p.now, revocation_reason: p.reason });
      return { rowsAffected: 1 };
    },
  );
}
