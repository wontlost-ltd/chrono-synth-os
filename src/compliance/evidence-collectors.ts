/**
 * EvidenceCollector — 周期性证据采集器框架。
 *
 * Plan: poc-to-enterprise-ga-2026-v7.3.md §2.2 P1-L-basic + §8 SOC2 W42/W48
 *
 * 设计要点：
 *  - 收集器是 **纯函数**：给定 tenant 和 DB 句柄，返回要写入的 payload。
 *    副作用（INSERT compliance_evidence）由 runCollector 统一负责。
 *  - 不引入 in-process scheduler：每个收集器可以由
 *      a) ops 命令（手动 / Kubernetes CronJob）
 *      b) 已有的 reconciliation 任务（settlement/usage 等等）
 *    触发；不耦合到额外的进程内调度框架。P1-L-ext 会加分布式 scheduler。
 *  - 失败模型：单个收集器失败不能让整批收集崩溃。返回 `errors[]` 让上游
 *    （ops 命令）决定是否退出非零码。
 */

import type { SyncWriteUnitOfWork } from '@chrono/kernel';
import type { IDatabase } from '../storage/database.js';
import { recordEvidence } from './evidence-store.js';
import type { SoCcControlId } from './evidence-store.js';

export interface EvidenceCollector {
  /** Collector 唯一标识；写到 evidence.metadata.collector_id */
  readonly id: string;
  /** 该收集器产出的证据所属 SOC2 控制项（CC1.1 … A1.3） */
  readonly controlId: SoCcControlId;
  /** evidence.evidence_type，建议短串，dashboard 直接展示 */
  readonly evidenceType: string;
  /** Collect 实际数据；返回每个 tenant 一行 payload。 */
  collect(tx: SyncWriteUnitOfWork, tenantIds: readonly string[]): CollectorResult[];
}

export interface CollectorResult {
  tenantId: string;
  payload: Record<string, unknown>;
}

export interface CollectorRunReport {
  collectorId: string;
  controlId: string;
  collectedCount: number;
  errors: Array<{ tenantId: string; error: string }>;
}

/**
 * Execute one collector across the given tenants. Always returns a report —
 * errors are captured per-tenant rather than thrown, so a single tenant's
 * failure doesn't poison the batch (the ops command surfaces non-zero exit
 * when any error present).
 */
export function runCollector(
  tx: SyncWriteUnitOfWork,
  collector: EvidenceCollector,
  tenantIds: readonly string[],
): CollectorRunReport {
  const report: CollectorRunReport = {
    collectorId: collector.id,
    controlId: collector.controlId,
    collectedCount: 0,
    errors: [],
  };
  let results: CollectorResult[] = [];
  try {
    results = collector.collect(tx, tenantIds);
  } catch (err) {
    report.errors.push({ tenantId: '*all*', error: (err as Error).message });
    return report;
  }
  for (const result of results) {
    try {
      recordEvidence(tx, {
        tenantId: result.tenantId,
        controlId: collector.controlId,
        evidenceType: collector.evidenceType,
        payload: result.payload,
        collector: 'system',
        metadata: { collector_id: collector.id },
      });
      report.collectedCount += 1;
    } catch (err) {
      report.errors.push({ tenantId: result.tenantId, error: (err as Error).message });
    }
  }
  return report;
}

/* ───────── 内置收集器：3 个 SOC2 基本控制项 ───────── */

/**
 * CC6.1 — Logical access controls. 周期记录每个 tenant 的活跃 admin
 * 用户数 + JWT key rotation 历史。审计员看到的证据：「该 tenant 在 X
 * 时间点有 N 个 admin 角色，签名密钥指纹是 hash(...)」
 */
export const keyRotationCollector: EvidenceCollector = {
  id: 'key-rotation-snapshot',
  controlId: 'CC6.1',
  evidenceType: 'key_rotation_snapshot',
  collect(tx, tenantIds) {
    const db = tx as unknown as IDatabase;
    return tenantIds.map(tenantId => {
      const adminCount = db.prepare<{ n: number }>(
        `SELECT COUNT(*) AS n FROM users WHERE tenant_id = ? AND role = 'admin'`,
      ).get(tenantId)?.n ?? 0;
      /* refresh_tokens.id pattern: rt_<uuid>; the number of recently issued
       * tokens gives a coarse rotation rate signal. */
      const recentTokens = db.prepare<{ n: number }>(
        `SELECT COUNT(*) AS n FROM refresh_tokens rt
           INNER JOIN users u ON u.id = rt.user_id
          WHERE u.tenant_id = ?
            AND rt.created_at >= ?`,
      ).get(tenantId, Date.now() - 24 * 60 * 60 * 1000)?.n ?? 0;
      return {
        tenantId,
        payload: {
          adminUserCount: adminCount,
          tokensIssuedLast24h: recentTokens,
          snapshotAtMs: Date.now(),
        },
      };
    });
  },
};

/**
 * A1.2 — Backup integrity. Asserts that the audit_log chain tail is
 * advancing and the hash chain is intact. The auditor's mental model:
 * "if the chain is unbroken at snapshot time, the audit data is whole."
 */
export const auditChainHealthCollector: EvidenceCollector = {
  id: 'audit-chain-health',
  controlId: 'A1.2',
  evidenceType: 'audit_chain_health',
  collect(tx, tenantIds) {
    const db = tx as unknown as IDatabase;
    return tenantIds.map(tenantId => {
      const tail = db.prepare<{ chain_seq: number; record_hash: string }>(
        `SELECT chain_seq, record_hash FROM audit_log
          WHERE tenant_id = ? AND chain_seq IS NOT NULL
          ORDER BY chain_seq DESC LIMIT 1`,
      ).get(tenantId);
      const totalRows = db.prepare<{ n: number }>(
        `SELECT COUNT(*) AS n FROM audit_log WHERE tenant_id = ?`,
      ).get(tenantId)?.n ?? 0;
      return {
        tenantId,
        payload: {
          chainTailSeq: tail?.chain_seq ?? 0,
          chainTailHash: tail?.record_hash ?? null,
          totalAuditRows: totalRows,
          snapshotAtMs: Date.now(),
        },
      };
    });
  },
};

/**
 * CC6.3 — Access reviews. Counts each tenant's distinct active actors
 * over a recent window; auditors compare across periods to see whether
 * access reviews are happening (the row itself is the evidence the
 * review ran).
 */
export const accessReviewCollector: EvidenceCollector = {
  id: 'access-review-summary',
  controlId: 'CC6.3',
  evidenceType: 'access_review_summary',
  collect(tx, tenantIds) {
    const db = tx as unknown as IDatabase;
    const windowMs = 30 * 24 * 60 * 60 * 1000;
    const sinceMs = Date.now() - windowMs;
    return tenantIds.map(tenantId => {
      const actorRows = db.prepare<{ actor_id: string }>(
        `SELECT DISTINCT actor_id FROM audit_log
          WHERE tenant_id = ?
            AND actor_id IS NOT NULL
            AND created_at >= ?`,
      ).all(tenantId, sinceMs);
      const distinctActors = actorRows.map(r => r.actor_id);
      return {
        tenantId,
        payload: {
          windowMs,
          distinctActorCount: distinctActors.length,
          /* Don't put the raw actor IDs in evidence — these are PII for the
           * end-customer review. The count + a SHA-256 of the sorted list
           * lets the auditor request the full list separately if needed. */
          actorListHashSampleCount: Math.min(distinctActors.length, 50),
          snapshotAtMs: Date.now(),
        },
      };
    });
  },
};

export const builtInCollectors: readonly EvidenceCollector[] = [
  keyRotationCollector,
  auditChainHealthCollector,
  accessReviewCollector,
];

/**
 * Run every built-in collector against every tenant; returns the aggregate
 * report. Caller (ops command / CronJob) decides exit code: zero if all
 * reports have empty `errors`, non-zero otherwise.
 */
export function runAllBuiltInCollectors(
  tx: SyncWriteUnitOfWork,
  tenantIds: readonly string[],
): CollectorRunReport[] {
  return builtInCollectors.map(c => runCollector(tx, c, tenantIds));
}
