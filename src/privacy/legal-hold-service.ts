/**
 * LegalHoldService — manages litigation / regulatory holds that block
 * privacy deletion actions.
 *
 * Plan: poc-to-enterprise-ga-2026-v7.3.md §3.6 P1-N
 *
 * Why a registry rather than a flag column on `tenants`/`users`:
 *   - Holds need an audit trail (who/when/why created, who/when released).
 *   - A single subject may have multiple overlapping holds (litigation +
 *     regulator inquiry); release must be per-hold, not per-subject.
 *   - SOC2 evidence: the rows themselves are the proof that a hold was
 *     respected during a deletion request — auditors read them directly.
 */

import { randomUUID } from 'node:crypto';
import type { IDatabase } from '../storage/database.js';

export type HoldSubject = 'tenant' | 'user' | 'persona';

export interface LegalHold {
  readonly id: string;
  readonly tenantId: string;
  readonly subject: HoldSubject;
  readonly subjectId: string | null;
  readonly reason: string;
  readonly createdBy: string;
  readonly createdAt: number;
  readonly releasedAt: number | null;
  readonly releasedBy: string | null;
}

interface LegalHoldRow {
  id: string;
  tenant_id: string;
  subject: string;
  subject_id: string | null;
  reason: string;
  created_by: string;
  created_at: number;
  released_at: number | null;
  released_by: string | null;
}

function fromRow(row: LegalHoldRow): LegalHold {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    subject: row.subject as HoldSubject,
    subjectId: row.subject_id,
    reason: row.reason,
    createdBy: row.created_by,
    createdAt: Number(row.created_at),
    releasedAt: row.released_at === null ? null : Number(row.released_at),
    releasedBy: row.released_by,
  };
}

export interface PlaceHoldInput {
  tenantId: string;
  subject: HoldSubject;
  /** Required when subject is 'user' or 'persona'; null/undefined for 'tenant'. */
  subjectId?: string | null;
  reason: string;
  createdBy: string;
}

/**
 * Thrown when a delete/export/retention action targets a subject that's
 * under an active legal hold. Carries enough detail for the caller to
 * surface a human-readable refusal (audit log + admin UI).
 */
export class LegalHoldActiveError extends Error {
  readonly code = 'LEGAL_HOLD_ACTIVE' as const;
  readonly statusCode = 423 as const; /* "Locked" per RFC 4918 */
  constructor(readonly hold: LegalHold) {
    super(`Action blocked: legal hold ${hold.id} active on ${hold.subject}${hold.subjectId ? ':' + hold.subjectId : ''} (${hold.reason})`);
    this.name = 'LegalHoldActiveError';
  }
}

export class LegalHoldService {
  constructor(private readonly db: IDatabase) {}

  placeHold(input: PlaceHoldInput): LegalHold {
    if (input.subject !== 'tenant' && !input.subjectId) {
      throw new Error(`subject=${input.subject} requires subjectId`);
    }
    const id = `lh_${randomUUID()}`;
    const now = Date.now();
    this.db.prepare(
      `INSERT INTO legal_holds
         (id, tenant_id, subject, subject_id, reason, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id, input.tenantId, input.subject, input.subjectId ?? null,
      input.reason, input.createdBy, now,
    );
    return this.requireById(id);
  }

  releaseHold(id: string, releasedBy: string, tenantId: string): LegalHold {
    const existing = this.findById(id);
    if (!existing) throw new Error(`legal hold ${id} not found`);
    if (existing.tenantId !== tenantId) {
      throw new Error(`legal hold ${id} belongs to a different tenant; cross-tenant release blocked`);
    }
    if (existing.releasedAt !== null) {
      /* Idempotent: re-releasing an already-released hold is a no-op,
       * not an error. Lets the admin UI safely retry. */
      return existing;
    }
    const now = Date.now();
    this.db.prepare(
      `UPDATE legal_holds SET released_at = ?, released_by = ? WHERE id = ?`,
    ).run(now, releasedBy, id);
    return this.requireById(id);
  }

  /**
   * Returns the first active hold that blocks deletion of (tenantId,
   * subject, subjectId), or null if none. A tenant-level hold blocks
   * everything within that tenant (the conservative interpretation —
   * regulators almost never narrow the hold scope themselves).
   */
  findBlockingHold(
    tenantId: string,
    subject: HoldSubject,
    subjectId: string | null,
  ): LegalHold | null {
    /* Tenant-level hold blocks regardless of subject. */
    const tenantWide = this.db.prepare<LegalHoldRow>(
      `SELECT * FROM legal_holds
        WHERE tenant_id = ? AND subject = 'tenant' AND released_at IS NULL
        ORDER BY created_at DESC LIMIT 1`,
    ).get(tenantId);
    if (tenantWide) return fromRow(tenantWide);

    if (subject === 'tenant' || !subjectId) {
      /* Caller asked about the whole tenant or a missing subjectId; any
       * subject-specific hold on the tenant counts as a blocker for the
       * tenant-wide action (we can't delete tenant without releasing
       * every overlapping sub-hold). */
      const any = this.db.prepare<LegalHoldRow>(
        `SELECT * FROM legal_holds
          WHERE tenant_id = ? AND released_at IS NULL
          ORDER BY created_at DESC LIMIT 1`,
      ).get(tenantId);
      return any ? fromRow(any) : null;
    }

    /* Subject-specific lookup. */
    const specific = this.db.prepare<LegalHoldRow>(
      `SELECT * FROM legal_holds
        WHERE tenant_id = ?
          AND subject = ?
          AND subject_id = ?
          AND released_at IS NULL
        ORDER BY created_at DESC LIMIT 1`,
    ).get(tenantId, subject, subjectId);
    return specific ? fromRow(specific) : null;
  }

  /**
   * Throw LegalHoldActiveError if a hold blocks the action. Callers
   * place this guard immediately before invoking PrivacyService.deleteData
   * or any retention sweep.
   */
  assertNoBlockingHold(
    tenantId: string,
    subject: HoldSubject,
    subjectId: string | null,
  ): void {
    const hold = this.findBlockingHold(tenantId, subject, subjectId);
    if (hold) throw new LegalHoldActiveError(hold);
  }

  listActive(tenantId: string): LegalHold[] {
    return this.db.prepare<LegalHoldRow>(
      `SELECT * FROM legal_holds WHERE tenant_id = ? AND released_at IS NULL ORDER BY created_at DESC`,
    ).all(tenantId).map(fromRow);
  }

  findById(id: string): LegalHold | null {
    const row = this.db.prepare<LegalHoldRow>(
      `SELECT * FROM legal_holds WHERE id = ? LIMIT 1`,
    ).get(id);
    return row ? fromRow(row) : null;
  }

  private requireById(id: string): LegalHold {
    const hold = this.findById(id);
    if (!hold) throw new Error(`legal hold ${id} created but not retrievable — DB error`);
    return hold;
  }
}
