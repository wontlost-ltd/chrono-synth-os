/**
 * 漂移告警服务（T0-B 收尾）
 *
 * 触发链：
 *   PersonaDriftAnalyzer.analyze() → 返回 DriftReport
 *     → DriftAlertService.process(report)
 *         ├─ alertLevel === 'ok'  → 不动作
 *         └─ alertLevel ∈ {warning, critical}
 *              ├─ 写 audit_log（business 类，actionType=safety.drift.<level>）
 *              └─ 若配置了 webhookUrl，best-effort POST（不阻塞主流程）
 *
 * 设计考量：
 *  - audit_log 写入是同步事务一部分，必须成功；webhook 是 best-effort
 *  - webhook 不重试（v1）：失败只记日志；后续可接 observability_outbox
 *  - 不在 PersonaDriftAnalyzer 内部直接发，避免分析器依赖网络
 */

import type { SyncWriteUnitOfWork } from '@chrono/kernel';
import type { Logger } from '../utils/logger.js';
import type { DriftReport } from './persona-drift-analyzer.js';
import { recordBusinessAuditLog } from '../audit/audit-log-store.js';

const LAYER = 'DriftAlertService';
const DEFAULT_WEBHOOK_TIMEOUT_MS = 5_000;
/** 截断 valueDrifts，避免 webhook 体积失控 */
const MAX_DRIFTS_IN_PAYLOAD = 50;

export interface DriftAlertOptions {
  readonly webhookUrl: string;
  readonly webhookTimeoutMs: number;
  readonly webhookSecret: string;
}

export interface DriftAlertDeps {
  readonly tx: SyncWriteUnitOfWork;
  readonly logger: Logger;
  readonly options: DriftAlertOptions;
}

export class DriftAlertService {
  constructor(private readonly deps: DriftAlertDeps) {}

  /**
   * 处理一份漂移报告：写审计 + 触发 webhook（异步，best-effort）。
   * 返回 alertEmitted=true 当告警等级不是 ok 时（无论 webhook 是否真发出）。
   */
  async process(report: DriftReport): Promise<{ alertEmitted: boolean; auditId: string | null }> {
    if (report.alertLevel === 'ok') {
      return { alertEmitted: false, auditId: null };
    }

    const auditId = this.recordAudit(report);
    if (this.deps.options.webhookUrl) {
      /* 异步发出，不阻塞分析流程；失败只记日志 */
      void this.deliverWebhook(report).catch((err) => {
        this.deps.logger.warn(
          LAYER,
          `webhook delivery failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }
    return { alertEmitted: true, auditId };
  }

  private recordAudit(report: DriftReport): string {
    const actionType = `safety.drift.${report.alertLevel}`;
    return recordBusinessAuditLog(this.deps.tx, {
      tenantId: report.tenantId,
      actorType: 'system',
      actorId: 'safety.drift-analyzer',
      actionType,
      targetType: 'persona_drift_report',
      targetId: report.reportId,
      payload: {
        baselineSnapshotId: report.baselineSnapshotId,
        analyzedAt: report.analyzedAt,
        overallDriftScore: report.overallDriftScore,
        alertLevel: report.alertLevel,
        topDrifts: this.topDrifts(report),
      },
    });
  }

  private async deliverWebhook(report: DriftReport): Promise<void> {
    const timeoutMs = this.deps.options.webhookTimeoutMs > 0
      ? this.deps.options.webhookTimeoutMs
      : DEFAULT_WEBHOOK_TIMEOUT_MS;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const body = JSON.stringify({
        type: 'safety.drift_alert',
        version: '1',
        report: {
          reportId: report.reportId,
          tenantId: report.tenantId,
          baselineSnapshotId: report.baselineSnapshotId,
          analyzedAt: report.analyzedAt,
          overallDriftScore: report.overallDriftScore,
          alertLevel: report.alertLevel,
          valueDrifts: this.topDrifts(report),
        },
      });
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (this.deps.options.webhookSecret) {
        headers['x-chrono-webhook-secret'] = this.deps.options.webhookSecret;
      }
      const res = await fetch(this.deps.options.webhookUrl, {
        method: 'POST',
        headers,
        body,
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
      }
    } finally {
      clearTimeout(timer);
    }
  }

  private topDrifts(report: DriftReport): DriftReport['valueDrifts'] {
    if (report.valueDrifts.length <= MAX_DRIFTS_IN_PAYLOAD) return report.valueDrifts;
    /* 取绝对漂移最大的 N 项 */
    return [...report.valueDrifts]
      .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
      .slice(0, MAX_DRIFTS_IN_PAYLOAD);
  }
}
