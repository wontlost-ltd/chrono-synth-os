/**
 * SOC2 evidence collection — Query/Command kinds for the kernel data plane.
 *
 * Plan: poc-to-enterprise-ga-2026-v7.3.md §2.2 P1-F-basic + §8 SOC2 W42/W48
 *
 * The kernel only declares the shape; storage executors live in
 * `src/storage/executors/compliance-evidence-executors.ts`. Kept here so
 * the contract is portable across desktop/edge runtimes that lack the
 * Node server.
 */

import type { Query, Command } from '../../ports/query.js';

export const EVIDENCE_QUERY_BY_ID = 'compliance.evidence.byId' as const;
export const EVIDENCE_QUERY_LIST_BY_CONTROL = 'compliance.evidence.listByControl' as const;
export const EVIDENCE_QUERY_LIST_BY_PERIOD = 'compliance.evidence.listByPeriod' as const;
export const EVIDENCE_QUERY_COUNT = 'compliance.evidence.count' as const;
export const EVIDENCE_CMD_RECORD = 'compliance.evidence.record' as const;

export interface EvidenceRow {
  id: string;
  tenant_id: string;
  control_id: string;
  evidence_type: string;
  collector: string;
  payload_json: string;
  payload_sha256: string;
  collected_at: number;
  period_start: number | null;
  period_end: number | null;
  metadata_json: string | null;
}

export interface EvidenceByIdParams {
  tenantId: string;
  id: string;
}

export interface EvidenceListByControlParams {
  tenantId: string;
  controlId: string;
  limit?: number;
  offset?: number;
}

export interface EvidenceListByPeriodParams {
  tenantId: string;
  fromMs: number;
  toMs: number;
  controlIds?: readonly string[];
  limit?: number;
}

export interface EvidenceCountParams {
  tenantId: string;
  controlId?: string;
}

export interface EvidenceRecordParams {
  id: string;
  tenantId: string;
  controlId: string;
  evidenceType: string;
  collector: string;
  payloadJson: string;
  payloadSha256: string;
  collectedAt: number;
  periodStart: number | null;
  periodEnd: number | null;
  metadataJson: string | null;
}

export function evidenceQueryById(tenantId: string, id: string): Query<EvidenceRow | null, EvidenceByIdParams> {
  return { kind: EVIDENCE_QUERY_BY_ID, params: { tenantId, id } };
}

export function evidenceQueryListByControl(params: EvidenceListByControlParams): Query<EvidenceRow, EvidenceListByControlParams> {
  return { kind: EVIDENCE_QUERY_LIST_BY_CONTROL, params };
}

export function evidenceQueryListByPeriod(params: EvidenceListByPeriodParams): Query<EvidenceRow, EvidenceListByPeriodParams> {
  return { kind: EVIDENCE_QUERY_LIST_BY_PERIOD, params };
}

export function evidenceQueryCount(params: EvidenceCountParams): Query<{ count: number } | null, EvidenceCountParams> {
  return { kind: EVIDENCE_QUERY_COUNT, params };
}

export function evidenceCmdRecord(params: EvidenceRecordParams): Command<EvidenceRecordParams> {
  return { kind: EVIDENCE_CMD_RECORD, params };
}
