/**
 * 批量知识导入 job 持久化（P1-B）
 *
 * 直接通过 db.prepare 操作 bulk_knowledge_import_jobs 表；不进入 TenantDatabase 自动重写
 * （表非 TENANT_TABLES 成员，调用方需显式带 tenant_id 条件）。
 */

import type { IDatabase } from '../storage/database.js';
import { unwrapDb, type UowOrDb } from '../storage/uow-helpers.js';

export type BulkImportJobState = 'queued' | 'running' | 'completed' | 'failed';
export type BulkImportDeduplicateStrategy = 'skip' | 'overwrite';

export interface BulkImportJobFailure {
  index: number;
  reason: string;
}

export interface BulkImportJobMetadata {
  /** 关联的模板 ID（若调用方在 submit 时提供 expectedTemplateId） */
  expectedTemplateId?: string;
  /** source.category 不在 template.requiredKnowledgeCategories 列表中的条目数 */
  unmatchedCategoryCount?: number;
  /** source.category 已匹配的条目数 */
  matchedCategoryCount?: number;
  /** 模板未要求的额外 category（去重） */
  unexpectedCategories?: string[];
}

export interface BulkImportJobRecord {
  id: string;
  tenantId: string;
  personaId: string;
  ownerUserId: string;
  state: BulkImportJobState;
  totalItems: number;
  importedCount: number;
  skippedCount: number;
  failedCount: number;
  failures: BulkImportJobFailure[];
  deduplicateStrategy: BulkImportDeduplicateStrategy;
  metadata: BulkImportJobMetadata;
  createdAt: number;
  startedAt: number | null;
  completedAt: number | null;
}

interface JobRow {
  id: string;
  tenant_id: string;
  persona_id: string;
  owner_user_id: string;
  state: BulkImportJobState;
  total_items: number;
  imported_count: number;
  skipped_count: number;
  failed_count: number;
  failures_json: string;
  deduplicate_strategy: BulkImportDeduplicateStrategy;
  metadata_json: string | null;
  created_at: number;
  started_at: number | null;
  completed_at: number | null;
}

const MAX_FAILURE_DETAILS = 50;

export class BulkImportStore {
  private readonly db: IDatabase | null;

  constructor(uowOrDb: UowOrDb) {
    this.db = unwrapDb(uowOrDb);
  }

  private requireDb(method: string): IDatabase {
    if (!this.db) {
      throw new Error(`BulkImportStore.${method} requires IDatabase entrance`);
    }
    return this.db;
  }

  create(input: {
    id: string;
    tenantId: string;
    personaId: string;
    ownerUserId: string;
    totalItems: number;
    deduplicateStrategy: BulkImportDeduplicateStrategy;
  }): void {
    const now = Date.now();
    this.requireDb('create').prepare<void>(
      `INSERT INTO bulk_knowledge_import_jobs (
        id, tenant_id, persona_id, owner_user_id, state, total_items,
        imported_count, skipped_count, failed_count, failures_json,
        deduplicate_strategy, created_at, started_at, completed_at
      ) VALUES (?, ?, ?, ?, 'queued', ?, 0, 0, 0, '[]', ?, ?, NULL, NULL)`,
    ).run(
      input.id,
      input.tenantId,
      input.personaId,
      input.ownerUserId,
      input.totalItems,
      input.deduplicateStrategy,
      now,
    );
  }

  markRunning(jobId: string): void {
    this.requireDb('markRunning').prepare<void>(
      `UPDATE bulk_knowledge_import_jobs
          SET state = 'running', started_at = COALESCE(started_at, ?)
        WHERE id = ?`,
    ).run(Date.now(), jobId);
  }

  incrementCounter(
    jobId: string,
    field: 'imported_count' | 'skipped_count' | 'failed_count',
    delta = 1,
  ): void {
    this.requireDb('incrementCounter').prepare<void>(
      `UPDATE bulk_knowledge_import_jobs SET ${field} = ${field} + ? WHERE id = ?`,
    ).run(delta, jobId);
  }

  /**
   * 追加失败详情；超过 MAX_FAILURE_DETAILS 后仅丢弃详情，failed_count 仍由 incrementCounter 累加
   */
  appendFailure(jobId: string, failure: BulkImportJobFailure): void {
    const db = this.requireDb('appendFailure');
    const row = db.prepare<{ failures_json: string }>(
      'SELECT failures_json FROM bulk_knowledge_import_jobs WHERE id = ?',
    ).get(jobId);
    if (!row) return;

    let failures: BulkImportJobFailure[];
    try {
      const parsed = JSON.parse(row.failures_json);
      failures = Array.isArray(parsed) ? parsed : [];
    } catch {
      failures = [];
    }
    if (failures.length >= MAX_FAILURE_DETAILS) return;
    failures.push(failure);
    db.prepare<void>(
      'UPDATE bulk_knowledge_import_jobs SET failures_json = ? WHERE id = ?',
    ).run(JSON.stringify(failures), jobId);
  }

  /** 写入 metadata_json（覆盖式） */
  setMetadata(jobId: string, metadata: BulkImportJobMetadata): void {
    this.requireDb('setMetadata').prepare<void>(
      'UPDATE bulk_knowledge_import_jobs SET metadata_json = ? WHERE id = ?',
    ).run(JSON.stringify(metadata), jobId);
  }

  markCompleted(jobId: string): void {
    this.requireDb('markCompleted').prepare<void>(
      `UPDATE bulk_knowledge_import_jobs
          SET state = 'completed', completed_at = ?
        WHERE id = ?`,
    ).run(Date.now(), jobId);
  }

  markFailed(jobId: string, reason: string): void {
    const db = this.requireDb('markFailed');
    const row = db.prepare<{ failures_json: string; failed_count: number }>(
      'SELECT failures_json, failed_count FROM bulk_knowledge_import_jobs WHERE id = ?',
    ).get(jobId);
    if (!row) return;

    let failures: BulkImportJobFailure[];
    try {
      const parsed = JSON.parse(row.failures_json);
      failures = Array.isArray(parsed) ? parsed : [];
    } catch {
      failures = [];
    }
    if (failures.length < MAX_FAILURE_DETAILS) {
      failures.push({ index: -1, reason });
    }
    db.prepare<void>(
      `UPDATE bulk_knowledge_import_jobs
          SET state = 'failed',
              completed_at = ?,
              failures_json = ?
        WHERE id = ?`,
    ).run(Date.now(), JSON.stringify(failures), jobId);
  }

  get(tenantId: string, jobId: string): BulkImportJobRecord | null {
    const row = this.requireDb('get').prepare<JobRow>(
      'SELECT * FROM bulk_knowledge_import_jobs WHERE id = ? AND tenant_id = ?',
    ).get(jobId, tenantId);
    return row ? rowToRecord(row) : null;
  }

  listByPersona(tenantId: string, personaId: string, limit = 20): BulkImportJobRecord[] {
    const rows = this.requireDb('listByPersona').prepare<JobRow>(
      `SELECT * FROM bulk_knowledge_import_jobs
        WHERE tenant_id = ? AND persona_id = ?
        ORDER BY created_at DESC
        LIMIT ?`,
    ).all(tenantId, personaId, limit);
    return rows.map(rowToRecord);
  }

  /** worker 启动期回收：所有处于 running 但 started_at 老于 cutoff 的 job 标记 failed */
  reapStuck(cutoffMs: number): number {
    const cutoff = Date.now() - cutoffMs;
    const stuck = this.requireDb('reapStuck').prepare<{ id: string }>(
      `SELECT id FROM bulk_knowledge_import_jobs
        WHERE state = 'running' AND started_at < ?`,
    ).all(cutoff);
    for (const row of stuck) {
      this.markFailed(row.id, `worker timeout (>${cutoffMs}ms running)`);
    }
    return stuck.length;
  }
}

function rowToRecord(row: JobRow): BulkImportJobRecord {
  let failures: BulkImportJobFailure[] = [];
  try {
    const parsed = JSON.parse(row.failures_json);
    failures = Array.isArray(parsed) ? parsed : [];
  } catch { /* 默认空数组 */ }

  let metadata: BulkImportJobMetadata = {};
  if (row.metadata_json) {
    try {
      const parsed = JSON.parse(row.metadata_json);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        metadata = parsed as BulkImportJobMetadata;
      }
    } catch { /* 默认空对象 */ }
  }

  return {
    id: row.id,
    tenantId: row.tenant_id,
    personaId: row.persona_id,
    ownerUserId: row.owner_user_id,
    state: row.state,
    totalItems: row.total_items,
    importedCount: row.imported_count,
    skippedCount: row.skipped_count,
    failedCount: row.failed_count,
    failures,
    deduplicateStrategy: row.deduplicate_strategy,
    metadata,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}
