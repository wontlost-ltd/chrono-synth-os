/**
 * Avatar Snapshot Application Service
 * 封装跨设备快照中 autorun 配置、drift 状态、已安装设备的数据访问
 */

import type { SyncWriteUnitOfWork } from '@chrono/kernel';
import {
  asnapQueryAutorunConfig, asnapQueryDriftConfig,
  asnapQueryLastRunMetrics, asnapQueryInstalledDevices,
} from '@chrono/kernel';
import { registerCoreSelfExecutors } from '../storage/executors/index.js';

export interface AutorunState {
  enabled: boolean;
  intervalMinutes: number;
  lastRunAt: number | null;
}

export interface DriftState {
  pendingReview: boolean;
  lastScore: number;
  lastCheckAt: number | null;
}

interface SnapshotLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
}

const noopLogger: SnapshotLogger = { warn() {} };

export class AvatarSnapshotService {
  private readonly log: SnapshotLogger;

  constructor(private readonly tx: SyncWriteUnitOfWork, logger?: SnapshotLogger) {
    registerCoreSelfExecutors();
    this.log = logger ?? noopLogger;
  }

  /** 获取 avatar 的 autorun 配置状态 */
  getAutorunState(tenantId: string, avatarId: string): AutorunState {
    try {
      const row = this.tx.queryOne(asnapQueryAutorunConfig({ tenantId, avatarId }));
      if (!row) return { enabled: false, intervalMinutes: 0, lastRunAt: null };
      return {
        enabled: row.enabled === 1,
        intervalMinutes: Math.round(row.interval_ms / 60_000),
        lastRunAt: row.last_run_at,
      };
    } catch (err) {
      this.log.warn({ err, tenantId, avatarId }, 'autorun 配置查询失败，返回默认值');
      return { enabled: false, intervalMinutes: 0, lastRunAt: null };
    }
  }

  /** 获取 avatar 的 drift 检测状态 */
  getDriftState(tenantId: string, avatarId: string): DriftState {
    try {
      const configRow = this.tx.queryOne(asnapQueryDriftConfig({ tenantId, avatarId }));
      if (!configRow) return { pendingReview: false, lastScore: 0, lastCheckAt: null };

      let lastScore = 0;
      const lastRun = this.tx.queryOne(asnapQueryLastRunMetrics({ tenantId, avatarId, status: 'completed' }));
      if (lastRun?.metrics_json) {
        try {
          const metrics = JSON.parse(lastRun.metrics_json) as { driftScore?: number };
          lastScore = metrics.driftScore ?? 0;
        } catch { /* 忽略解析失败 */ }
      }

      return {
        pendingReview: configRow.review_required === 1 && lastScore >= configRow.drift_threshold,
        lastScore,
        lastCheckAt: configRow.last_drift_check_at,
      };
    } catch (err) {
      this.log.warn({ err, tenantId, avatarId }, 'drift 状态查询失败，返回默认值');
      return { pendingReview: false, lastScore: 0, lastCheckAt: null };
    }
  }

  /** 获取 avatar 的已安装设备列表 */
  getInstalledDevices(avatarId: string): string[] {
    try {
      const rows = this.tx.queryMany(asnapQueryInstalledDevices(avatarId));
      return rows.map(r => r.device_id);
    } catch (err) {
      this.log.warn({ err, avatarId }, '设备列表查询失败，返回空列表');
      return [];
    }
  }
}
