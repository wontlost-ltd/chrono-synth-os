/**
 * License key verifier with 30-day grace + signed override.
 *
 * Plan: poc-to-enterprise-ga-2026-v7.3.md §4.5 P2-H + §8 #6
 *
 * Threat model:
 *   - On-prem customers run our software in air-gap. We can't reach a
 *     license server, so the license is a signed payload (Ed25519 over
 *     a canonical JSON). The customer's deployment carries our public
 *     key bundled with the image; the license file is rotated on
 *     renewal.
 *   - On license expiry, refusing service immediately is hostile to
 *     customers whose procurement renewal is in flight. Grace period
 *     (30 days default) keeps the system running with a loud warning
 *     while the renewal lands.
 *   - Emergency override: a separately-signed "override token" can
 *     extend the grace period for a specific reason (e.g. legal hold
 *     on the tenant). The override is itself short-lived (≤7d), bound
 *     to one license id, and audited.
 *
 * What this module is NOT:
 *   - Not the signer. Issuance happens at the license server / build
 *     pipeline; this module only verifies.
 *   - Not a DRM enforcement. We don't track per-feature usage here;
 *     that's billing + feature flags. This module answers one question:
 *     "is the install in a paid-up state for the configured plan?"
 */

import { createPublicKey, verify, type KeyObject } from 'node:crypto';

export type LicenseStatus = 'valid' | 'grace' | 'expired' | 'invalid' | 'tampered';

export interface LicensePayload {
  /** Unique license id. */
  id: string;
  /** Customer / tenant the license is scoped to. */
  customerId: string;
  /** Plan name; consult separately for entitlements. */
  plan: string;
  /** Earliest moment the license is valid (ms). */
  notBeforeMs: number;
  /** Moment after which the license is expired unless under grace. */
  expiresAtMs: number;
  /** Grace window in days; defaults to 30 if unset. */
  graceDays?: number;
  /** Feature flags this license unlocks. */
  features?: string[];
}

export interface OverridePayload {
  /** License id this override extends. */
  licenseId: string;
  /** Hard expiry of the override itself; must be ≤ 7d from issuance. */
  expiresAtMs: number;
  /** Audit-readable reason. */
  reason: string;
  /** Authority that approved (ops manager, legal). */
  approvedBy: string;
}

export interface SignedLicense {
  payload: LicensePayload;
  /** Base64url Ed25519 signature over canonical JSON of payload. */
  signature: string;
}

export interface SignedOverride {
  payload: OverridePayload;
  signature: string;
}

export class LicenseError extends Error {
  constructor(readonly code: 'TAMPERED' | 'EXPIRED' | 'BEFORE_NBF' | 'INVALID_FORMAT' | 'BAD_OVERRIDE', message: string) {
    super(message);
    this.name = 'LicenseError';
  }
}

/**
 * Canonical JSON serialisation — keys sorted recursively. The signer
 * MUST use the same algorithm or signatures won't verify. Kept here in
 * sync with src/compliance/evidence-store.ts canonicalJson for
 * consistency across signing surfaces.
 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).sort().map(k => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
}

function verifySignature(payloadJson: string, signatureB64: string, publicKeyPem: string): boolean {
  let pub: KeyObject;
  try { pub = createPublicKey({ key: publicKeyPem, format: 'pem' }); }
  catch { return false; }
  /* Ed25519: third arg of verify must be null (algo lives in the key). */
  return verify(null, Buffer.from(payloadJson, 'utf-8'), pub, Buffer.from(signatureB64, 'base64url'));
}

const MS_PER_DAY = 86_400_000;
const MAX_OVERRIDE_MS = 7 * MS_PER_DAY;

export interface LicenseEvaluation {
  status: LicenseStatus;
  payload: LicensePayload | null;
  /** When status='grace', ms remaining before hard expiry. */
  graceRemainingMs: number;
  /** When an override extended the deadline, the override payload. */
  appliedOverride: OverridePayload | null;
  /** Reason text for logging / UI. */
  reason: string;
}

/**
 * Verify a license + (optional) override against a public key at a
 * given clock time. Returns a structured evaluation that the caller
 * uses to decide whether to admit traffic and what warning UI to
 * show.
 */
export function evaluateLicense(
  signed: SignedLicense,
  publicKeyPem: string,
  options: {
    nowMs?: number;
    override?: SignedOverride;
    /** Defaults to 30; overridable via env or config for tests. */
    defaultGraceDays?: number;
  } = {},
): LicenseEvaluation {
  const nowMs = options.nowMs ?? Date.now();
  const defaultGrace = options.defaultGraceDays ?? 30;

  /* Step 1: signature must verify against the platform public key. */
  const payloadJson = canonicalJson(signed.payload);
  if (!verifySignature(payloadJson, signed.signature, publicKeyPem)) {
    return {
      status: 'tampered',
      payload: null,
      graceRemainingMs: 0,
      appliedOverride: null,
      reason: 'License signature does not verify — file may be tampered or signed by wrong key',
    };
  }

  const { payload } = signed;
  if (nowMs < payload.notBeforeMs) {
    return {
      status: 'invalid',
      payload,
      graceRemainingMs: 0,
      appliedOverride: null,
      reason: `License not yet valid (nbf=${payload.notBeforeMs}, now=${nowMs})`,
    };
  }

  if (nowMs < payload.expiresAtMs) {
    return { status: 'valid', payload, graceRemainingMs: 0, appliedOverride: null, reason: 'License valid' };
  }

  /* Past expiry — check grace + override. */
  const graceMs = (payload.graceDays ?? defaultGrace) * MS_PER_DAY;
  let effectiveDeadline = payload.expiresAtMs + graceMs;
  let appliedOverride: OverridePayload | null = null;

  if (options.override) {
    const overrideJson = canonicalJson(options.override.payload);
    if (verifySignature(overrideJson, options.override.signature, publicKeyPem)
        && options.override.payload.licenseId === payload.id
        && options.override.payload.expiresAtMs > nowMs
        /* Override TTL must not exceed 7d from now — limits blast radius. */
        && options.override.payload.expiresAtMs - nowMs <= MAX_OVERRIDE_MS) {
      effectiveDeadline = Math.max(effectiveDeadline, options.override.payload.expiresAtMs);
      appliedOverride = options.override.payload;
    }
  }

  if (nowMs < effectiveDeadline) {
    return {
      status: 'grace',
      payload,
      graceRemainingMs: effectiveDeadline - nowMs,
      appliedOverride,
      reason: appliedOverride
        ? `License expired but under override "${appliedOverride.reason}" until ${appliedOverride.expiresAtMs}`
        : `License expired ${nowMs - payload.expiresAtMs}ms ago; grace remaining ${effectiveDeadline - nowMs}ms`,
    };
  }

  return {
    status: 'expired',
    payload,
    graceRemainingMs: 0,
    appliedOverride,
    reason: `License + grace + override all expired; service must refuse traffic`,
  };
}
