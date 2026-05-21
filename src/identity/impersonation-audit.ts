/**
 * Impersonation audit — record every "admin acting as user X" event with
 * full audit trail.
 *
 * Plan: poc-to-enterprise-ga-2026-v7.3.md §3.9 P1-S-admin-access
 *
 * Threat model:
 *   Support / SRE roles occasionally need to "act as" a customer to
 *   reproduce a bug or recover a stuck account. Without audit, this is
 *   indistinguishable from insider abuse. Every impersonation start +
 *   stop must produce:
 *     - SOC2 CC6.7 (least privilege / sensitive access) evidence row
 *     - audit_log business event with the admin and target user
 *     - hash-chain coverage (free via P0-E)
 *
 * Workflow:
 *   1. Admin clicks "Impersonate user X" with reason + ticket id
 *   2. startImpersonation() opens the session, returns sessionId
 *   3. UI shows red banner during the session
 *   4. Every action the admin takes is tagged with sessionId in audit_log
 *   5. stopImpersonation(sessionId) closes the session
 *
 * Session state is NOT persisted to a session table here; the audit
 * trail itself IS the record. UI persistence can use cookies / localStorage.
 */

import { randomUUID } from 'node:crypto';
import type { IDatabase } from '../storage/database.js';
import type { SyncWriteUnitOfWork } from '@chrono/kernel';
import { recordEvidence } from '../compliance/evidence-store.js';
import { recordBusinessAuditLog } from '../audit/audit-log-store.js';

export interface ImpersonationStart {
  /** Tenant scope. */
  tenantId: string;
  /** Admin / support actor doing the impersonation. */
  adminUserId: string;
  /** End-user being impersonated. */
  targetUserId: string;
  /** Business reason (free-form). */
  reason: string;
  /** External ticket / incident id for cross-reference. */
  ticketId: string;
  /** Hard expiry; service refuses sessions longer than 4h to bound risk. */
  durationMs?: number;
}

export const MAX_IMPERSONATION_MS = 4 * 60 * 60 * 1000;

export interface ImpersonationSession {
  sessionId: string;
  tenantId: string;
  adminUserId: string;
  targetUserId: string;
  expiresAtMs: number;
}

export class ImpersonationError extends Error {
  constructor(readonly code: 'NO_TICKET' | 'NO_REASON' | 'DURATION_TOO_LONG', message: string) {
    super(message);
    this.name = 'ImpersonationError';
  }
}

export function startImpersonation(
  tx: SyncWriteUnitOfWork,
  db: IDatabase,
  input: ImpersonationStart,
): ImpersonationSession {
  if (!input.ticketId || input.ticketId.trim().length === 0) {
    throw new ImpersonationError('NO_TICKET', 'impersonation requires an external ticket id');
  }
  if (!input.reason || input.reason.trim().length < 8) {
    throw new ImpersonationError('NO_REASON', 'impersonation reason must be ≥8 chars');
  }
  const ttl = input.durationMs ?? MAX_IMPERSONATION_MS;
  if (ttl > MAX_IMPERSONATION_MS || ttl <= 0) {
    throw new ImpersonationError('DURATION_TOO_LONG', `durationMs must be in (0, ${MAX_IMPERSONATION_MS}]`);
  }
  const sessionId = `imp_${randomUUID()}`;
  const expiresAtMs = Date.now() + ttl;
  /* Business audit log — append-only with hash chain. */
  recordBusinessAuditLog(tx, {
    tenantId: input.tenantId,
    actorType: 'user',
    actorId: input.adminUserId,
    actionType: 'impersonation.start',
    targetType: 'user',
    targetId: input.targetUserId,
    payload: {
      sessionId,
      ticketId: input.ticketId,
      reason: input.reason,
      expiresAtMs,
    },
  });
  /* SOC2 evidence — CC6.7 sensitive access. */
  try {
    recordEvidence(tx, {
      tenantId: input.tenantId,
      controlId: 'CC6.7',
      evidenceType: 'impersonation_start',
      payload: {
        sessionId,
        adminUserId: input.adminUserId,
        targetUserId: input.targetUserId,
        ticketId: input.ticketId,
        /* Don't store the free-form reason as PII — keep its length as a
         * proof it was filled in but not the text itself. The audit_log
         * row above keeps the full text for incident review. */
        reasonLength: input.reason.length,
        expiresAtMs,
      },
    });
  } catch { /* never block impersonation on evidence write */ }
  void db;
  return { sessionId, tenantId: input.tenantId, adminUserId: input.adminUserId, targetUserId: input.targetUserId, expiresAtMs };
}

export function stopImpersonation(
  tx: SyncWriteUnitOfWork,
  session: ImpersonationSession,
): void {
  recordBusinessAuditLog(tx, {
    tenantId: session.tenantId,
    actorType: 'user',
    actorId: session.adminUserId,
    actionType: 'impersonation.stop',
    targetType: 'user',
    targetId: session.targetUserId,
    payload: { sessionId: session.sessionId },
  });
  try {
    recordEvidence(tx, {
      tenantId: session.tenantId,
      controlId: 'CC6.7',
      evidenceType: 'impersonation_stop',
      payload: {
        sessionId: session.sessionId,
        adminUserId: session.adminUserId,
        targetUserId: session.targetUserId,
      },
    });
  } catch { /* never block on evidence */ }
}
