/**
 * 人格漂移分析器 — 对比两个快照的价值权重变化，检测超阈值漂移
 * 纯结构性分析，不依赖 LLM；阈值可通过配置调整
 */

import { createHash } from 'node:crypto';
import type { IDatabase } from '../storage/database.js';
import { generatePrefixedId } from '../utils/id-generator.js';

export type AlertLevel = 'ok' | 'warning' | 'critical';

export interface ValueDrift {
  valueId: string;
  label: string;
  baseline: number;
  current: number;
  delta: number;
  alertLevel: AlertLevel;
}

export interface DriftReport {
  reportId: string;
  tenantId: string;
  baselineSnapshotId: string | null;
  analyzedAt: number;
  valueDrifts: ValueDrift[];
  overallDriftScore: number;
  alertLevel: AlertLevel;
}

export interface DriftThresholds {
  warning: number;
  critical: number;
}

const DEFAULT_THRESHOLDS: DriftThresholds = {
  warning: 0.15,
  critical: 0.30,
};

interface SnapshotRow {
  id: string;
  data_json: string;
  created_at: number;
  tenant_id: string | null;
}

interface CoreValueSnapshot {
  id: string;
  label: string;
  weight: number;
}

function parseSnapshotValues(dataJson: string): Map<string, CoreValueSnapshot> {
  const result = new Map<string, CoreValueSnapshot>();
  try {
    const data = JSON.parse(dataJson) as Record<string, unknown>;
    const values = (data.values ?? data.L1) as unknown;
    if (!Array.isArray(values)) return result;
    for (const v of values as unknown[]) {
      if (v !== null && typeof v === 'object') {
        const val = v as Record<string, unknown>;
        const id = String(val.id ?? '');
        const label = String(val.label ?? '');
        const weight = typeof val.weight === 'number' ? val.weight : 0;
        if (id) result.set(id, { id, label, weight });
      }
    }
  } catch {
    // malformed snapshot — return empty
  }
  return result;
}

function computeAlertLevel(absDelta: number, thresholds: DriftThresholds): AlertLevel {
  if (absDelta >= thresholds.critical) return 'critical';
  if (absDelta >= thresholds.warning) return 'warning';
  return 'ok';
}

export class PersonaDriftAnalyzer {
  constructor(
    private readonly db: IDatabase,
    private readonly thresholds: DriftThresholds = DEFAULT_THRESHOLDS,
  ) {}

  /**
   * 与最近一次快照对比，生成漂移报告并写入 drift_analysis_log。
   * 若只有一个快照（无历史基线），返回零漂移报告。
   */
  analyze(tenantId: string): DriftReport {
    const snapshots = this.db.prepare<SnapshotRow>(
      `SELECT id, data_json, created_at, tenant_id
         FROM snapshots
        WHERE tenant_id = ? OR (tenant_id IS NULL AND ? = 'default')
        ORDER BY created_at DESC
        LIMIT 2`,
    ).all(tenantId, tenantId);

    const now = Date.now();
    const reportId = generatePrefixedId('drift');

    if (snapshots.length < 2) {
      const report: DriftReport = {
        reportId,
        tenantId,
        baselineSnapshotId: snapshots[0]?.id ?? null,
        analyzedAt: now,
        valueDrifts: [],
        overallDriftScore: 0,
        alertLevel: 'ok',
      };
      this.persistReport(report);
      return report;
    }

    const [current, baseline] = snapshots as [SnapshotRow, SnapshotRow];
    const baselineValues = parseSnapshotValues(baseline.data_json);
    const currentValues = parseSnapshotValues(current.data_json);

    const drifts: ValueDrift[] = [];
    for (const [id, baseVal] of baselineValues) {
      const curVal = currentValues.get(id);
      if (!curVal) continue;
      const delta = curVal.weight - baseVal.weight;
      const absDelta = Math.abs(delta);
      drifts.push({
        valueId: id,
        label: baseVal.label,
        baseline: baseVal.weight,
        current: curVal.weight,
        delta,
        alertLevel: computeAlertLevel(absDelta, this.thresholds),
      });
    }

    const overallDriftScore = drifts.length > 0
      ? drifts.reduce((sum, d) => sum + Math.abs(d.delta), 0) / drifts.length
      : 0;

    let alertLevel: AlertLevel = 'ok';
    if (drifts.some((d) => d.alertLevel === 'critical')) alertLevel = 'critical';
    else if (drifts.some((d) => d.alertLevel === 'warning')) alertLevel = 'warning';

    const report: DriftReport = {
      reportId,
      tenantId,
      baselineSnapshotId: baseline.id,
      analyzedAt: now,
      valueDrifts: drifts,
      overallDriftScore,
      alertLevel,
    };

    this.persistReport(report);
    return report;
  }

  /** 获取最近一次漂移报告 */
  getLatest(tenantId: string): DriftReport | null {
    const row = this.db.prepare<{
      id: string;
      baseline_snapshot_id: string | null;
      analyzed_at: number;
      overall_drift_score: number;
      alert_level: string;
      value_drifts_json: string;
    }>(
      `SELECT id, baseline_snapshot_id, analyzed_at, overall_drift_score, alert_level, value_drifts_json
         FROM drift_analysis_log
        WHERE tenant_id = ?
        ORDER BY analyzed_at DESC
        LIMIT 1`,
    ).get(tenantId);

    if (!row) return null;

    return {
      reportId: row.id,
      tenantId,
      baselineSnapshotId: row.baseline_snapshot_id,
      analyzedAt: row.analyzed_at,
      valueDrifts: JSON.parse(row.value_drifts_json) as ValueDrift[],
      overallDriftScore: row.overall_drift_score,
      alertLevel: row.alert_level as AlertLevel,
    };
  }

  private persistReport(report: DriftReport): void {
    try {
      this.db.prepare<void>(
        `INSERT INTO drift_analysis_log
           (id, tenant_id, baseline_snapshot_id, analyzed_at, overall_drift_score, alert_level, value_drifts_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        report.reportId,
        report.tenantId,
        report.baselineSnapshotId,
        report.analyzedAt,
        report.overallDriftScore,
        report.alertLevel,
        JSON.stringify(report.valueDrifts),
      );
    } catch {
      // 持久化失败不中断分析
    }
  }
}

export { DEFAULT_THRESHOLDS };

/** 从快照 JSON 中计算简单的内容哈希（用于去重） */
export function snapshotHash(dataJson: string): string {
  return createHash('sha256').update(dataJson, 'utf8').digest('hex').slice(0, 16);
}
