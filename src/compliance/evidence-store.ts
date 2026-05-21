/**
 * EvidenceStore — application-level facade over compliance_evidence rows.
 *
 * Plan: poc-to-enterprise-ga-2026-v7.3.md §2.2 P1-F-basic + §8 SOC2 W42/W48
 *
 * Why this exists: SOC2 Type II audits require N months of dated artifacts
 * for each control. Rather than ad-hoc CSV dumps when the auditor walks in,
 * we collect evidence continuously. Each row carries a SHA-256 fingerprint
 * of its canonical payload — auditors can independently verify nothing was
 * mutated between collection and review.
 *
 * Boundary contract:
 *   - Callers serialise the evidence body to JSON; this store hashes it
 *     and stores both the JSON and the hash.
 *   - We do NOT sign the row at write time. KMS signatures land in P1-F-ext
 *     (the W42 milestone). metadata_json reserves the slot.
 *   - The bundle exporter returns NDJSON for streaming (auditor tools eat
 *     NDJSON natively; no in-memory accumulation for large windows).
 */

import { createHash, randomUUID } from 'node:crypto';
import type { SyncWriteUnitOfWork, EvidenceRow as KernelEvidenceRow } from '@chrono/kernel';
import {
  evidenceCmdRecord, evidenceQueryById, evidenceQueryListByControl,
  evidenceQueryListByPeriod, evidenceQueryCount,
} from '@chrono/kernel';
import { registerCoreSelfExecutors } from '../storage/executors/index.js';

export type EvidenceCollector = 'system' | 'manual';

/**
 * Canonical SOC2 control IDs that may appear in `controlId`. We don't enum
 * them — the auditor's control matrix may add custom IDs (e.g. CC6.1.a) —
 * but document the common ones for IDE autocomplete via TS suggestions.
 */
export type SoCcControlId =
  | 'CC1.1' | 'CC1.2' | 'CC1.3' | 'CC1.4' | 'CC1.5'   /* Control Environment */
  | 'CC2.1' | 'CC2.2' | 'CC2.3'                          /* Communication & Info */
  | 'CC3.1' | 'CC3.2' | 'CC3.3' | 'CC3.4'                /* Risk Assessment */
  | 'CC4.1' | 'CC4.2'                                    /* Monitoring */
  | 'CC5.1' | 'CC5.2' | 'CC5.3'                          /* Control Activities */
  | 'CC6.1' | 'CC6.2' | 'CC6.3' | 'CC6.4' | 'CC6.5'
  | 'CC6.6' | 'CC6.7' | 'CC6.8'                          /* Logical & Physical Access */
  | 'CC7.1' | 'CC7.2' | 'CC7.3' | 'CC7.4' | 'CC7.5'      /* System Operations */
  | 'CC8.1'                                              /* Change Management */
  | 'CC9.1' | 'CC9.2'                                    /* Risk Mitigation */
  | 'A1.1' | 'A1.2' | 'A1.3'                             /* Availability */
  | (string & {});                                        /* extension escape */

export interface RecordEvidenceInput {
  tenantId: string;
  controlId: SoCcControlId;
  evidenceType: string;
  payload: unknown;
  collector?: EvidenceCollector;
  periodStart?: number;
  periodEnd?: number;
  metadata?: Record<string, unknown>;
  collectedAt?: number;
}

export interface EvidenceRecord {
  id: string;
  tenantId: string;
  controlId: string;
  evidenceType: string;
  collector: EvidenceCollector;
  payload: unknown;
  payloadSha256: string;
  collectedAt: number;
  periodStart: number | null;
  periodEnd: number | null;
  metadata: Record<string, unknown> | null;
}

/**
 * Stable JSON serialisation for hashing. Keys sorted recursively so the
 * fingerprint doesn't depend on object literal property order — auditors
 * regenerating the hash from the payload alone get the same value.
 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map(k => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
}

export function computeEvidenceHash(payload: unknown): { json: string; sha256: string } {
  const json = canonicalJson(payload);
  const sha256 = createHash('sha256').update(json).digest('hex');
  return { json, sha256 };
}

export function recordEvidence(tx: SyncWriteUnitOfWork, input: RecordEvidenceInput): string {
  registerCoreSelfExecutors();
  const id = randomUUID();
  const collectedAt = input.collectedAt ?? Date.now();
  const { json, sha256 } = computeEvidenceHash(input.payload);
  tx.execute(evidenceCmdRecord({
    id,
    tenantId: input.tenantId,
    controlId: input.controlId,
    evidenceType: input.evidenceType,
    collector: input.collector ?? 'system',
    payloadJson: json,
    payloadSha256: sha256,
    collectedAt,
    periodStart: input.periodStart ?? null,
    periodEnd: input.periodEnd ?? null,
    metadataJson: input.metadata ? JSON.stringify(input.metadata) : null,
  }));
  return id;
}

function fromRow(row: KernelEvidenceRow): EvidenceRecord {
  let payload: unknown = null;
  try { payload = JSON.parse(row.payload_json); } catch { /* corrupt → null */ }
  let metadata: Record<string, unknown> | null = null;
  if (row.metadata_json) {
    try {
      const parsed = JSON.parse(row.metadata_json);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        metadata = parsed as Record<string, unknown>;
      }
    } catch { /* leave null */ }
  }
  return {
    id: row.id,
    tenantId: row.tenant_id,
    controlId: row.control_id,
    evidenceType: row.evidence_type,
    collector: row.collector as EvidenceCollector,
    payload,
    payloadSha256: row.payload_sha256,
    collectedAt: Number(row.collected_at),
    periodStart: row.period_start === null ? null : Number(row.period_start),
    periodEnd: row.period_end === null ? null : Number(row.period_end),
    metadata,
  };
}

export function getEvidenceById(tx: SyncWriteUnitOfWork, tenantId: string, id: string): EvidenceRecord | null {
  registerCoreSelfExecutors();
  const row = tx.queryOne(evidenceQueryById(tenantId, id));
  return row ? fromRow(row) : null;
}

export function listEvidenceByControl(
  tx: SyncWriteUnitOfWork,
  tenantId: string,
  controlId: string,
  opts: { limit?: number; offset?: number } = {},
): EvidenceRecord[] {
  registerCoreSelfExecutors();
  const rows = tx.queryMany(evidenceQueryListByControl({
    tenantId, controlId, limit: opts.limit, offset: opts.offset,
  }));
  return rows.map(fromRow);
}

export function listEvidenceByPeriod(
  tx: SyncWriteUnitOfWork,
  tenantId: string,
  fromMs: number,
  toMs: number,
  opts: { controlIds?: readonly string[]; limit?: number } = {},
): EvidenceRecord[] {
  registerCoreSelfExecutors();
  const rows = tx.queryMany(evidenceQueryListByPeriod({
    tenantId, fromMs, toMs, controlIds: opts.controlIds, limit: opts.limit,
  }));
  return rows.map(fromRow);
}

export function countEvidence(
  tx: SyncWriteUnitOfWork,
  tenantId: string,
  controlId?: string,
): number {
  registerCoreSelfExecutors();
  const row = tx.queryOne(evidenceQueryCount({ tenantId, controlId }));
  return Number(row?.count ?? 0);
}

/**
 * Stream the evidence rows for a reporting window as NDJSON lines. Each
 * line is a fully verifiable record (the auditor can recompute the
 * SHA-256 from `payload` and compare to `payloadSha256`).
 *
 * Returns the lines instead of writing directly — caller decides where to
 * send them (HTTP response, S3 PUT, file).
 */
export function exportEvidenceBundle(
  tx: SyncWriteUnitOfWork,
  tenantId: string,
  fromMs: number,
  toMs: number,
  opts: { controlIds?: readonly string[]; limit?: number } = {},
): string[] {
  const rows = listEvidenceByPeriod(tx, tenantId, fromMs, toMs, opts);
  return rows.map(r => JSON.stringify(r));
}

/**
 * Re-hash every evidence row in [fromMs, toMs] and report mismatches.
 * Auditor-facing integrity check — analogous to verifyAuditChain on the
 * audit log, but row-independent (no chain semantics on evidence yet;
 * chain ships with P1-F-ext + KMS signatures).
 */
export interface EvidenceIntegrityResult {
  ok: boolean;
  totalChecked: number;
  mismatches: Array<{ id: string; controlId: string; expected: string; actual: string }>;
}

export function verifyEvidenceIntegrity(
  tx: SyncWriteUnitOfWork,
  tenantId: string,
  fromMs: number,
  toMs: number,
  opts: { controlIds?: readonly string[]; limit?: number } = {},
): EvidenceIntegrityResult {
  const rows = listEvidenceByPeriod(tx, tenantId, fromMs, toMs, opts);
  const mismatches: EvidenceIntegrityResult['mismatches'] = [];
  for (const row of rows) {
    const { sha256 } = computeEvidenceHash(row.payload);
    if (sha256 !== row.payloadSha256) {
      mismatches.push({ id: row.id, controlId: row.controlId, expected: sha256, actual: row.payloadSha256 });
    }
  }
  return { ok: mismatches.length === 0, totalChecked: rows.length, mismatches };
}
