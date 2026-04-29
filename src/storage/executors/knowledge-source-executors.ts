/**
 * 知识源 SQL 执行器
 */

import { registerQuery, registerCommand } from '../legacy-sync-bridge.js';
import {
  KSRC_QUERY_BY_ID, KSRC_QUERY_LIST, KSRC_QUERY_COUNT, KSRC_QUERY_ENABLED_BY_IDS,
  KSRC_CMD_CREATE, KSRC_CMD_UPDATE, KSRC_CMD_UPDATE_STATE, KSRC_CMD_DELETE,
} from '@chrono/kernel';
import type {
  KsrcRow, KsrcCountRow,
  KsrcByIdParams, KsrcListParams, KsrcEnabledByIdsParams,
  KsrcCreateParams, KsrcUpdateParams, KsrcUpdateStateParams,
} from '@chrono/kernel';

export function registerKnowledgeSourceExecutors(): void {
  registerQuery<KsrcRow | null, KsrcByIdParams>(KSRC_QUERY_BY_ID, (db, p) => {
    return db.prepare<KsrcRow>(
      'SELECT * FROM knowledge_sources WHERE id = ? AND tenant_id = ?',
    ).get(p.id, p.tenantId) ?? null;
  });

  registerQuery<readonly KsrcRow[], KsrcListParams>(KSRC_QUERY_LIST, (db, p) => {
    return db.prepare<KsrcRow>(
      'SELECT * FROM knowledge_sources WHERE tenant_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?',
    ).all(p.tenantId, p.limit, p.offset);
  });

  registerQuery<KsrcCountRow | null, string>(KSRC_QUERY_COUNT, (db, tenantId) => {
    const row = db.prepare<{ count: number | bigint }>(
      'SELECT COUNT(*) as count FROM knowledge_sources WHERE tenant_id = ?',
    ).get(tenantId);
    if (!row) return null;
    return { count: Number(row.count) };
  });

  registerQuery<readonly KsrcRow[], KsrcEnabledByIdsParams>(KSRC_QUERY_ENABLED_BY_IDS, (db, p) => {
    if (p.ids.length === 0) return [];
    const placeholders = p.ids.map(() => '?').join(',');
    return db.prepare<KsrcRow>(
      `SELECT * FROM knowledge_sources WHERE tenant_id = ? AND enabled = 1 AND id IN (${placeholders})`,
    ).all(p.tenantId, ...p.ids);
  });

  registerCommand<KsrcCreateParams>(KSRC_CMD_CREATE, (db, p) => {
    const result = db.prepare<void>(
      `INSERT INTO knowledge_sources (id, tenant_id, type, name, enabled, config_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, ?, ?, ?)`,
    ).run(p.id, p.tenantId, p.type, p.name, p.configJson, p.now, p.now);
    return { rowsAffected: result.changes };
  });

  registerCommand<KsrcUpdateParams>(KSRC_CMD_UPDATE, (db, p) => {
    const result = db.prepare<void>(
      `UPDATE knowledge_sources SET name = ?, type = ?, config_json = ?, enabled = ?, updated_at = ?
       WHERE id = ? AND tenant_id = ?`,
    ).run(p.name, p.type, p.configJson, p.enabled, p.now, p.id, p.tenantId);
    return { rowsAffected: result.changes };
  });

  registerCommand<KsrcUpdateStateParams>(KSRC_CMD_UPDATE_STATE, (db, p) => {
    const result = db.prepare<void>(
      'UPDATE knowledge_sources SET state_json = ?, last_ingested_at = ?, updated_at = ? WHERE id = ?',
    ).run(p.stateJson, p.lastIngestedAt, p.now, p.id);
    return { rowsAffected: result.changes };
  });

  registerCommand<KsrcByIdParams>(KSRC_CMD_DELETE, (db, p) => {
    const result = db.prepare<void>(
      'DELETE FROM knowledge_sources WHERE id = ? AND tenant_id = ?',
    ).run(p.id, p.tenantId);
    return { rowsAffected: result.changes };
  });
}
