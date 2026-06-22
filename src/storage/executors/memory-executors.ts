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
  MemByIdParams, MemAllParams, MemBatchParams, MemCountParams,
  MemConsolidatedFromParams, MemLowestSalienceParams,
  MemEdgeAllParams, MemEdgeForNodeParams, MemEdgeForNodesParams,
  MemEdgeDeleteForNodeParams, MemEdgeDeleteAllParams,
  MemWmAllParams, MemWmByIdParams, MemWmUpdateScoreParams, MemWmDeleteParams, MemWmDeleteAllParams,
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
  /* ADR-0056 K5b：memory_nodes / memory_edges 按 persona_id 显式隔离；tenant_id 仍由 TenantDatabase rewriter 注入。
   * working_memory 在 v106 没有 persona_id 列，因此通过 memory_nodes 子查询/JOIN 限定所属 persona，避免直接引用不存在列。 */
  /* ── Memory Node Queries ── */

  registerQuery<MemoryNode | null, MemByIdParams>(MEM_QUERY_BY_ID, (db, params) => {
    const row = db.prepare<MemoryRow>('SELECT * FROM memory_nodes WHERE id = ? AND persona_id = ?').get(params.id, params.personaId);
    return row ? toNode(row) : null;
  });

  registerQuery<MemoryNode[], MemAllParams>(MEM_QUERY_ALL, (db: IDatabase, params) => {
    return db.prepare<MemoryRow>('SELECT * FROM memory_nodes WHERE persona_id = ?').all(params.personaId).map(toNode);
  });

  registerQuery<MemoryNode[], MemBatchParams>(MEM_QUERY_BATCH, (db, params) => {
    if (params.ids.length === 0) return [];
    const placeholders = params.ids.map(() => '?').join(',');
    return db.prepare<MemoryRow>(
      `SELECT * FROM memory_nodes WHERE id IN (${placeholders}) AND persona_id = ?`,
    ).all(...params.ids, params.personaId).map(toNode);
  });

  registerQuery<MemPaginatedResult, MemPaginatedParams>(MEM_QUERY_PAGINATED, (db, params) => {
    const total = db.prepare<{ count: number }>('SELECT COUNT(*) as count FROM memory_nodes WHERE persona_id = ?').get(params.personaId)?.count ?? 0;
    /* 稳定排序：created_at 之外加 id 作为 tie-breaker，避免同一毫秒多条记忆在 LIMIT/OFFSET
     * 跨页时顺序不定导致重复或漏项。id 是 memory_nodes 主键（唯一，UUID——非单调，故同毫秒内
     * 不保证「后创建排前」，但能确保**稳定全序**，这正是分页去重/不漏所需。 */
    const rows = db.prepare<MemoryRow>(
      'SELECT * FROM memory_nodes WHERE persona_id = ? ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?',
    ).all(params.personaId, params.limit, params.offset);
    return { nodes: rows.map(toNode), total };
  });

  registerQuery<number, MemCountParams>(MEM_QUERY_COUNT, (db: IDatabase, params) => {
    return db.prepare<{ count: number }>('SELECT COUNT(*) as count FROM memory_nodes WHERE persona_id = ?').get(params.personaId)?.count ?? 0;
  });

  registerQuery<string[], MemConsolidationCandidatesParams>(MEM_QUERY_CONSOLIDATION_CANDIDATES, (db, params) => {
    const rows = db.prepare<{ id: string }>(
      `SELECT id FROM memory_nodes
       WHERE kind = 'episodic'
         AND persona_id = ?
         AND access_count >= ?
         AND salience >= ?
         AND consolidated_from IS NULL
         AND NOT EXISTS (SELECT 1 FROM memory_nodes AS m2 WHERE m2.consolidated_from = memory_nodes.id AND m2.persona_id = ?)`,
    ).all(params.personaId, params.accessThreshold, params.minSalience, params.personaId);
    return rows.map(r => r.id);
  });

  registerQuery<string | null, MemConsolidatedFromParams>(MEM_QUERY_CONSOLIDATED_FROM, (db, params) => {
    const row = db.prepare<{ id: string }>(
      'SELECT id FROM memory_nodes WHERE consolidated_from = ? AND persona_id = ? LIMIT 1',
    ).get(params.id, params.personaId);
    return row ? row.id : null;
  });

  registerQuery<Array<{ id: string; salience: number }>, MemLowestSalienceParams>(MEM_QUERY_LOWEST_SALIENCE, (db, params) => {
    return db.prepare<{ id: string; salience: number }>(
      'SELECT id, salience FROM memory_nodes WHERE persona_id = ? ORDER BY salience ASC, last_accessed_at ASC LIMIT ?',
    ).all(params.personaId, params.limit);
  });

  /* ── Memory Node Commands ── */

  registerCommand<MemInsertParams>(MEM_CMD_INSERT, (db, p) => {
    db.prepare<void>(
      `INSERT INTO memory_nodes (id, persona_id, kind, content, valence, salience, created_at, last_accessed_at, access_count, decay_lambda, last_decayed_at, consolidated_from)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(p.id, p.personaId, p.kind, p.content, p.valence, p.salience, p.createdAt, p.lastAccessedAt, p.accessCount, p.decayLambda, p.lastDecayedAt, p.consolidatedFrom);
    return { rowsAffected: 1 };
  });

  registerCommand<MemInsertParams>(MEM_CMD_UPSERT, (db, p) => {
    db.prepare<void>(
      `INSERT INTO memory_nodes (id, persona_id, kind, content, valence, salience, created_at, last_accessed_at, access_count, decay_lambda, last_decayed_at, consolidated_from)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET persona_id=excluded.persona_id, kind=excluded.kind, content=excluded.content, valence=excluded.valence, salience=excluded.salience, created_at=excluded.created_at, last_accessed_at=excluded.last_accessed_at, access_count=excluded.access_count, decay_lambda=excluded.decay_lambda, last_decayed_at=excluded.last_decayed_at, consolidated_from=excluded.consolidated_from`,
    ).run(p.id, p.personaId, p.kind, p.content, p.valence, p.salience, p.createdAt, p.lastAccessedAt, p.accessCount, p.decayLambda, p.lastDecayedAt, p.consolidatedFrom);
    return { rowsAffected: 1 };
  });

  registerCommand<MemUpdateAccessParams>(MEM_CMD_UPDATE_ACCESS, (db, p) => {
    const result = db.prepare<void>(
      'UPDATE memory_nodes SET salience = ?, last_accessed_at = ?, access_count = ?, decay_lambda = ?, last_decayed_at = ? WHERE id = ? AND persona_id = ?',
    ).run(p.salience, p.lastAccessedAt, p.accessCount, p.decayLambda, p.lastDecayedAt, p.id, p.personaId);
    return { rowsAffected: result.changes };
  });

  registerCommand<MemUpdateSalienceParams>(MEM_CMD_UPDATE_SALIENCE, (db, p) => {
    const result = db.prepare<void>(
      'UPDATE memory_nodes SET salience = ?, last_decayed_at = ? WHERE id = ? AND persona_id = ?',
    ).run(p.salience, p.lastDecayedAt, p.id, p.personaId);
    return { rowsAffected: result.changes };
  });

  registerCommand<MemUpdateSalienceDeltaParams>(MEM_CMD_UPDATE_SALIENCE_DELTA, (db, p) => {
    const result = db.prepare<void>(
      'UPDATE memory_nodes SET salience = MIN(1.0, salience + ?) WHERE id = ? AND persona_id = ?',
    ).run(p.delta, p.id, p.personaId);
    return { rowsAffected: result.changes };
  });

  registerCommand<MemByIdParams>(MEM_CMD_DELETE, (db, p) => {
    const result = db.prepare<void>('DELETE FROM memory_nodes WHERE id = ? AND persona_id = ?').run(p.id, p.personaId);
    return { rowsAffected: result.changes };
  });

  registerCommand<MemAllParams>(MEM_CMD_DELETE_ALL, (db: IDatabase, p) => {
    db.prepare<void>('DELETE FROM memory_nodes WHERE persona_id = ?').run(p.personaId);
    return { rowsAffected: 0 };
  });

  /* ── Edge Queries ── */

  registerQuery<MemoryEdge[], MemEdgeAllParams>(MEM_EDGE_QUERY_ALL, (db: IDatabase, params) => {
    return db.prepare<EdgeRow>('SELECT * FROM memory_edges WHERE persona_id = ?').all(params.personaId).map(toEdge);
  });

  registerQuery<MemoryEdge[], MemEdgeForNodeParams>(MEM_EDGE_QUERY_FOR_NODE, (db, params) => {
    return db.prepare<EdgeRow>(
      'SELECT * FROM memory_edges WHERE persona_id = ? AND (source = ? OR target = ?)',
    ).all(params.personaId, params.id, params.id).map(toEdge);
  });

  registerQuery<MemoryEdge[], MemEdgeForNodesParams>(MEM_EDGE_QUERY_FOR_NODES, (db, params) => {
    if (params.ids.length === 0) return [];
    const placeholders = params.ids.map(() => '?').join(',');
    return db.prepare<EdgeRow>(
      `SELECT * FROM memory_edges WHERE persona_id = ? AND (source IN (${placeholders}) OR target IN (${placeholders}))`,
    ).all(params.personaId, ...params.ids, ...params.ids).map(toEdge);
  });

  /* ── Edge Commands ── */

  registerCommand<MemEdgeUpsertParams>(MEM_EDGE_CMD_UPSERT, (db, p) => {
    db.prepare<void>(
      `INSERT INTO memory_edges (source, target, persona_id, strength, relation) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(source, target) DO UPDATE SET persona_id=excluded.persona_id, strength=excluded.strength, relation=excluded.relation`,
    ).run(p.source, p.target, p.personaId, p.strength, p.relation);
    return { rowsAffected: 1 };
  });

  registerCommand<MemEdgeDeleteForNodeParams>(MEM_EDGE_CMD_DELETE_FOR_NODE, (db, p) => {
    const result = db.prepare<void>(
      'DELETE FROM memory_edges WHERE persona_id = ? AND (source = ? OR target = ?)',
    ).run(p.personaId, p.id, p.id);
    return { rowsAffected: result.changes };
  });

  registerCommand<MemEdgeDeleteAllParams>(MEM_EDGE_CMD_DELETE_ALL, (db: IDatabase, p) => {
    db.prepare<void>('DELETE FROM memory_edges WHERE persona_id = ?').run(p.personaId);
    return { rowsAffected: 0 };
  });

  /* ── Working Memory Queries ── */

  registerQuery<WorkingMemorySlot[], MemWmAllParams>(MEM_WM_QUERY_SLOTS, (db: IDatabase, params) => {
    return db.prepare<WorkingMemoryRow>(
      `SELECT * FROM working_memory
       WHERE EXISTS (SELECT 1 FROM memory_nodes mn WHERE mn.id = working_memory.memory_id AND mn.persona_id = ?)
       ORDER BY score DESC`,
    ).all(params.personaId).map(toSlot);
  });

  registerQuery<WorkingMemorySlot | null, MemWmByIdParams>(MEM_WM_QUERY_BY_ID, (db, params) => {
    const row = db.prepare<WorkingMemoryRow>(
      `SELECT * FROM working_memory
       WHERE memory_id = ?
         AND EXISTS (SELECT 1 FROM memory_nodes mn WHERE mn.id = working_memory.memory_id AND mn.persona_id = ?)`,
    ).get(params.memoryId, params.personaId);
    return row ? toSlot(row) : null;
  });

  registerQuery<number, MemWmAllParams>(MEM_WM_QUERY_COUNT, (db: IDatabase, params) => {
    return db.prepare<{ cnt: number }>(
      `SELECT COUNT(*) AS cnt FROM working_memory
       WHERE EXISTS (SELECT 1 FROM memory_nodes mn WHERE mn.id = working_memory.memory_id AND mn.persona_id = ?)`,
    ).get(params.personaId)!.cnt;
  });

  registerQuery<WorkingMemorySlot | null, MemWmAllParams>(MEM_WM_QUERY_LOWEST, (db: IDatabase, params) => {
    const row = db.prepare<WorkingMemoryRow>(
      `SELECT * FROM working_memory
       WHERE EXISTS (SELECT 1 FROM memory_nodes mn WHERE mn.id = working_memory.memory_id AND mn.persona_id = ?)
       ORDER BY score ASC LIMIT 1`,
    ).get(params.personaId);
    return row ? toSlot(row) : null;
  });

  registerQuery<WorkingMemorySlot[], MemWmAllParams>(MEM_WM_QUERY_ALL_RAW, (db: IDatabase, params) => {
    return db.prepare<WorkingMemoryRow>(
      `SELECT * FROM working_memory
       WHERE EXISTS (SELECT 1 FROM memory_nodes mn WHERE mn.id = working_memory.memory_id AND mn.persona_id = ?)`,
    ).all(params.personaId).map(toSlot);
  });

  /* ── Working Memory Commands ── */

  registerCommand<MemWmInsertParams>(MEM_WM_CMD_INSERT, (db, p) => {
    const belongs = db.prepare<{ id: string }>(
      'SELECT id FROM memory_nodes WHERE id = ? AND persona_id = ?',
    ).get(p.memoryId, p.personaId);
    if (!belongs) return { rowsAffected: 0 };
    db.prepare<void>(
      'INSERT INTO working_memory (memory_id, score, entered_at) VALUES (?, ?, ?)',
    ).run(p.memoryId, p.score, p.enteredAt);
    return { rowsAffected: 1 };
  });

  registerCommand<MemWmUpdateScoreParams>(MEM_WM_CMD_UPDATE_SCORE, (db, p) => {
    const result = db.prepare<void>(
      `UPDATE working_memory SET score = ?
       WHERE memory_id = ?
         AND EXISTS (SELECT 1 FROM memory_nodes WHERE id = working_memory.memory_id AND persona_id = ?)`,
    ).run(p.score, p.memoryId, p.personaId);
    return { rowsAffected: result.changes };
  });

  registerCommand<MemWmDeleteParams>(MEM_WM_CMD_DELETE, (db, p) => {
    const result = db.prepare<void>(
      `DELETE FROM working_memory
       WHERE memory_id = ?
         AND EXISTS (SELECT 1 FROM memory_nodes WHERE id = working_memory.memory_id AND persona_id = ?)`,
    ).run(p.memoryId, p.personaId);
    return { rowsAffected: result.changes };
  });

  registerCommand<MemWmDeleteAllParams>(MEM_WM_CMD_DELETE_ALL, (db: IDatabase, p) => {
    db.prepare<void>(
      `DELETE FROM working_memory
       WHERE EXISTS (SELECT 1 FROM memory_nodes WHERE id = working_memory.memory_id AND persona_id = ?)`,
    ).run(p.personaId);
    return { rowsAffected: 0 };
  });
}
