/**
 * Web adapter: narrative executors.
 *
 * Single-row-per-tenant store, modeled as a one-row-per-tenant table.
 */

import {
  NARRATIVE_QUERY_GET,
  NARRATIVE_CMD_SET,
  type NarrativeGetParams,
  type NarrativeSetParams,
} from '@chrono/kernel';
import type { ExecutorRegistry } from '../web-unit-of-work.js';

const TABLE = 'narrative';

interface NarrativeRow {
  id: string;
  tenant_id: string;
  content: string;
  updated_at: number;
}

export function registerNarrativeExecutors(registry: ExecutorRegistry): void {
  registry.registerQuery<string, NarrativeGetParams>(NARRATIVE_QUERY_GET, (tables, p) => {
    if (!tables.hasTable(TABLE)) tables.defineTable(TABLE);
    const row = tables.find(TABLE, (r) => r['tenant_id'] === p.tenantId);
    return row ? String((row as unknown as NarrativeRow).content ?? '') : null;
  });

  registry.registerCommand<NarrativeSetParams>(NARRATIVE_CMD_SET, (tables, p) => {
    if (!tables.hasTable(TABLE)) tables.defineTable(TABLE);
    const existing = tables.find(TABLE, (r) => r['tenant_id'] === p.tenantId);
    const id = existing?.['id'] !== undefined ? String(existing['id']) : `narr_${p.tenantId}`;
    tables.upsert(TABLE, {
      id,
      tenant_id: p.tenantId,
      content: p.content,
      updated_at: p.updatedAt,
    });
    return { rowsAffected: 1 };
  });
}
