/**
 * Avatar 自动运行配置与运行日志存储
 */

import type { IDatabase } from './database.js';
import { generatePrefixedId } from '../utils/id-generator.js';
import type { AvatarAutorunConfig, AvatarAutorunRunLog, AutorunRunMetrics, AutorunRunStatus } from '../types/avatar-autorun.js';

interface ConfigRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly avatar_id: string;
  readonly enabled: number;
  readonly interval_ms: number;
  readonly next_run_at: number;
  readonly knowledge_source_ids_json: string;
  readonly drift_check_interval_ms: number;
  readonly drift_threshold: number;
  readonly review_required: number;
  readonly last_run_at: number | null;
  readonly last_drift_check_at: number | null;
  readonly last_error: string | null;
  readonly created_at: number;
  readonly updated_at: number;
}

interface RunLogRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly avatar_id: string;
  readonly config_id: string;
  readonly task_id: string;
  readonly status: string;
  readonly metrics_json: string | null;
  readonly error: string | null;
  readonly started_at: number | null;
  readonly completed_at: number | null;
  readonly created_at: number;
}

function configRowToRecord(r: ConfigRow): AvatarAutorunConfig {
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

function runLogRowToRecord(r: RunLogRow): AvatarAutorunRunLog {
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
  constructor(private readonly db: IDatabase) {}

  getConfig(tenantId: string, avatarId: string): AvatarAutorunConfig | null {
    const row = this.db.prepare<ConfigRow>(
      'SELECT * FROM avatar_autorun_config WHERE tenant_id = ? AND avatar_id = ?',
    ).get(tenantId, avatarId);
    return row ? configRowToRecord(row) : null;
  }

  getConfigById(id: string): AvatarAutorunConfig | null {
    const row = this.db.prepare<ConfigRow>(
      'SELECT * FROM avatar_autorun_config WHERE id = ?',
    ).get(id);
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
      this.db.prepare<void>(
        `UPDATE avatar_autorun_config
         SET enabled = ?, interval_ms = ?, drift_threshold = ?, drift_check_interval_ms = ?,
             review_required = ?, knowledge_source_ids_json = ?, next_run_at = ?, updated_at = ?
         WHERE id = ?`,
      ).run(
        data.enabled ? 1 : 0,
        data.intervalMs,
        data.driftThreshold ?? existing.driftThreshold,
        data.driftCheckIntervalMs ?? existing.driftCheckIntervalMs,
        (data.reviewRequired ?? existing.reviewRequired) ? 1 : 0,
        JSON.stringify(data.knowledgeSourceIds ?? existing.knowledgeSourceIds),
        data.enabled ? now + data.intervalMs : existing.nextRunAt,
        now,
        existing.id,
      );
      return this.getConfig(tenantId, avatarId)!;
    }

    const id = generatePrefixedId('arc');
    this.db.prepare<void>(
      `INSERT INTO avatar_autorun_config
       (id, tenant_id, avatar_id, enabled, interval_ms, next_run_at, knowledge_source_ids_json,
        drift_check_interval_ms, drift_threshold, review_required, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id, tenantId, avatarId,
      data.enabled ? 1 : 0,
      data.intervalMs,
      now + data.intervalMs,
      JSON.stringify(data.knowledgeSourceIds ?? []),
      data.driftCheckIntervalMs ?? 86_400_000,
      data.driftThreshold ?? 0.3,
      (data.reviewRequired ?? false) ? 1 : 0,
      now, now,
    );
    return this.getConfig(tenantId, avatarId)!;
  }

  /** 查询到期待运行的配置（enabled=1 且 next_run_at <= now） */
  listDueConfigs(now: number, limit: number): AvatarAutorunConfig[] {
    const rows = this.db.prepare<ConfigRow>(
      'SELECT * FROM avatar_autorun_config WHERE enabled = 1 AND next_run_at <= ? LIMIT ?',
    ).all(now, limit);
    return rows.map(configRowToRecord);
  }

  /** CAS 抢占：仅在 next_run_at 未被其他进程更新时成功 */
  claimConfig(id: string, now: number, nextRunAt: number): boolean {
    const result = this.db.prepare<void>(
      `UPDATE avatar_autorun_config
       SET next_run_at = ?, last_run_at = ?, updated_at = ?
       WHERE id = ? AND next_run_at <= ?`,
    ).run(nextRunAt, now, now, id, now);
    return result.changes === 1;
  }

  /** 更新配置的 last_drift_check_at */
  updateDriftCheckTime(id: string, now: number): void {
    this.db.prepare<void>(
      'UPDATE avatar_autorun_config SET last_drift_check_at = ?, updated_at = ? WHERE id = ?',
    ).run(now, now, id);
  }

  /** 更新配置的错误信息 */
  updateLastError(id: string, error: string | null): void {
    this.db.prepare<void>(
      'UPDATE avatar_autorun_config SET last_error = ?, updated_at = ? WHERE id = ?',
    ).run(error, Date.now(), id);
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
    this.db.prepare<void>(
      `INSERT INTO avatar_autorun_runlog
       (id, tenant_id, avatar_id, config_id, task_id, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, data.tenantId, data.avatarId, data.configId, data.taskId, data.status, now);
    return {
      id, tenantId: data.tenantId, avatarId: data.avatarId,
      configId: data.configId, taskId: data.taskId, status: data.status,
      metrics: null, error: null, startedAt: null, completedAt: null, createdAt: now,
    };
  }

  setRunStatus(id: string, status: AutorunRunStatus, metrics?: AutorunRunMetrics, error?: string): void {
    const now = Date.now();
    const metricsJson = metrics ? JSON.stringify(metrics) : null;
    const startedAt = status === 'running' ? now : undefined;
    const completedAt = status === 'completed' || status === 'failed' || status === 'skipped' ? now : undefined;

    if (startedAt !== undefined) {
      this.db.prepare<void>(
        'UPDATE avatar_autorun_runlog SET status = ?, started_at = ? WHERE id = ?',
      ).run(status, startedAt, id);
    } else if (completedAt !== undefined) {
      this.db.prepare<void>(
        'UPDATE avatar_autorun_runlog SET status = ?, metrics_json = ?, error = ?, completed_at = ? WHERE id = ?',
      ).run(status, metricsJson, error ?? null, completedAt, id);
    } else {
      this.db.prepare<void>(
        'UPDATE avatar_autorun_runlog SET status = ? WHERE id = ?',
      ).run(status, id);
    }
  }

  /** 更新运行日志的 taskId */
  updateRunTaskId(id: string, taskId: string): void {
    this.db.prepare<void>(
      'UPDATE avatar_autorun_runlog SET task_id = ? WHERE id = ?',
    ).run(taskId, id);
  }

  getRun(id: string): AvatarAutorunRunLog | null {
    const row = this.db.prepare<RunLogRow>(
      'SELECT * FROM avatar_autorun_runlog WHERE id = ?',
    ).get(id);
    return row ? runLogRowToRecord(row) : null;
  }

  listRunsByAvatar(tenantId: string, avatarId: string, limit: number, offset: number): { runs: AvatarAutorunRunLog[]; total: number } {
    const rows = this.db.prepare<RunLogRow>(
      'SELECT * FROM avatar_autorun_runlog WHERE tenant_id = ? AND avatar_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?',
    ).all(tenantId, avatarId, limit, offset);
    const countRow = this.db.prepare<{ count: number }>(
      'SELECT COUNT(*) as count FROM avatar_autorun_runlog WHERE tenant_id = ? AND avatar_id = ?',
    ).get(tenantId, avatarId);
    return {
      runs: rows.map(runLogRowToRecord),
      total: countRow?.count ?? 0,
    };
  }
}
