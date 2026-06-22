/**
 * Web adapter: survival_anchors executors.
 *
 * Mirrors the SQLite executor surface for survival anchors in the single-tenant
 * local web store. Persona isolation is explicit via persona_id.
 */

import {
  ANCHOR_QUERY_BY_ID,
  ANCHOR_QUERY_ALL,
  ANCHOR_CMD_CREATE,
  ANCHOR_CMD_UPDATE,
  ANCHOR_CMD_DELETE,
  ANCHOR_CMD_DELETE_ALL,
  ANCHOR_CMD_UPSERT,
  type AnchorAllParams,
  type AnchorByIdParams,
  type CreateAnchorParams,
  type DeleteAllAnchorsParams,
  type DeleteAnchorParams,
  type SurvivalAnchor,
  type UpdateAnchorParams,
} from '@chrono/kernel';
import type { ExecutorRegistry } from '../web-unit-of-work.js';
import type { Row } from '../in-memory-tables.js';

const TABLE = 'survival_anchors';

/* ADR-0056 K5b：adapter-web 无 tenant rewriter，survival_anchors 只按 persona_id 隔离。
 * 所有新写入都落 persona_id，读取不做旧快照 default 回退。 */
function personaOf(row: Row): string {
  return row['persona_id'] as string;
}

function rowToAnchor(row: Row): SurvivalAnchor {
  return {
    id: row['id'] as string,
    label: row['label'] as string,
    kind: row['kind'] as SurvivalAnchor['kind'],
    value: JSON.parse(row['value_json'] as string),
    severity: row['severity'] as number,
    createdAt: row['created_at'] as number,
    updatedAt: row['updated_at'] as number,
  };
}

function anchorToRow(p: CreateAnchorParams): Row {
  return {
    id: p.id,
    persona_id: p.personaId,
    label: p.label,
    kind: p.kind,
    value_json: p.valueJson,
    severity: p.severity,
    created_at: p.createdAt,
    updated_at: p.updatedAt,
  };
}

export function registerAnchorExecutors(registry: ExecutorRegistry): void {
  registry.registerQuery<SurvivalAnchor, AnchorByIdParams>(ANCHOR_QUERY_BY_ID, (tables, p) => {
    if (!tables.hasTable(TABLE)) tables.defineTable(TABLE);
    const row = tables.find(TABLE, (r) => r['id'] === p.id && personaOf(r) === p.personaId);
    return row ? rowToAnchor(row) : null;
  });

  registry.registerQuery<SurvivalAnchor, AnchorAllParams>(ANCHOR_QUERY_ALL, (tables, p) => {
    if (!tables.hasTable(TABLE)) tables.defineTable(TABLE);
    const rows = tables.filter(TABLE, (r) => personaOf(r) === p.personaId);
    rows.sort((a, b) => Number(a['created_at']) - Number(b['created_at']));
    return rows.map(rowToAnchor);
  });

  registry.registerCommand<CreateAnchorParams>(ANCHOR_CMD_CREATE, (tables, p) => {
    if (!tables.hasTable(TABLE)) tables.defineTable(TABLE);
    if (tables.find(TABLE, (r) => r['id'] === p.id)) {
      throw new Error(`survival anchor already exists: ${p.id}`);
    }
    tables.upsert(TABLE, anchorToRow(p));
    return { rowsAffected: 1 };
  });

  registry.registerCommand<UpdateAnchorParams>(ANCHOR_CMD_UPDATE, (tables, p) => {
    if (!tables.hasTable(TABLE)) tables.defineTable(TABLE);
    const existing = tables.find(TABLE, (r) => r['id'] === p.id && personaOf(r) === p.personaId);
    if (!existing) return { rowsAffected: 0 };
    tables.upsert(TABLE, {
      ...existing,
      persona_id: p.personaId,
      label: p.label,
      kind: p.kind,
      value_json: p.valueJson,
      severity: p.severity,
      updated_at: p.updatedAt,
    });
    return { rowsAffected: 1 };
  });

  registry.registerCommand<DeleteAnchorParams>(ANCHOR_CMD_DELETE, (tables, p) => {
    if (!tables.hasTable(TABLE)) return { rowsAffected: 0 };
    const row = tables.find(TABLE, (r) => r['id'] === p.id && personaOf(r) === p.personaId);
    if (!row) return { rowsAffected: 0 };
    return { rowsAffected: tables.delete(TABLE, p.id) ? 1 : 0 };
  });

  registry.registerCommand<DeleteAllAnchorsParams>(ANCHOR_CMD_DELETE_ALL, (tables, p) => {
    if (!tables.hasTable(TABLE)) return { rowsAffected: 0 };
    const mine = tables.filter(TABLE, (r) => personaOf(r) === p.personaId);
    for (const row of mine) tables.delete(TABLE, String(row['id']));
    return { rowsAffected: mine.length };
  });

  registry.registerCommand<CreateAnchorParams>(ANCHOR_CMD_UPSERT, (tables, p) => {
    if (!tables.hasTable(TABLE)) tables.defineTable(TABLE);
    tables.upsert(TABLE, anchorToRow(p));
    return { rowsAffected: 1 };
  });
}
