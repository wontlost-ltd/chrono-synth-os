/**
 * Avatar 自动运行配置与运行日志存储
 * 通过 SyncWriteUnitOfWork 的 Query/Command 契约访问数据，
 * 不直接调用 db.prepare()
 */

import type { IDatabase } from './database.js';
import type { SyncWriteUnitOfWork } from '@chrono/kernel';
import type { AutorunConfigRow, AutorunRunLogRow } from '@chrono/kernel';
import {
  autorunQueryConfig, autorunQueryConfigById, autorunQueryDueConfigs,
  autorunQueryRunById, autorunQueryRunsByAvatar, autorunQueryRunsCount,
  autorunCmdUpdateConfig, autorunCmdInsertConfig, autorunCmdClaimConfig,
  autorunCmdUpdateDriftCheck, autorunCmdUpdateLastError,
  autorunCmdInsertRun, autorunCmdSetRunStarted, autorunCmdSetRunCompleted,
  autorunCmdSetRunStatus, autorunCmdUpdateRunTaskId,
} from '@chrono/kernel';
import { registerCoreSelfExecutors } from './executors/index.js';
import { generatePrefixedId } from '../utils/id-generator.js';
import type { AvatarAutorunConfig, AvatarAutorunRunLog, AutorunRunMetrics, AutorunRunStatus } from '../types/avatar-autorun.js';

function configRowToRecord(r: AutorunConfigRow): AvatarAutorunConfig {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    avatarId: r.avatar_id,
    enabled: Number(r.enabled) === 1,
    intervalMs: Number(r.interval_ms),
    nextRunAt: Number(r.next_run_at),
    knowledgeSourceIds: JSON.parse(r.knowledge_source_ids_json) as string[],
    driftCheckIntervalMs: Number(r.drift_check_interval_ms),
    driftThreshold: Number(r.drift_threshold),
    reviewRequired: Number(r.review_required) === 1,
    lastRunAt: r.last_run_at != null ? Number(r.last_run_at) : null,
    lastDriftCheckAt: r.last_drift_check_at != null ? Number(r.last_drift_check_at) : null,
    lastError: r.last_error,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}

function runLogRowToRecord(r: AutorunRunLogRow): AvatarAutorunRunLog {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    avatarId: r.avatar_id,
    configId: r.config_id,
    taskId: r.task_id,
    status: r.status as AutorunRunStatus,
    metrics: r.metrics_json ? JSON.parse(r.metrics_json) as AutorunRunMetrics : null,
    error: r.error,
    startedAt: r.started_at != null ? Number(r.started_at) : null,
    completedAt: r.completed_at != null ? Number(r.completed_at) : null,
    createdAt: Number(r.created_at),
  };
}

export class AvatarAutorunStore {
  private readonly tx: SyncWriteUnitOfWork;

  constructor(db: IDatabase) {
    registerCoreSelfExecutors();
    this.tx = db;
  }

  getConfig(tenantId: string, avatarId: string): AvatarAutorunConfig | null {
    const row = this.tx.queryOne(autorunQueryConfig(tenantId, avatarId));
    return row ? configRowToRecord(row) : null;
  }

  getConfigById(id: string): AvatarAutorunConfig | null {
    const row = this.tx.queryOne(autorunQueryConfigById(id));
    return row ? configRowToRecord(row) : null;
  }

  upsertConfig(tenantId: string, avatarId: string, data: {
    enabled: boolean;
    intervalMs: number;
    driftThreshold?: number;
    driftCheckIntervalMs?: number;
    reviewRequired?: boolean;
    knowledgeSourceIds?: string[];
  }): AvatarAutorunConfig {
    const now = Date.now();
    const existing = this.getConfig(tenantId, avatarId);

    if (existing) {
      this.tx.execute(autorunCmdUpdateConfig({
        id: existing.id,
        enabled: data.enabled ? 1 : 0,
        intervalMs: data.intervalMs,
        driftThreshold: data.driftThreshold ?? existing.driftThreshold,
        driftCheckIntervalMs: data.driftCheckIntervalMs ?? existing.driftCheckIntervalMs,
        reviewRequired: (data.reviewRequired ?? existing.reviewRequired) ? 1 : 0,
        knowledgeSourceIdsJson: JSON.stringify(data.knowledgeSourceIds ?? existing.knowledgeSourceIds),
        nextRunAt: data.enabled ? now + data.intervalMs : existing.nextRunAt,
        now,
      }));
      return this.getConfig(tenantId, avatarId)!;
    }

    const id = generatePrefixedId('arc');
    this.tx.execute(autorunCmdInsertConfig({
      id, tenantId, avatarId,
      enabled: data.enabled ? 1 : 0,
      intervalMs: data.intervalMs,
      nextRunAt: now + data.intervalMs,
      knowledgeSourceIdsJson: JSON.stringify(data.knowledgeSourceIds ?? []),
      driftCheckIntervalMs: data.driftCheckIntervalMs ?? 86_400_000,
      driftThreshold: data.driftThreshold ?? 0.3,
      reviewRequired: (data.reviewRequired ?? false) ? 1 : 0,
      now,
    }));
    return this.getConfig(tenantId, avatarId)!;
  }

  /** 查询到期待运行的配置（enabled=1 且 next_run_at <= now） */
  listDueConfigs(now: number, limit: number): AvatarAutorunConfig[] {
    const rows = this.tx.queryMany(autorunQueryDueConfigs(now, limit));
    return rows.map(configRowToRecord);
  }

  /** CAS 抢占：仅在 next_run_at 未被其他进程更新时成功 */
  claimConfig(id: string, now: number, nextRunAt: number): boolean {
    const result = this.tx.execute(autorunCmdClaimConfig({ id, now, nextRunAt }));
    return result.rowsAffected === 1;
  }

  /** 更新配置的 last_drift_check_at */
  updateDriftCheckTime(id: string, now: number): void {
    this.tx.execute(autorunCmdUpdateDriftCheck({ id, now }));
  }

  /** 更新配置的错误信息 */
  updateLastError(id: string, error: string | null): void {
    this.tx.execute(autorunCmdUpdateLastError({ id, error, now: Date.now() }));
  }

  createRunLog(data: {
    tenantId: string;
    avatarId: string;
    configId: string;
    taskId: string;
    status: AutorunRunStatus;
  }): AvatarAutorunRunLog {
    const id = generatePrefixedId('arl');
    const now = Date.now();
    this.tx.execute(autorunCmdInsertRun({
      id, tenantId: data.tenantId, avatarId: data.avatarId,
      configId: data.configId, taskId: data.taskId, status: data.status, now,
    }));
    return {
      id, tenantId: data.tenantId, avatarId: data.avatarId,
      configId: data.configId, taskId: data.taskId, status: data.status,
      metrics: null, error: null, startedAt: null, completedAt: null, createdAt: now,
    };
  }

  setRunStatus(id: string, status: AutorunRunStatus, metrics?: AutorunRunMetrics, error?: string): void {
    const now = Date.now();
    const startedAt = status === 'running' ? now : undefined;
    const completedAt = status === 'completed' || status === 'failed' || status === 'skipped' ? now : undefined;

    if (startedAt !== undefined) {
      this.tx.execute(autorunCmdSetRunStarted({ id, status, startedAt }));
    } else if (completedAt !== undefined) {
      this.tx.execute(autorunCmdSetRunCompleted({
        id, status,
        metricsJson: metrics ? JSON.stringify(metrics) : null,
        error: error ?? null,
        completedAt,
      }));
    } else {
      this.tx.execute(autorunCmdSetRunStatus({ id, status }));
    }
  }

  /** 更新运行日志的 taskId */
  updateRunTaskId(id: string, taskId: string): void {
    this.tx.execute(autorunCmdUpdateRunTaskId({ id, taskId }));
  }

  getRun(id: string): AvatarAutorunRunLog | null {
    const row = this.tx.queryOne(autorunQueryRunById(id));
    return row ? runLogRowToRecord(row) : null;
  }

  listRunsByAvatar(tenantId: string, avatarId: string, limit: number, offset: number): { runs: AvatarAutorunRunLog[]; total: number } {
    const rows = this.tx.queryMany(autorunQueryRunsByAvatar({ tenantId, avatarId, limit, offset }));
    const countRow = this.tx.queryOne(autorunQueryRunsCount(tenantId, avatarId));
    return {
      runs: rows.map(runLogRowToRecord),
      total: countRow?.count ?? 0,
    };
  }
}
