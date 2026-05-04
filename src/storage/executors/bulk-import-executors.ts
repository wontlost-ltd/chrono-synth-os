/**
 * 批量知识导入 job SQL 执行器
 */

import { registerQuery, registerCommand } from '../legacy-sync-bridge.js';
import {
  BIMP_QUERY_BY_ID, BIMP_QUERY_BY_TENANT_AND_ID, BIMP_QUERY_LIST_BY_PERSONA,
  BIMP_QUERY_FAILURES, BIMP_QUERY_STUCK,
  BIMP_CMD_CREATE, BIMP_CMD_MARK_RUNNING, BIMP_CMD_INCREMENT_COUNTER,
  BIMP_CMD_UPDATE_FAILURES, BIMP_CMD_SET_METADATA,
  BIMP_CMD_MARK_COMPLETED, BIMP_CMD_MARK_FAILED,
} from '@chrono/kernel';
import type {
  BimpJobRow, BimpFailuresRow, BimpStuckRow,
  BimpByIdParams, BimpByTenantAndIdParams, BimpListByPersonaParams, BimpStuckParams,
  BimpCreateParams, BimpMarkRunningParams, BimpIncrementCounterParams,
  BimpUpdateFailuresParams, BimpSetMetadataParams,
  BimpMarkCompletedParams, BimpMarkFailedParams,
} from '@chrono/kernel';

/** 限制可注入的列名，避免 SQL 注入 */
const COUNTER_FIELDS = new Set(['imported_count', 'skipped_count', 'failed_count']);

export function registerBulkImportExecutors(): void {
  registerQuery<{ failures_json: string } | null, BimpByIdParams>(BIMP_QUERY_BY_ID, (db, p) => {
    return db.prepare<{ failures_json: string }>(
      'SELECT failures_json FROM bulk_knowledge_import_jobs WHERE id = ?',
    ).get(p.jobId) ?? null;
  });

  registerQuery<BimpJobRow | null, BimpByTenantAndIdParams>(BIMP_QUERY_BY_TENANT_AND_ID, (db, p) => {
    return db.prepare<BimpJobRow>(
      'SELECT * FROM bulk_knowledge_import_jobs WHERE id = ? AND tenant_id = ?',
    ).get(p.jobId, p.tenantId) ?? null;
  });

  registerQuery<readonly BimpJobRow[], BimpListByPersonaParams>(BIMP_QUERY_LIST_BY_PERSONA, (db, p) => {
    return db.prepare<BimpJobRow>(
      `SELECT * FROM bulk_knowledge_import_jobs
        WHERE tenant_id = ? AND persona_id = ?
        ORDER BY created_at DESC
        LIMIT ?`,
    ).all(p.tenantId, p.personaId, p.limit);
  });

  registerQuery<BimpFailuresRow | null, BimpByIdParams>(BIMP_QUERY_FAILURES, (db, p) => {
    return db.prepare<BimpFailuresRow>(
      'SELECT failures_json, failed_count FROM bulk_knowledge_import_jobs WHERE id = ?',
    ).get(p.jobId) ?? null;
  });

  registerQuery<readonly BimpStuckRow[], BimpStuckParams>(BIMP_QUERY_STUCK, (db, p) => {
    return db.prepare<BimpStuckRow>(
      `SELECT id FROM bulk_knowledge_import_jobs
        WHERE state = 'running' AND started_at < ?`,
    ).all(p.cutoff);
  });

  registerCommand<BimpCreateParams>(BIMP_CMD_CREATE, (db, p) => {
    const result = db.prepare<void>(
      `INSERT INTO bulk_knowledge_import_jobs (
        id, tenant_id, persona_id, owner_user_id, state, total_items,
        imported_count, skipped_count, failed_count, failures_json,
        deduplicate_strategy, created_at, started_at, completed_at
      ) VALUES (?, ?, ?, ?, 'queued', ?, 0, 0, 0, '[]', ?, ?, NULL, NULL)`,
    ).run(
      p.id, p.tenantId, p.personaId, p.ownerUserId, p.totalItems,
      p.deduplicateStrategy, p.now,
    );
    return { rowsAffected: result.changes };
  });

  registerCommand<BimpMarkRunningParams>(BIMP_CMD_MARK_RUNNING, (db, p) => {
    const result = db.prepare<void>(
      `UPDATE bulk_knowledge_import_jobs
          SET state = 'running', started_at = COALESCE(started_at, ?)
        WHERE id = ?`,
    ).run(p.now, p.jobId);
    return { rowsAffected: result.changes };
  });

  registerCommand<BimpIncrementCounterParams>(BIMP_CMD_INCREMENT_COUNTER, (db, p) => {
    if (!COUNTER_FIELDS.has(p.field)) {
      throw new Error(`Invalid counter field: ${p.field}`);
    }
    const result = db.prepare<void>(
      `UPDATE bulk_knowledge_import_jobs SET ${p.field} = ${p.field} + ? WHERE id = ?`,
    ).run(p.delta, p.jobId);
    return { rowsAffected: result.changes };
  });

  registerCommand<BimpUpdateFailuresParams>(BIMP_CMD_UPDATE_FAILURES, (db, p) => {
    const result = db.prepare<void>(
      'UPDATE bulk_knowledge_import_jobs SET failures_json = ? WHERE id = ?',
    ).run(p.failuresJson, p.jobId);
    return { rowsAffected: result.changes };
  });

  registerCommand<BimpSetMetadataParams>(BIMP_CMD_SET_METADATA, (db, p) => {
    const result = db.prepare<void>(
      'UPDATE bulk_knowledge_import_jobs SET metadata_json = ? WHERE id = ?',
    ).run(p.metadataJson, p.jobId);
    return { rowsAffected: result.changes };
  });

  registerCommand<BimpMarkCompletedParams>(BIMP_CMD_MARK_COMPLETED, (db, p) => {
    const result = db.prepare<void>(
      `UPDATE bulk_knowledge_import_jobs
          SET state = 'completed', completed_at = ?
        WHERE id = ?`,
    ).run(p.now, p.jobId);
    return { rowsAffected: result.changes };
  });

  registerCommand<BimpMarkFailedParams>(BIMP_CMD_MARK_FAILED, (db, p) => {
    const result = db.prepare<void>(
      `UPDATE bulk_knowledge_import_jobs
          SET state = 'failed',
              completed_at = ?,
              failures_json = ?
        WHERE id = ?`,
    ).run(p.now, p.failuresJson, p.jobId);
    return { rowsAffected: result.changes };
  });
}
