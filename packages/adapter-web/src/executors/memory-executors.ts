/**
 * Web adapter: memory_nodes executors (high-frequency subset).
 *
 * Covers insert / upsert / byId / all / count / delete. The wider memory
 * surface (consolidation, paginated, edges, working memory) is left for
 * later batches; the kinds keep their stable names so adding executors is
 * purely additive.
 */

import {
  MEM_QUERY_BY_ID,
  MEM_QUERY_ALL,
  MEM_QUERY_COUNT,
  MEM_CMD_INSERT,
  MEM_CMD_UPSERT,
  MEM_CMD_DELETE,
  MEM_CMD_DELETE_ALL,
  type MemInsertParams,
  type MemoryNode,
} from '@chrono/kernel';
import type { ExecutorRegistry } from '../web-unit-of-work.js';
import type { Row } from '../in-memory-tables.js';

const TABLE = 'memory_nodes';

function rowToNode(row: Row): MemoryNode {
  return {
    id: row['id'] as string,
    kind: row['kind'] as MemoryNode['kind'],
    content: String(row['content']),
    valence: Number(row['valence']),
    salience: Number(row['salience']),
    createdAt: Number(row['created_at']),
    lastAccessedAt: Number(row['last_accessed_at']),
    accessCount: Number(row['access_count'] ?? 0),
    decayLambda: Number(row['decay_lambda'] ?? 0),
    lastDecayedAt: Number(row['last_decayed_at'] ?? row['last_accessed_at']),
    consolidatedFrom: row['consolidated_from'] === null || row['consolidated_from'] === undefined
      ? null
      : String(row['consolidated_from']),
  };
}

function paramsToRow(p: MemInsertParams): Row {
  return {
    id: p.id,
    kind: p.kind,
    content: p.content,
    valence: p.valence,
    salience: p.salience,
    created_at: p.createdAt,
    last_accessed_at: p.lastAccessedAt,
    access_count: p.accessCount,
    decay_lambda: p.decayLambda,
    last_decayed_at: p.lastDecayedAt,
    consolidated_from: p.consolidatedFrom,
  };
}

export function registerMemoryExecutors(registry: ExecutorRegistry): void {
  registry.registerQuery<MemoryNode, { id: string }>(MEM_QUERY_BY_ID, (tables, p) => {
    if (!tables.hasTable(TABLE)) tables.defineTable(TABLE);
    const row = tables.find(TABLE, (r) => r['id'] === p.id);
    return row ? rowToNode(row) : null;
  });

  registry.registerQuery<MemoryNode, void>(MEM_QUERY_ALL, (tables) => {
    if (!tables.hasTable(TABLE)) tables.defineTable(TABLE);
    const rows = tables.filter(TABLE, () => true);
    rows.sort((a, b) => Number(b['created_at']) - Number(a['created_at']));
    return rows.map(rowToNode);
  });

  registry.registerQuery<{ count: number }, void>(MEM_QUERY_COUNT, (tables) => {
    if (!tables.hasTable(TABLE)) tables.defineTable(TABLE);
    return { count: tables.filter(TABLE, () => true).length };
  });

  registry.registerCommand<MemInsertParams>(MEM_CMD_INSERT, (tables, p) => {
    if (!tables.hasTable(TABLE)) tables.defineTable(TABLE);
    if (tables.find(TABLE, (r) => r['id'] === p.id)) {
      throw new Error(`memory node already exists: ${p.id}`);
    }
    tables.upsert(TABLE, paramsToRow(p));
    return { rowsAffected: 1 };
  });

  registry.registerCommand<MemInsertParams>(MEM_CMD_UPSERT, (tables, p) => {
    if (!tables.hasTable(TABLE)) tables.defineTable(TABLE);
    tables.upsert(TABLE, paramsToRow(p));
    return { rowsAffected: 1 };
  });

  registry.registerCommand<{ id: string }>(MEM_CMD_DELETE, (tables, p) => {
    if (!tables.hasTable(TABLE)) return { rowsAffected: 0 };
    return { rowsAffected: tables.delete(TABLE, p.id) ? 1 : 0 };
  });

  registry.registerCommand<void>(MEM_CMD_DELETE_ALL, (tables) => {
    if (!tables.hasTable(TABLE)) return { rowsAffected: 0 };
    const all = tables.filter(TABLE, () => true);
    for (const r of all) tables.delete(TABLE, String(r['id']));
    return { rowsAffected: all.length };
  });
}
