/**
 * 人格漂移分析器 — 对比两个快照的价值权重变化，检测超阈值漂移
 * 纯结构性分析，不依赖 LLM；阈值可通过配置调整
 */

import { createHash } from 'node:crypto';
import type { IDatabase } from '../storage/database.js';
import { generatePrefixedId } from '../utils/id-generator.js';
import { computeDriftFromSnapshots } from '@chrono/contracts';
import type { ComputedValueDrift } from '@chrono/contracts';

export type AlertLevel = 'ok' | 'warning' | 'critical';

export interface ValueDrift {
  valueId: string;
  label: string;
  baseline: number;
  current: number;
  delta: number;
  alertLevel: AlertLevel;
}

/* 编译期防回归锁（Codex PR-2 Minor）：共享 computeDriftFromSnapshots 产出的 ComputedValueDrift
 * 必须结构化满足本地 ValueDrift——analyze() 里用 `as ValueDrift[]` 强转依赖二者同形，若未来任一侧
 * 改字段/alertLevel 取值，这条断言让 tsc 直接报错而非静默漂移。仅类型层，无运行时开销。 */
const _computedValueDriftSatisfiesValueDrift: ValueDrift = {} as ComputedValueDrift;
void _computedValueDriftSatisfiesValueDrift;

/**
 * 人格漂移报告 —— **两个产品 frame 的单一数据源**（ADR-0046 同内核两壳）。
 * 同一份 DriftReport 被两个产品按各自语义 frame 消费，无需为每产品重算或加 frame 字段：
 *   - **治理 frame（enterprise）**：原样消费为「policy violation / alert」
 *     —— apps/web SafetyDriftReport 页直接读 alertLevel/valueDrifts.delta。
 *   - **成长 frame（companion）**：经共享纯函数 `driftReportToGrowth`
 *     （@chrono/contracts/companion/drift-to-growth）映射为「你最近探索的方向」
 *     —— src/server/routes/companion/me.ts 与 desktop 本地共用同一 mapper，零分叉。
 * 设计取舍：frame 派生用**共享 mapper 函数**（懒求值，growth frame 按需算），而非在此塞
 * `frames: {governance?, growth?}` 胖字段（会强制双产品 frame 同时 eager 计算 + 契约膨胀）。
 */
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

/**
 * 从 config_items 表解析当前生效的漂移阈值；DB 缺失或解析失败时使用 fallback。
 * 用于路由层动态读取（admin 通过 PATCH /admin/config 调整后立即生效，无需重启）。
 */
export function resolveDriftThresholds(
  db: IDatabase,
  fallback: DriftThresholds = DEFAULT_THRESHOLDS,
): DriftThresholds {
  const readNumber = (key: string): number | undefined => {
    try {
      const row = db.prepare<{ value_json: string }>(
        'SELECT value_json FROM config_items WHERE key = ?',
      ).get(key);
      if (!row) return undefined;
      const parsed = JSON.parse(row.value_json);
      return typeof parsed === 'number' ? parsed : undefined;
    } catch {
      return undefined;
    }
  };

  const warning = readNumber('safety.drift.warningThreshold') ?? fallback.warning;
  const critical = readNumber('safety.drift.criticalThreshold') ?? fallback.critical;

  // 防御性约束：critical 必须严格大于 warning，否则回退到 fallback
  if (critical <= warning) return fallback;

  return { warning, critical };
}

interface SnapshotRow {
  id: string;
  data_json: string;
  created_at: number;
  tenant_id: string | null;
}

/* drift 计算核心（解析快照价值 + delta + alertLevel + 综合分）已抽到 @chrono/contracts 的
 * computeDriftFromSnapshots，服务端与 desktop 本地共用（ADR-0046 路线 A）。本类只管 DB 取数 +
 * 报告组装 + 持久化。 */

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

    /* 计算复用 @chrono/contracts 共享纯函数（与 desktop 本地算 drift 同一份，零分叉）。 */
    const computed = computeDriftFromSnapshots(
      baseline.data_json,
      current.data_json,
      this.thresholds,
    );

    const report: DriftReport = {
      reportId,
      tenantId,
      baselineSnapshotId: baseline.id,
      analyzedAt: now,
      valueDrifts: computed.valueDrifts as ValueDrift[],
      overallDriftScore: computed.overallDriftScore,
      alertLevel: computed.alertLevel,
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
