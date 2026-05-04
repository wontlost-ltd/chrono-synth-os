/**
 * 批量知识导入 job 持久化（P1-B）
 *
 * 直接通过 kernel command/query 操作 bulk_knowledge_import_jobs 表；不进入 TenantDatabase
 * 自动重写（表非 TENANT_TABLES 成员，调用方需显式带 tenant_id 条件）。
 */

import type {
  SyncWriteUnitOfWork, BimpJobRow, BulkImportCounterField,
} from '@chrono/kernel';
import {
  bimpQueryByTenantAndId, bimpQueryListByPersona,
  bimpQueryFailures, bimpQueryStuck,
  bimpCmdCreate, bimpCmdMarkRunning, bimpCmdIncrementCounter,
  bimpCmdUpdateFailures, bimpCmdSetMetadata,
  bimpCmdMarkCompleted, bimpCmdMarkFailed,
} from '@chrono/kernel';
import { asUow, type UowOrDb } from '../storage/uow-helpers.js';
import { registerCoreSelfExecutors } from '../storage/executors/index.js';

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

const MAX_FAILURE_DETAILS = 50;

export class BulkImportStore {
  private readonly tx: SyncWriteUnitOfWork;

  constructor(uowOrDb: UowOrDb) {
    registerCoreSelfExecutors();
    this.tx = asUow(uowOrDb);
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
    this.tx.execute(bimpCmdCreate({
      id: input.id,
      tenantId: input.tenantId,
      personaId: input.personaId,
      ownerUserId: input.ownerUserId,
      totalItems: input.totalItems,
      deduplicateStrategy: input.deduplicateStrategy,
      now,
    }));
  }

  markRunning(jobId: string): void {
    this.tx.execute(bimpCmdMarkRunning({ jobId, now: Date.now() }));
  }

  incrementCounter(
    jobId: string,
    field: BulkImportCounterField,
    delta = 1,
  ): void {
    this.tx.execute(bimpCmdIncrementCounter({ jobId, field, delta }));
  }

  /**
   * 追加失败详情；超过 MAX_FAILURE_DETAILS 后仅丢弃详情，failed_count 仍由 incrementCounter 累加
   */
  appendFailure(jobId: string, failure: BulkImportJobFailure): void {
    const row = this.tx.queryOne(bimpQueryFailures({ jobId }));
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
    this.tx.execute(bimpCmdUpdateFailures({ jobId, failuresJson: JSON.stringify(failures) }));
  }

  /** 写入 metadata_json（覆盖式） */
  setMetadata(jobId: string, metadata: BulkImportJobMetadata): void {
    this.tx.execute(bimpCmdSetMetadata({ jobId, metadataJson: JSON.stringify(metadata) }));
  }

  markCompleted(jobId: string): void {
    this.tx.execute(bimpCmdMarkCompleted({ jobId, now: Date.now() }));
  }

  markFailed(jobId: string, reason: string): void {
    const row = this.tx.queryOne(bimpQueryFailures({ jobId }));
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
    this.tx.execute(bimpCmdMarkFailed({
      jobId,
      failuresJson: JSON.stringify(failures),
      now: Date.now(),
    }));
  }

  get(tenantId: string, jobId: string): BulkImportJobRecord | null {
    const row = this.tx.queryOne(bimpQueryByTenantAndId({ jobId, tenantId }));
    return row ? rowToRecord(row) : null;
  }

  listByPersona(tenantId: string, personaId: string, limit = 20): BulkImportJobRecord[] {
    const rows = this.tx.queryMany(bimpQueryListByPersona({ tenantId, personaId, limit })) as unknown as BimpJobRow[];
    return rows.map(rowToRecord);
  }

  /** worker 启动期回收：所有处于 running 但 started_at 老于 cutoff 的 job 标记 failed */
  reapStuck(cutoffMs: number): number {
    const cutoff = Date.now() - cutoffMs;
    const stuck = this.tx.queryMany(bimpQueryStuck({ cutoff })) as unknown as Array<{ id: string }>;
    for (const row of stuck) {
      this.markFailed(row.id, `worker timeout (>${cutoffMs}ms running)`);
    }
    return stuck.length;
  }
}

function rowToRecord(row: BimpJobRow): BulkImportJobRecord {
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
