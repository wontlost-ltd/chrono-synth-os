/**
 * 认知记忆图 SQL 执行器 — 将内核 Query/Command kind 映射到 db.prepare 调用
 */

import type { IDatabase } from '../database.js';
import { registerQuery, registerCommand } from '../legacy-sync-bridge.js';
import type {
  MemoryNode, MemoryEdge, WorkingMemorySlot,
  MemInsertParams, MemUpdateAccessParams, MemUpdateSalienceParams,
  MemUpdateSalienceDeltaParams, MemPaginatedParams, MemPaginatedResult,
  MemConsolidationCandidatesParams, MemEdgeUpsertParams, MemWmInsertParams,
} from '@chrono/kernel';
import {
  MEM_QUERY_BY_ID, MEM_QUERY_ALL, MEM_QUERY_BATCH, MEM_QUERY_PAGINATED,
  MEM_QUERY_COUNT, MEM_QUERY_CONSOLIDATION_CANDIDATES, MEM_QUERY_CONSOLIDATED_FROM,
  MEM_QUERY_LOWEST_SALIENCE,
  MEM_CMD_INSERT, MEM_CMD_UPSERT, MEM_CMD_UPDATE_ACCESS, MEM_CMD_UPDATE_SALIENCE,
  MEM_CMD_UPDATE_SALIENCE_DELTA, MEM_CMD_DELETE, MEM_CMD_DELETE_ALL,
  MEM_EDGE_QUERY_ALL, MEM_EDGE_QUERY_FOR_NODE, MEM_EDGE_QUERY_FOR_NODES,
  MEM_EDGE_CMD_UPSERT, MEM_EDGE_CMD_DELETE_FOR_NODE, MEM_EDGE_CMD_DELETE_ALL,
  MEM_WM_QUERY_SLOTS, MEM_WM_QUERY_BY_ID, MEM_WM_QUERY_COUNT,
  MEM_WM_QUERY_LOWEST, MEM_WM_QUERY_ALL_RAW,
  MEM_WM_CMD_INSERT, MEM_WM_CMD_UPDATE_SCORE, MEM_WM_CMD_DELETE, MEM_WM_CMD_DELETE_ALL,
} from '@chrono/kernel';

/* ── 行类型映射 ── */

interface MemoryRow {
  id: string;
  kind: string;
  content: string;
  valence: number;
  salience: number;
  created_at: number;
  last_accessed_at: number;
  access_count: number;
  decay_lambda: number;
  last_decayed_at: number;
  consolidated_from: string | null;
}

interface EdgeRow {
  source: string;
  target: string;
  strength: number;
  relation: string;
}

interface WorkingMemoryRow {
  memory_id: string;
  score: number;
  entered_at: number;
}

/* ── 行转换 ── */

function toNode(row: MemoryRow): MemoryNode {
  return {
    id: row.id,
    kind: row.kind as MemoryNode['kind'],
    content: row.content,
    valence: row.valence,
    salience: row.salience,
    createdAt: row.created_at,
    lastAccessedAt: row.last_accessed_at,
    accessCount: row.access_count,
    decayLambda: row.decay_lambda,
    lastDecayedAt: row.last_decayed_at,
    consolidatedFrom: row.consolidated_from,
  };
}

function toEdge(row: EdgeRow): MemoryEdge {
  return { source: row.source, target: row.target, strength: row.strength, relation: row.relation };
}

function toSlot(row: WorkingMemoryRow): WorkingMemorySlot {
  return { memoryId: row.memory_id, score: row.score, enteredAt: row.entered_at };
}

/* ── 注册 ── */

export function registerMemoryExecutors(): void {
  /* ── Memory Node Queries ── */

  registerQuery<MemoryNode | null, { id: string }>(MEM_QUERY_BY_ID, (db, params) => {
    const row = db.prepare<MemoryRow>('SELECT * FROM memory_nodes WHERE id = ?').get(params.id);
    return row ? toNode(row) : null;
  });

  registerQuery<MemoryNode[], void>(MEM_QUERY_ALL, (db: IDatabase) => {
    return db.prepare<MemoryRow>('SELECT * FROM memory_nodes').all().map(toNode);
  });

  registerQuery<MemoryNode[], { ids: string[] }>(MEM_QUERY_BATCH, (db, params) => {
    if (params.ids.length === 0) return [];
    const placeholders = params.ids.map(() => '?').join(',');
    return db.prepare<MemoryRow>(
      `SELECT * FROM memory_nodes WHERE id IN (${placeholders})`,
    ).all(...params.ids).map(toNode);
  });

  registerQuery<MemPaginatedResult, MemPaginatedParams>(MEM_QUERY_PAGINATED, (db, params) => {
    const total = db.prepare<{ count: number }>('SELECT COUNT(*) as count FROM memory_nodes').get()?.count ?? 0;
    const rows = db.prepare<MemoryRow>(
      'SELECT * FROM memory_nodes ORDER BY created_at DESC LIMIT ? OFFSET ?',
    ).all(params.limit, params.offset);
    return { nodes: rows.map(toNode), total };
  });

  registerQuery<number, void>(MEM_QUERY_COUNT, (db: IDatabase) => {
    return db.prepare<{ count: number }>('SELECT COUNT(*) as count FROM memory_nodes').get()?.count ?? 0;
  });

  registerQuery<string[], MemConsolidationCandidatesParams>(MEM_QUERY_CONSOLIDATION_CANDIDATES, (db, params) => {
    const rows = db.prepare<{ id: string }>(
      `SELECT id FROM memory_nodes
       WHERE kind = 'episodic'
         AND access_count >= ?
         AND salience >= ?
         AND consolidated_from IS NULL
         AND NOT EXISTS (SELECT 1 FROM memory_nodes AS m2 WHERE m2.consolidated_from = memory_nodes.id)`,
    ).all(params.accessThreshold, params.minSalience);
    return rows.map(r => r.id);
  });

  registerQuery<string | null, { id: string }>(MEM_QUERY_CONSOLIDATED_FROM, (db, params) => {
    const row = db.prepare<{ id: string }>(
      'SELECT id FROM memory_nodes WHERE consolidated_from = ? LIMIT 1',
    ).get(params.id);
    return row ? row.id : null;
  });

  registerQuery<Array<{ id: string; salience: number }>, { limit: number }>(MEM_QUERY_LOWEST_SALIENCE, (db, params) => {
    return db.prepare<{ id: string; salience: number }>(
      'SELECT id, salience FROM memory_nodes ORDER BY salience ASC, last_accessed_at ASC LIMIT ?',
    ).all(params.limit);
  });

  /* ── Memory Node Commands ── */

  registerCommand<MemInsertParams>(MEM_CMD_INSERT, (db, p) => {
    db.prepare<void>(
      `INSERT INTO memory_nodes (id, kind, content, valence, salience, created_at, last_accessed_at, access_count, decay_lambda, last_decayed_at, consolidated_from)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(p.id, p.kind, p.content, p.valence, p.salience, p.createdAt, p.lastAccessedAt, p.accessCount, p.decayLambda, p.lastDecayedAt, p.consolidatedFrom);
    return { rowsAffected: 1 };
  });

  registerCommand<MemInsertParams>(MEM_CMD_UPSERT, (db, p) => {
    db.prepare<void>(
      `INSERT INTO memory_nodes (id, kind, content, valence, salience, created_at, last_accessed_at, access_count, decay_lambda, last_decayed_at, consolidated_from)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET kind=excluded.kind, content=excluded.content, valence=excluded.valence, salience=excluded.salience, created_at=excluded.created_at, last_accessed_at=excluded.last_accessed_at, access_count=excluded.access_count, decay_lambda=excluded.decay_lambda, last_decayed_at=excluded.last_decayed_at, consolidated_from=excluded.consolidated_from`,
    ).run(p.id, p.kind, p.content, p.valence, p.salience, p.createdAt, p.lastAccessedAt, p.accessCount, p.decayLambda, p.lastDecayedAt, p.consolidatedFrom);
    return { rowsAffected: 1 };
  });

  registerCommand<MemUpdateAccessParams>(MEM_CMD_UPDATE_ACCESS, (db, p) => {
    const result = db.prepare<void>(
      'UPDATE memory_nodes SET salience = ?, last_accessed_at = ?, access_count = ?, decay_lambda = ?, last_decayed_at = ? WHERE id = ?',
    ).run(p.salience, p.lastAccessedAt, p.accessCount, p.decayLambda, p.lastDecayedAt, p.id);
    return { rowsAffected: result.changes };
  });

  registerCommand<MemUpdateSalienceParams>(MEM_CMD_UPDATE_SALIENCE, (db, p) => {
    const result = db.prepare<void>(
      'UPDATE memory_nodes SET salience = ?, last_decayed_at = ? WHERE id = ?',
    ).run(p.salience, p.lastDecayedAt, p.id);
    return { rowsAffected: result.changes };
  });

  registerCommand<MemUpdateSalienceDeltaParams>(MEM_CMD_UPDATE_SALIENCE_DELTA, (db, p) => {
    const result = db.prepare<void>(
      'UPDATE memory_nodes SET salience = MIN(1.0, salience + ?) WHERE id = ?',
    ).run(p.delta, p.id);
    return { rowsAffected: result.changes };
  });

  registerCommand<{ id: string }>(MEM_CMD_DELETE, (db, p) => {
    const result = db.prepare<void>('DELETE FROM memory_nodes WHERE id = ?').run(p.id);
    return { rowsAffected: result.changes };
  });

  registerCommand<void>(MEM_CMD_DELETE_ALL, (db: IDatabase) => {
    db.prepare<void>('DELETE FROM memory_nodes WHERE 1=1').run();
    return { rowsAffected: 0 };
  });

  /* ── Edge Queries ── */

  registerQuery<MemoryEdge[], void>(MEM_EDGE_QUERY_ALL, (db: IDatabase) => {
    return db.prepare<EdgeRow>('SELECT * FROM memory_edges').all().map(toEdge);
  });

  registerQuery<MemoryEdge[], { id: string }>(MEM_EDGE_QUERY_FOR_NODE, (db, params) => {
    return db.prepare<EdgeRow>(
      'SELECT * FROM memory_edges WHERE source = ? OR target = ?',
    ).all(params.id, params.id).map(toEdge);
  });

  registerQuery<MemoryEdge[], { ids: string[] }>(MEM_EDGE_QUERY_FOR_NODES, (db, params) => {
    if (params.ids.length === 0) return [];
    const placeholders = params.ids.map(() => '?').join(',');
    return db.prepare<EdgeRow>(
      `SELECT * FROM memory_edges WHERE source IN (${placeholders}) OR target IN (${placeholders})`,
    ).all(...params.ids, ...params.ids).map(toEdge);
  });

  /* ── Edge Commands ── */

  registerCommand<MemEdgeUpsertParams>(MEM_EDGE_CMD_UPSERT, (db, p) => {
    db.prepare<void>(
      `INSERT INTO memory_edges (source, target, strength, relation) VALUES (?, ?, ?, ?)
       ON CONFLICT(source, target) DO UPDATE SET strength=excluded.strength, relation=excluded.relation`,
    ).run(p.source, p.target, p.strength, p.relation);
    return { rowsAffected: 1 };
  });

  registerCommand<{ id: string }>(MEM_EDGE_CMD_DELETE_FOR_NODE, (db, p) => {
    const result = db.prepare<void>(
      'DELETE FROM memory_edges WHERE source = ? OR target = ?',
    ).run(p.id, p.id);
    return { rowsAffected: result.changes };
  });

  registerCommand<void>(MEM_EDGE_CMD_DELETE_ALL, (db: IDatabase) => {
    db.prepare<void>('DELETE FROM memory_edges WHERE 1=1').run();
    return { rowsAffected: 0 };
  });

  /* ── Working Memory Queries ── */

  registerQuery<WorkingMemorySlot[], void>(MEM_WM_QUERY_SLOTS, (db: IDatabase) => {
    return db.prepare<WorkingMemoryRow>(
      'SELECT * FROM working_memory ORDER BY score DESC',
    ).all().map(toSlot);
  });

  registerQuery<WorkingMemorySlot | null, { memoryId: string }>(MEM_WM_QUERY_BY_ID, (db, params) => {
    const row = db.prepare<WorkingMemoryRow>(
      'SELECT * FROM working_memory WHERE memory_id = ?',
    ).get(params.memoryId);
    return row ? toSlot(row) : null;
  });

  registerQuery<number, void>(MEM_WM_QUERY_COUNT, (db: IDatabase) => {
    return db.prepare<{ cnt: number }>('SELECT COUNT(*) AS cnt FROM working_memory').get()!.cnt;
  });

  registerQuery<WorkingMemorySlot | null, void>(MEM_WM_QUERY_LOWEST, (db: IDatabase) => {
    const row = db.prepare<WorkingMemoryRow>(
      'SELECT * FROM working_memory ORDER BY score ASC LIMIT 1',
    ).get();
    return row ? toSlot(row) : null;
  });

  registerQuery<WorkingMemorySlot[], void>(MEM_WM_QUERY_ALL_RAW, (db: IDatabase) => {
    return db.prepare<WorkingMemoryRow>('SELECT * FROM working_memory').all().map(toSlot);
  });

  /* ── Working Memory Commands ── */

  registerCommand<MemWmInsertParams>(MEM_WM_CMD_INSERT, (db, p) => {
    db.prepare<void>(
      'INSERT INTO working_memory (memory_id, score, entered_at) VALUES (?, ?, ?)',
    ).run(p.memoryId, p.score, p.enteredAt);
    return { rowsAffected: 1 };
  });

  registerCommand<{ memoryId: string; score: number }>(MEM_WM_CMD_UPDATE_SCORE, (db, p) => {
    const result = db.prepare<void>(
      'UPDATE working_memory SET score = ? WHERE memory_id = ?',
    ).run(p.score, p.memoryId);
    return { rowsAffected: result.changes };
  });

  registerCommand<{ memoryId: string }>(MEM_WM_CMD_DELETE, (db, p) => {
    const result = db.prepare<void>(
      'DELETE FROM working_memory WHERE memory_id = ?',
    ).run(p.memoryId);
    return { rowsAffected: result.changes };
  });

  registerCommand<void>(MEM_WM_CMD_DELETE_ALL, (db: IDatabase) => {
    db.prepare<void>('DELETE FROM working_memory WHERE 1=1').run();
    return { rowsAffected: 0 };
  });
}
