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
import {
  insertBreakGlassConsumption,
  pruneOldBreakGlassConsumptions,
  toBreakGlassInsertResult,
  toBreakGlassPruneResult,
} from '@chrono/kernel';
import type { IDatabase } from '../storage/database.js';
import { recordEvidence } from '../compliance/evidence-store.js';
import { registerCoreSelfExecutors } from '../storage/executors/index.js';

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
    | 'REPLAY_DETECTED'
    | 'NO_APPROVAL_ID'
    | 'TTL_TOO_LONG',
    message: string,
  ) {
    super(message);
    this.name = 'BreakGlassError';
  }
}

/**
 * DB-backed service — JTI consumption is enforced by the
 * UNIQUE(tenant_id, jti) index on break_glass_jti_consumptions
 * (migration v076). 任何共享同一数据库的实例都会看到一致的"已消费"
 * 视图，所以同一令牌不可能在两个 Pod 上各使用一次。
 *
 * 设计要点：
 *   - 消费 = INSERT ... ON CONFLICT DO NOTHING；rowsAffected===1 视为
 *     首次消费成功，否则视为重放并拒绝；
 *   - tenantId 为空（平台级 break-glass）时，使用 'platform' 作为
 *     分区键，保证唯一索引仍然有效；
 *   - 周期性裁剪由 pruneExpiredCadenced() 每分钟最多触发一次，删除
 *     超出 2× MAX_TTL_MS 的旧消费记录以避免账本无界增长。
 */
export class BreakGlassService {
  /** Periodic-eviction guard: avoid running the prune query every call. */
  private lastGc = Date.now();

  constructor(
    private readonly db: IDatabase,
    /** Signing key for break-glass HMAC; ROTATE on suspected compromise. */
    private readonly signingKey: string,
  ) {
    if (!signingKey || signingKey.length < 32) {
      throw new Error('break-glass signing key must be ≥32 chars');
    }
    /* 注册 break-glass 命令执行器（幂等，重复注册由 registerCoreSelfExecutors 内部跳过） */
    registerCoreSelfExecutors();
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
  verify(
    token: string,
    requiredScope: BreakGlassScope,
    requestedTenantId: string,
    options: { requestIp?: string | null } = {},
  ): BreakGlassPayload {
    this.pruneExpiredCadenced();
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

    /* 原子消费：INSERT ... ON CONFLICT DO NOTHING + 成功路径同事务
     * 写 CC6.1 evidence。两者绑定后即使消费成功、evidence 失败也会
     * 回滚 JTI 插入，确保"消费即审计"的不可分语义。重放分支不需要
     * 包在事务里（无写入）。 */
    const partitionTenant = payload.tenantId || 'platform';
    const consumed = this.db.transaction(() => {
      const insertResult = this.db.execute(insertBreakGlassConsumption({
        id: randomUUID(),
        tenantId: partitionTenant,
        jti: payload.jti,
        scope: payload.scope,
        consumedAt: new Date(now).toISOString(),
        consumedBy: payload.requestedBy || null,
        requestIp: options.requestIp ?? null,
        auditSeq: null,
      }));
      const ok = toBreakGlassInsertResult(insertResult.rowsAffected).inserted;
      if (ok) {
        /* recordEvidence 抛错时事务回滚，JTI 不被消费 — 保护审计不可缺失。 */
        this.recordUseEvidenceOrThrow(payload.tenantId, 'consumed', requiredScope, payload);
      }
      return ok;
    });

    if (!consumed) {
      /* 重放：DB 已记录原始消费 + audit row；此次只写本次拒绝的证据。
       * 这里允许 best-effort（evidence 失败时不抛），与历史拒绝行为一致。 */
      this.writeUseEvidence(payload.tenantId, 'replay_detected', requiredScope, payload);
      throw new BreakGlassError('REPLAY_DETECTED', `break-glass token ${payload.jti} was already consumed`);
    }
    return payload;
  }

  /**
   * 与 writeUseEvidence 不同：本函数抛异常以便上层事务回滚。
   * 仅在"成功消费"路径调用 —— 让 evidence 写入成为不可缺失的副作用。
   */
  private recordUseEvidenceOrThrow(
    tenantId: string,
    outcome: 'consumed',
    requiredScope: BreakGlassScope,
    payload: BreakGlassPayload,
  ): void {
    recordEvidence(this.db, {
      tenantId: tenantId || 'platform',
      controlId: 'CC6.1',
      evidenceType: 'break_glass_use',
      payload: {
        outcome,
        requiredScope,
        jti: payload.jti,
        scope: payload.scope,
        requestedBy: payload.requestedBy,
        approvalId: payload.approvalId,
      },
      metadata: { collector_id: 'break-glass-service' },
    });
  }

  /** 清理 2× MAX_TTL 之前的旧消费记录，避免账本无界增长。返回删除行数。 */
  pruneExpired(now = Date.now()): number {
    const cutoff = new Date(now - 2 * MAX_TTL_MS);
    const result = this.db.execute(pruneOldBreakGlassConsumptions(cutoff));
    return toBreakGlassPruneResult(result.rowsAffected).rows;
  }

  private pruneExpiredCadenced(): void {
    const now = Date.now();
    if (now - this.lastGc < 60_000) return;
    this.lastGc = now;
    try {
      this.pruneExpired(now);
    } catch { /* 裁剪失败不应阻塞 verify；下次再试 */ }
  }

  private writeUseEvidence(
    tenantId: string,
    outcome: 'consumed' | 'expired' | 'scope_mismatch' | 'tenant_mismatch' | 'replay_detected' | 'invalid_format',
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
