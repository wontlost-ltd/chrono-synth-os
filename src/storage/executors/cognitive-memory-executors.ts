/**
 * 人格认知记忆 SQL 执行器
 */

import { registerQuery, registerCommand } from '../legacy-sync-bridge.js';
import {
  PCMEM_QUERY_NODE_BY_ID, PCMEM_QUERY_NODE_BY_SOURCE, PCMEM_QUERY_NODE_BY_KNOWLEDGE,
  PCMEM_QUERY_RECENT_NODES, PCMEM_QUERY_LIST_NODES, PCMEM_QUERY_LIST_NODES_BY_KINDS,
  PCMEM_QUERY_BATCH_NODES, PCMEM_QUERY_COUNT_NODES, PCMEM_QUERY_COUNT_EDGES,
  PCMEM_QUERY_EDGES_BY_FRONTIER, PCMEM_QUERY_ALL_EDGES,
  PCMEM_QUERY_WM_ALL_SLOTS, PCMEM_QUERY_WM_SLOTS_ORDERED,
  PCMEM_QUERY_WM_SLOT_BY_MEM, PCMEM_QUERY_WM_COUNT, PCMEM_QUERY_WM_LOWEST,
  PCMEM_CMD_INSERT_NODE, PCMEM_CMD_UPSERT_EDGE,
  PCMEM_CMD_WM_DELETE_SLOT, PCMEM_CMD_WM_UPDATE_SCORE, PCMEM_CMD_WM_INSERT_SLOT,
} from '@chrono/kernel';
import type {
  PcmemNodeRow, PcmemEdgeRow, PcmemWmRow, PcmemCountRow,
  PcmemNodeByIdParams, PcmemNodeBySourceParams, PcmemNodeByKnowledgeParams,
  PcmemRecentNodesParams, PcmemListNodesParams, PcmemListNodesByKindsParams,
  PcmemBatchNodesParams, PcmemTenantPersonaParams, PcmemEdgesByFrontierParams,
  PcmemInsertNodeParams, PcmemUpsertEdgeParams,
  PcmemWmSlotParams, PcmemWmUpdateScoreParams, PcmemWmInsertSlotParams,
} from '@chrono/kernel';

export function registerCognitiveMemoryExecutors(): void {
  /* ── Node 查询 ── */

  registerQuery<PcmemNodeRow | null, PcmemNodeByIdParams>(PCMEM_QUERY_NODE_BY_ID, (db, p) => {
    return db.prepare<PcmemNodeRow>(
      `SELECT * FROM persona_memory_nodes
       WHERE tenant_id = ? AND persona_id = ? AND id = ?
       LIMIT 1`,
    ).get(p.tenantId, p.personaId, p.memoryId) ?? null;
  });

  registerQuery<PcmemNodeRow | null, PcmemNodeBySourceParams>(PCMEM_QUERY_NODE_BY_SOURCE, (db, p) => {
    return db.prepare<PcmemNodeRow>(
      `SELECT * FROM persona_memory_nodes
       WHERE tenant_id = ? AND persona_id = ? AND source_memory_id = ?
       LIMIT 1`,
    ).get(p.tenantId, p.personaId, p.sourceMemoryId) ?? null;
  });

  registerQuery<PcmemNodeRow | null, PcmemNodeByKnowledgeParams>(PCMEM_QUERY_NODE_BY_KNOWLEDGE, (db, p) => {
    return db.prepare<PcmemNodeRow>(
      `SELECT * FROM persona_memory_nodes
       WHERE tenant_id = ? AND persona_id = ? AND knowledge_item_id = ?
       LIMIT 1`,
    ).get(p.tenantId, p.personaId, p.knowledgeItemId) ?? null;
  });

  registerQuery<readonly PcmemNodeRow[], PcmemRecentNodesParams>(PCMEM_QUERY_RECENT_NODES, (db, p) => {
    return db.prepare<PcmemNodeRow>(
      `SELECT * FROM persona_memory_nodes
       WHERE tenant_id = ? AND persona_id = ? AND id != ?
       ORDER BY created_at DESC
       LIMIT 4`,
    ).all(p.tenantId, p.personaId, p.excludeId);
  });

  registerQuery<readonly PcmemNodeRow[], PcmemListNodesParams>(PCMEM_QUERY_LIST_NODES, (db, p) => {
    return db.prepare<PcmemNodeRow>(
      `SELECT * FROM persona_memory_nodes
       WHERE tenant_id = ? AND persona_id = ?
       ORDER BY created_at DESC
       LIMIT ?`,
    ).all(p.tenantId, p.personaId, p.limit);
  });

  registerQuery<readonly PcmemNodeRow[], PcmemListNodesByKindsParams>(PCMEM_QUERY_LIST_NODES_BY_KINDS, (db, p) => {
    if (p.kinds.length === 0) return [];
    const placeholders = p.kinds.map(() => '?').join(',');
    return db.prepare<PcmemNodeRow>(
      `SELECT * FROM persona_memory_nodes
       WHERE tenant_id = ? AND persona_id = ? AND kind IN (${placeholders})
       ORDER BY created_at DESC
       LIMIT ?`,
    ).all(p.tenantId, p.personaId, ...p.kinds, p.limit);
  });

  registerQuery<readonly PcmemNodeRow[], PcmemBatchNodesParams>(PCMEM_QUERY_BATCH_NODES, (db, p) => {
    if (p.ids.length === 0) return [];
    const placeholders = p.ids.map(() => '?').join(',');
    return db.prepare<PcmemNodeRow>(
      `SELECT * FROM persona_memory_nodes
       WHERE tenant_id = ? AND persona_id = ? AND id IN (${placeholders})`,
    ).all(p.tenantId, p.personaId, ...p.ids);
  });

  registerQuery<PcmemCountRow | null, PcmemTenantPersonaParams>(PCMEM_QUERY_COUNT_NODES, (db, p) => {
    const row = db.prepare<{ count: number | bigint }>(
      `SELECT COUNT(*) AS count FROM persona_memory_nodes
       WHERE tenant_id = ? AND persona_id = ?`,
    ).get(p.tenantId, p.personaId);
    if (!row) return null;
    return { count: Number(row.count) };
  });

  registerQuery<PcmemCountRow | null, PcmemTenantPersonaParams>(PCMEM_QUERY_COUNT_EDGES, (db, p) => {
    const row = db.prepare<{ count: number | bigint }>(
      `SELECT COUNT(*) AS count FROM persona_memory_edges
       WHERE tenant_id = ? AND persona_id = ?`,
    ).get(p.tenantId, p.personaId);
    if (!row) return null;
    return { count: Number(row.count) };
  });

  /* ── Edge 查询 ── */

  registerQuery<readonly PcmemEdgeRow[], PcmemEdgesByFrontierParams>(PCMEM_QUERY_EDGES_BY_FRONTIER, (db, p) => {
    if (p.frontier.length === 0) return [];
    const placeholders = p.frontier.map(() => '?').join(',');
    return db.prepare<PcmemEdgeRow>(
      `SELECT * FROM persona_memory_edges
       WHERE tenant_id = ? AND persona_id = ?
         AND (source IN (${placeholders}) OR target IN (${placeholders}))`,
    ).all(p.tenantId, p.personaId, ...p.frontier, ...p.frontier);
  });

  registerQuery<readonly PcmemEdgeRow[], PcmemTenantPersonaParams>(PCMEM_QUERY_ALL_EDGES, (db, p) => {
    return db.prepare<PcmemEdgeRow>(
      `SELECT * FROM persona_memory_edges
       WHERE tenant_id = ? AND persona_id = ?`,
    ).all(p.tenantId, p.personaId);
  });

  /* ── Working Memory 查询 ── */

  registerQuery<readonly PcmemWmRow[], PcmemTenantPersonaParams>(PCMEM_QUERY_WM_ALL_SLOTS, (db, p) => {
    return db.prepare<PcmemWmRow>(
      `SELECT * FROM persona_working_memory
       WHERE tenant_id = ? AND persona_id = ?`,
    ).all(p.tenantId, p.personaId);
  });

  registerQuery<readonly PcmemWmRow[], PcmemTenantPersonaParams>(PCMEM_QUERY_WM_SLOTS_ORDERED, (db, p) => {
    return db.prepare<PcmemWmRow>(
      `SELECT * FROM persona_working_memory
       WHERE tenant_id = ? AND persona_id = ?
       ORDER BY score DESC`,
    ).all(p.tenantId, p.personaId);
  });

  registerQuery<PcmemWmRow | null, PcmemWmSlotParams>(PCMEM_QUERY_WM_SLOT_BY_MEM, (db, p) => {
    return db.prepare<PcmemWmRow>(
      `SELECT * FROM persona_working_memory
       WHERE tenant_id = ? AND persona_id = ? AND memory_id = ?`,
    ).get(p.tenantId, p.personaId, p.memoryId) ?? null;
  });

  registerQuery<PcmemCountRow | null, PcmemTenantPersonaParams>(PCMEM_QUERY_WM_COUNT, (db, p) => {
    const row = db.prepare<{ count: number | bigint }>(
      `SELECT COUNT(*) AS count FROM persona_working_memory
       WHERE tenant_id = ? AND persona_id = ?`,
    ).get(p.tenantId, p.personaId);
    if (!row) return null;
    return { count: Number(row.count) };
  });

  registerQuery<PcmemWmRow | null, PcmemTenantPersonaParams>(PCMEM_QUERY_WM_LOWEST, (db, p) => {
    return db.prepare<PcmemWmRow>(
      `SELECT * FROM persona_working_memory
       WHERE tenant_id = ? AND persona_id = ?
       ORDER BY score ASC
       LIMIT 1`,
    ).get(p.tenantId, p.personaId) ?? null;
  });

  /* ── Commands ── */

  registerCommand<PcmemInsertNodeParams>(PCMEM_CMD_INSERT_NODE, (db, p) => {
    const result = db.prepare<void>(
      `INSERT INTO persona_memory_nodes (
        id, tenant_id, persona_id, fork_id, source_memory_id, knowledge_item_id,
        kind, content, valence, salience, access_count, decay_lambda,
        last_accessed_at, last_decayed_at, consolidated_from, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, NULL, ?)`,
    ).run(
      p.id, p.tenantId, p.personaId, p.forkId, p.sourceMemoryId, p.knowledgeItemId,
      p.kind, p.content, p.valence, p.salience, p.decayLambda,
      p.now, p.now, p.now,
    );
    return { rowsAffected: result.changes };
  });

  registerCommand<PcmemUpsertEdgeParams>(PCMEM_CMD_UPSERT_EDGE, (db, p) => {
    /* 边 upsert 的租户边界守卫（全维评审 Codex 确认 Medium）：persona_memory_edges 的唯一约束是
     * (source, target) 不含 tenant_id/persona_id，故 ON CONFLICT 会跨租户命中同名边。source/target 是
     * randomUUID 派生的 mem_* id（跨租户碰撞概率天文级，正常路径不会误撞），真实风险是：租户 B 若得知
     * 租户 A 的 node id，构造同 (source,target) 边即可凭 ON CONFLICT **覆盖** A 的 strength/relation。
     * 加 WHERE 守卫：仅当既有行 tenant/persona **与本次相同**才 UPDATE，否则冲突为 no-op（不越租户改写）。
     * 不重建主键（改 PK 需 SQLite 全表重建 + PG 方言分叉，风险远大于收益；id 唯一使跨租户合法插入本就不撞）。 */
    const result = db.prepare<void>(
      `INSERT INTO persona_memory_edges (tenant_id, persona_id, source, target, strength, relation)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(source, target) DO UPDATE SET strength = excluded.strength, relation = excluded.relation
         WHERE persona_memory_edges.tenant_id = excluded.tenant_id
           AND persona_memory_edges.persona_id = excluded.persona_id`,
    ).run(p.tenantId, p.personaId, p.source, p.target, p.strength, p.relation);
    return { rowsAffected: result.changes };
  });

  registerCommand<PcmemWmSlotParams>(PCMEM_CMD_WM_DELETE_SLOT, (db, p) => {
    const result = db.prepare<void>(
      `DELETE FROM persona_working_memory
       WHERE tenant_id = ? AND persona_id = ? AND memory_id = ?`,
    ).run(p.tenantId, p.personaId, p.memoryId);
    return { rowsAffected: result.changes };
  });

  registerCommand<PcmemWmUpdateScoreParams>(PCMEM_CMD_WM_UPDATE_SCORE, (db, p) => {
    const result = db.prepare<void>(
      `UPDATE persona_working_memory
       SET score = ?
       WHERE tenant_id = ? AND persona_id = ? AND memory_id = ?`,
    ).run(p.score, p.tenantId, p.personaId, p.memoryId);
    return { rowsAffected: result.changes };
  });

  registerCommand<PcmemWmInsertSlotParams>(PCMEM_CMD_WM_INSERT_SLOT, (db, p) => {
    const result = db.prepare<void>(
      `INSERT INTO persona_working_memory (tenant_id, persona_id, memory_id, score, entered_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(p.tenantId, p.personaId, p.memoryId, p.score, p.enteredAt);
    return { rowsAffected: result.changes };
  });
}
