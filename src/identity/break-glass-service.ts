/**
 * Break-glass token service — emergency admin operations with strict
 * audit trail, short TTL, single use, and pre-approved scope.
 *
 * Plan: poc-to-enterprise-ga-2026-v7.3.md §3.5 P1-M + §8 #15
 *
 * Threat model:
 *   Production incidents sometimes require operations that bypass normal
 *   authorization (e.g. "rotate the JWT signing key NOW because the
 *   primary key may be compromised"). Granting an admin's normal token
 *   that power is over-broad — that token is good for 15 min on every
 *   admin endpoint. Break-glass tokens are:
 *     - signed by a separate emergency signing key (not the JWT KeyRing)
 *     - bound to one named scope (e.g. 'auth.keys.rotate')
 *     - jti-bound to a single use (consumed atomically on first verify)
 *     - tied to a pre-recorded approval_id (the audit trail of who
 *       authorised the emergency)
 *     - 15min TTL hard ceiling
 *     - every issue + use + refusal writes a SOC2 CC6.1 evidence row
 *
 * Where this fits in the lifecycle:
 *   - Issuance: BreakGlassService.issue() — called by on-call SRE
 *     during an incident, with a pre-recorded approval id
 *   - Verification: BreakGlassService.verify(token, requiredScope)
 *     — called by the endpoint handler before performing the
 *     emergency action; consumes the jti so reuse fails
 *   - Audit: every operation writes a compliance_evidence row on
 *     CC6.1 with the action + actor + approval_id + outcome
 */

import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { IDatabase } from '../storage/database.js';
import { recordEvidence } from '../compliance/evidence-store.js';

export type BreakGlassScope =
  | 'auth.keys.rotate'
  | 'auth.keys.compromise'
  | 'auth.user.unlock'
  | 'data.restore'
  | 'tenant.delete-override';

export interface BreakGlassPayload {
  /** Stable token id; deny-list & single-use consumption key. */
  jti: string;
  /** Issue time (ms). */
  iat: number;
  /** Expiry (ms); must be ≤ iat + MAX_TTL_MS. */
  exp: number;
  /** Operator who requested the token (audit). */
  requestedBy: string;
  /** Approval workflow record id (e.g. PagerDuty incident, JIRA ticket). */
  approvalId: string;
  /** Exact scope this token is good for; verify rejects any other. */
  scope: BreakGlassScope;
  /** Tenant the action targets; empty = platform-global. */
  tenantId: string;
}

export const MAX_TTL_MS = 15 * 60 * 1000;

export class BreakGlassError extends Error {
  constructor(readonly code:
    | 'INVALID_FORMAT'
    | 'SIGNATURE_INVALID'
    | 'EXPIRED'
    | 'SCOPE_MISMATCH'
    | 'TENANT_MISMATCH'
    | 'ALREADY_USED'
    | 'NO_APPROVAL_ID'
    | 'TTL_TOO_LONG',
    message: string,
  ) {
    super(message);
    this.name = 'BreakGlassError';
  }
}

interface UsedJtiRow {
  jti: string;
  consumed_at: number;
  consumed_by: string;
}

/**
 * Stateful service — needs to remember consumed jtis. We store them in
 * a small in-memory map for the process; jti deny-list (P0-D) handles
 * cross-process via DB.
 *
 * For v1 break-glass tokens are single-process: an on-call SRE requests
 * one, uses it within 15 min on the same app instance. Cross-instance
 * use needs the DB-backed deny-list which P1-M v2 adds.
 */
export class BreakGlassService {
  private readonly consumedJtis = new Map<string, UsedJtiRow>();
  /** Periodic-eviction guard: removes consumed jtis older than 2× MAX_TTL. */
  private lastGc = Date.now();

  constructor(
    private readonly db: IDatabase,
    /** Signing key for break-glass HMAC; ROTATE on suspected compromise. */
    private readonly signingKey: string,
  ) {
    if (!signingKey || signingKey.length < 32) {
      throw new Error('break-glass signing key must be ≥32 chars');
    }
  }

  /**
   * Issue a token. The caller MUST have already recorded the approval in
   * an external system (PagerDuty / JIRA) and pass its id here.
   * Writes a CC6.1 evidence row regardless of subsequent use.
   */
  issue(input: {
    requestedBy: string;
    approvalId: string;
    scope: BreakGlassScope;
    tenantId: string;
    ttlMs?: number;
  }): { token: string; jti: string; expiresAtMs: number } {
    if (!input.approvalId || input.approvalId.length < 1) {
      throw new BreakGlassError('NO_APPROVAL_ID', 'break-glass requires an external approval id');
    }
    const ttlMs = input.ttlMs ?? MAX_TTL_MS;
    if (ttlMs > MAX_TTL_MS || ttlMs <= 0) {
      throw new BreakGlassError('TTL_TOO_LONG', `ttlMs must be in (0, ${MAX_TTL_MS}]`);
    }
    const now = Date.now();
    const payload: BreakGlassPayload = {
      jti: `bg_${randomUUID()}`,
      iat: now,
      exp: now + ttlMs,
      requestedBy: input.requestedBy,
      approvalId: input.approvalId,
      scope: input.scope,
      tenantId: input.tenantId,
    };
    const token = this.serialise(payload);
    /* Write evidence at issue time — even if the token is never used,
     * the audit trail records that one was created. */
    try {
      recordEvidence(this.db, {
        tenantId: input.tenantId || 'platform',
        controlId: 'CC6.1',
        evidenceType: 'break_glass_issued',
        payload: {
          jti: payload.jti,
          scope: payload.scope,
          requestedBy: payload.requestedBy,
          approvalId: payload.approvalId,
          expiresAtMs: payload.exp,
        },
        metadata: { collector_id: 'break-glass-service' },
      });
    } catch { /* never block issuance on evidence write */ }
    return { token, jti: payload.jti, expiresAtMs: payload.exp };
  }

  /**
   * Validate + consume a token for the given scope. Throws on any
   * tampering / expiry / scope mismatch / reuse. Writes a CC6.1 evidence
   * row recording the outcome (success or refusal + reason).
   */
  verify(token: string, requiredScope: BreakGlassScope, requestedTenantId: string): BreakGlassPayload {
    this.gc();
    let payload: BreakGlassPayload;
    try {
      payload = this.deserialise(token);
    } catch (err) {
      this.writeUseEvidence(requestedTenantId, 'invalid_format', requiredScope, null);
      throw err instanceof BreakGlassError ? err : new BreakGlassError('INVALID_FORMAT', (err as Error).message);
    }
    const now = Date.now();
    if (now >= payload.exp) {
      this.writeUseEvidence(payload.tenantId, 'expired', requiredScope, payload);
      throw new BreakGlassError('EXPIRED', `break-glass token expired at ${payload.exp}, now=${now}`);
    }
    if (payload.scope !== requiredScope) {
      this.writeUseEvidence(payload.tenantId, 'scope_mismatch', requiredScope, payload);
      throw new BreakGlassError('SCOPE_MISMATCH', `token scope=${payload.scope} but endpoint requires ${requiredScope}`);
    }
    if (payload.tenantId !== requestedTenantId) {
      this.writeUseEvidence(payload.tenantId, 'tenant_mismatch', requiredScope, payload);
      throw new BreakGlassError('TENANT_MISMATCH', `token tenant=${payload.tenantId} but request tenant=${requestedTenantId}`);
    }
    if (this.consumedJtis.has(payload.jti)) {
      this.writeUseEvidence(payload.tenantId, 'already_used', requiredScope, payload);
      throw new BreakGlassError('ALREADY_USED', `break-glass token ${payload.jti} was already consumed`);
    }
    /* Atomic-ish consume — single thread per process, so the
     * read-then-set above is fine. Cross-process needs DB jti table
     * (P1-M v2). */
    this.consumedJtis.set(payload.jti, {
      jti: payload.jti, consumed_at: now, consumed_by: payload.requestedBy,
    });
    this.writeUseEvidence(payload.tenantId, 'consumed', requiredScope, payload);
    return payload;
  }

  private gc(): void {
    const now = Date.now();
    if (now - this.lastGc < 60_000) return;
    this.lastGc = now;
    const cutoff = now - 2 * MAX_TTL_MS;
    for (const [jti, row] of this.consumedJtis) {
      if (row.consumed_at < cutoff) this.consumedJtis.delete(jti);
    }
  }

  private writeUseEvidence(
    tenantId: string,
    outcome: 'consumed' | 'expired' | 'scope_mismatch' | 'tenant_mismatch' | 'already_used' | 'invalid_format',
    requiredScope: BreakGlassScope,
    payload: BreakGlassPayload | null,
  ): void {
    try {
      recordEvidence(this.db, {
        tenantId: tenantId || 'platform',
        controlId: 'CC6.1',
        evidenceType: 'break_glass_use',
        payload: {
          outcome,
          requiredScope,
          jti: payload?.jti ?? null,
          scope: payload?.scope ?? null,
          requestedBy: payload?.requestedBy ?? null,
          approvalId: payload?.approvalId ?? null,
        },
        metadata: { collector_id: 'break-glass-service' },
      });
    } catch { /* never block on evidence */ }
  }

  /**
   * Serialise format: base64url(json).hmac. NOT JWT — break-glass tokens
   * use a different key + non-JWT shape so they can never be confused
   * with normal API tokens at any verify path.
   */
  private serialise(payload: BreakGlassPayload): string {
    const body = Buffer.from(JSON.stringify(payload), 'utf-8').toString('base64url');
    const sig = createHmac('sha256', this.signingKey).update(body).digest('base64url');
    return `${body}.${sig}`;
  }

  private deserialise(token: string): BreakGlassPayload {
    const dot = token.indexOf('.');
    if (dot < 0) throw new BreakGlassError('INVALID_FORMAT', 'missing signature delimiter');
    const body = token.slice(0, dot);
    const sig = token.slice(dot + 1);
    const expected = createHmac('sha256', this.signingKey).update(body).digest('base64url');
    /* timingSafeEqual requires equal-length buffers; mismatched lengths
     * means the token was truncated or padded — treat as tampered. */
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new BreakGlassError('SIGNATURE_INVALID', 'signature mismatch — token may be forged or tampered');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf-8'));
    } catch {
      throw new BreakGlassError('INVALID_FORMAT', 'body is not valid base64-encoded JSON');
    }
    if (!parsed || typeof parsed !== 'object') {
      throw new BreakGlassError('INVALID_FORMAT', 'body is not an object');
    }
    const required = ['jti', 'iat', 'exp', 'requestedBy', 'approvalId', 'scope', 'tenantId'];
    for (const field of required) {
      if (!(field in (parsed as Record<string, unknown>))) {
        throw new BreakGlassError('INVALID_FORMAT', `missing field: ${field}`);
      }
    }
    return parsed as BreakGlassPayload;
  }

  /** Diagnostic: fingerprint of the signing key (not the key itself). */
  signingKeyFingerprint(): string {
    return createHash('sha256').update(this.signingKey).digest('hex').slice(0, 16);
  }
}
