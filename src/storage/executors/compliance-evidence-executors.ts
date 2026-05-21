/**
 * SOC2 evidence collection — SQL executors for the kernel data plane.
 *
 * Plan: poc-to-enterprise-ga-2026-v7.3.md §2.2 P1-F-basic
 *
 * Mirrors audit-log-executors layout: all SQL parameters bound, no string
 * interpolation; portable across SQLite and PG via the IDatabase abstraction.
 */

import { registerQuery, registerCommand } from '../legacy-sync-bridge.js';
import type { SqlValue } from '../database.js';
import type {
  EvidenceRow,
  EvidenceByIdParams,
  EvidenceListByControlParams,
  EvidenceListByPeriodParams,
  EvidenceCountParams,
  EvidenceRecordParams,
} from '@chrono/kernel';
import {
  EVIDENCE_QUERY_BY_ID,
  EVIDENCE_QUERY_LIST_BY_CONTROL,
  EVIDENCE_QUERY_LIST_BY_PERIOD,
  EVIDENCE_QUERY_COUNT,
  EVIDENCE_CMD_RECORD,
} from '@chrono/kernel';

const EVIDENCE_SELECT = `
  SELECT id, tenant_id, control_id, evidence_type, collector,
    payload_json, payload_sha256, collected_at,
    period_start, period_end, metadata_json
  FROM compliance_evidence
`;

export function registerComplianceEvidenceExecutors(): void {
  registerQuery<EvidenceRow | null, EvidenceByIdParams>(EVIDENCE_QUERY_BY_ID, (db, p) => {
    return db.prepare<EvidenceRow>(
      `${EVIDENCE_SELECT} WHERE tenant_id = ? AND id = ? LIMIT 1`,
    ).get(p.tenantId, p.id) ?? null;
  });

  registerQuery<EvidenceRow[], EvidenceListByControlParams>(EVIDENCE_QUERY_LIST_BY_CONTROL, (db, p) => {
    const limit = p.limit ?? 100;
    const offset = p.offset ?? 0;
    return db.prepare<EvidenceRow>(
      `${EVIDENCE_SELECT}
       WHERE tenant_id = ? AND control_id = ?
       ORDER BY collected_at DESC
       LIMIT ? OFFSET ?`,
    ).all(p.tenantId, p.controlId, limit, offset);
  });

  registerQuery<EvidenceRow[], EvidenceListByPeriodParams>(EVIDENCE_QUERY_LIST_BY_PERIOD, (db, p) => {
    const limit = p.limit ?? 1000;
    const params: SqlValue[] = [p.tenantId, p.fromMs, p.toMs];
    /* control_id list filter — only inline the IN clause when caller provides
     * IDs; avoid passing an empty IN () which is a syntax error in both
     * engines. Bind each id as a parameter so the SOC2 control ids never
     * become a string-concatenation injection surface. */
    let controlFilter = '';
    if (p.controlIds && p.controlIds.length > 0) {
      const placeholders = p.controlIds.map(() => '?').join(', ');
      controlFilter = ` AND control_id IN (${placeholders})`;
      for (const id of p.controlIds) params.push(id);
    }
    params.push(limit);
    return db.prepare<EvidenceRow>(
      `${EVIDENCE_SELECT}
       WHERE tenant_id = ?
         AND collected_at >= ?
         AND collected_at <= ?
         ${controlFilter}
       ORDER BY collected_at ASC
       LIMIT ?`,
    ).all(...params);
  });

  registerQuery<{ count: number } | null, EvidenceCountParams>(EVIDENCE_QUERY_COUNT, (db, p) => {
    if (p.controlId) {
      return db.prepare<{ count: number }>(
        'SELECT COUNT(*) AS count FROM compliance_evidence WHERE tenant_id = ? AND control_id = ?',
      ).get(p.tenantId, p.controlId) ?? null;
    }
    return db.prepare<{ count: number }>(
      'SELECT COUNT(*) AS count FROM compliance_evidence WHERE tenant_id = ?',
    ).get(p.tenantId) ?? null;
  });

  registerCommand<EvidenceRecordParams>(EVIDENCE_CMD_RECORD, (db, p) => {
    const result = db.prepare<void>(
      `INSERT INTO compliance_evidence (
        id, tenant_id, control_id, evidence_type, collector,
        payload_json, payload_sha256, collected_at,
        period_start, period_end, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      p.id, p.tenantId, p.controlId, p.evidenceType, p.collector,
      p.payloadJson, p.payloadSha256, p.collectedAt,
      p.periodStart, p.periodEnd, p.metadataJson,
    );
    return { rowsAffected: result.changes };
  });
}
