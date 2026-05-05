/**
 * Web adapter: decision-style executors.
 *
 * Single-row-per-tenant store. Returns null when not yet set, mirroring
 * the SQLite executor's "first-call" semantics.
 */

import {
  DECISION_STYLE_QUERY_GET,
  DECISION_STYLE_CMD_SET,
  type DecisionStyleGetParams,
  type DecisionStyleRow,
  type DecisionStyleSetParams,
} from '@chrono/kernel';
import type { ExecutorRegistry } from '../web-unit-of-work.js';

const TABLE = 'decision_style';

export function registerDecisionStyleExecutors(registry: ExecutorRegistry): void {
  registry.registerQuery<DecisionStyleRow, DecisionStyleGetParams>(
    DECISION_STYLE_QUERY_GET,
    (tables, p) => {
      if (!tables.hasTable(TABLE)) tables.defineTable(TABLE);
      const row = tables.find(TABLE, (r) => r['tenant_id'] === p.tenantId);
      if (!row) return null;
      return {
        styleJson: row['style_json'] === null || row['style_json'] === undefined ? null : String(row['style_json']),
        updatedAt: Number(row['updated_at'] ?? 0),
      };
    },
  );

  registry.registerCommand<DecisionStyleSetParams>(DECISION_STYLE_CMD_SET, (tables, p) => {
    if (!tables.hasTable(TABLE)) tables.defineTable(TABLE);
    const existing = tables.find(TABLE, (r) => r['tenant_id'] === p.tenantId);
    const id = existing?.['id'] !== undefined ? String(existing['id']) : `ds_${p.tenantId}`;
    tables.upsert(TABLE, {
      id,
      tenant_id: p.tenantId,
      style_json: p.styleJson,
      updated_at: p.updatedAt,
    });
    return { rowsAffected: 1 };
  });
}
