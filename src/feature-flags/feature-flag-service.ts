/**
 * FeatureFlagService — declarative rollout + per-tenant overrides +
 * kill switch for safe change management.
 *
 * Plan: poc-to-enterprise-ga-2026-v7.3.md §3.6 P1-O
 *
 * Design:
 *   - Flag definitions live in code (this file) — declarative type-checked.
 *     Adding a flag requires a code change + review; this is intentional.
 *   - Runtime state (enabled / rolloutPercent / killed) lives in the
 *     in-memory store + can be hot-patched via the FlagController API
 *     without restart. Background workers see the change on their next
 *     decision call.
 *   - Per-tenant override: explicit allow/deny list always wins over
 *     percentage rollout (incident response: "kill for tenant X NOW
 *     while we investigate").
 *   - Stable per-tenant bucketing: hash(flag + tenantId) % 100 maps to
 *     a deterministic bucket. The same tenant gets the same answer
 *     every time at a given rollout percent — no flapping.
 *   - Kill switch: a single `killed=true` on a flag makes it return
 *     false for every caller, overriding overrides AND rollout. This is
 *     the load-bearing incident response control.
 */

import { createHash } from 'node:crypto';

/**
 * Add new flags here. Each flag is type-safe; callers can only ask
 * about declared keys. Description doubles as the audit-facing
 * documentation.
 */
export const FEATURE_FLAGS = {
  'agent.long-context-mode': {
    description: 'Enable 128k-context LLM path for premium tenants',
    defaultEnabled: false,
  },
  'billing.usage-export-v2': {
    description: 'New monthly usage export format with cost breakdowns',
    defaultEnabled: false,
  },
  'memory.semantic-pruning': {
    description: 'Aggressive low-salience memory pruning during compaction',
    defaultEnabled: true,
  },
  'audit.kms-sign-chain-tail': {
    description: 'Sign audit chain tail with KMS every 60s (P0-E v2)',
    defaultEnabled: false,
  },
  'onboarding.synthetic-invocations': {
    description: 'Inject 3 synthetic tool invocations during onboarding step 4',
    defaultEnabled: true,
  },
} as const;

export type FlagKey = keyof typeof FEATURE_FLAGS;

interface FlagState {
  enabled: boolean;
  rolloutPercent: number;     /* 0..100; only relevant when enabled */
  killed: boolean;            /* overrides everything; for incident response */
  tenantAllowlist: Set<string>;
  tenantDenylist: Set<string>;
}

export interface FlagDecision {
  /** Final boolean: should the feature be active for this tenant? */
  enabled: boolean;
  /** Why the decision was reached — for audit logs / debugging. */
  reason: 'killed' | 'denylist' | 'allowlist' | 'rollout-in' | 'rollout-out' | 'disabled' | 'default';
}

/**
 * Bucket a tenant into 0..99 deterministically. Same tenant always
 * lands in the same bucket for a given flag — no flapping when polling.
 */
function bucket(flag: FlagKey, tenantId: string): number {
  const h = createHash('sha256').update(`${flag}:${tenantId}`).digest();
  /* Take the first 4 bytes as uint32 → mod 100 */
  const n = (h.readUInt32BE(0)) >>> 0;
  return n % 100;
}

export class FeatureFlagService {
  private readonly state = new Map<FlagKey, FlagState>();

  constructor() {
    /* Initialise every declared flag with its default-enabled state +
     * empty overrides. Callers can later flip via mutators below. */
    for (const key of Object.keys(FEATURE_FLAGS) as FlagKey[]) {
      this.state.set(key, {
        enabled: FEATURE_FLAGS[key].defaultEnabled,
        rolloutPercent: FEATURE_FLAGS[key].defaultEnabled ? 100 : 0,
        killed: false,
        tenantAllowlist: new Set(),
        tenantDenylist: new Set(),
      });
    }
  }

  /**
   * The hot path — called millions of times. Pure decision, no I/O.
   * `tenantId === null` means "platform-wide" — use only the flag's
   * global state, no per-tenant overrides.
   */
  isEnabled(flag: FlagKey, tenantId: string | null): FlagDecision {
    const s = this.state.get(flag);
    if (!s) return { enabled: false, reason: 'default' };
    if (s.killed) return { enabled: false, reason: 'killed' };
    if (tenantId !== null) {
      if (s.tenantDenylist.has(tenantId)) return { enabled: false, reason: 'denylist' };
      if (s.tenantAllowlist.has(tenantId)) return { enabled: true, reason: 'allowlist' };
    }
    if (!s.enabled) return { enabled: false, reason: 'disabled' };
    if (s.rolloutPercent >= 100) return { enabled: true, reason: 'rollout-in' };
    if (s.rolloutPercent <= 0) return { enabled: false, reason: 'rollout-out' };
    if (tenantId === null) {
      /* No tenant context + partial rollout → conservative: off. */
      return { enabled: false, reason: 'rollout-out' };
    }
    const bk = bucket(flag, tenantId);
    return bk < s.rolloutPercent
      ? { enabled: true, reason: 'rollout-in' }
      : { enabled: false, reason: 'rollout-out' };
  }

  /* ── Mutators (admin-controlled; not on the hot path) ── */

  setEnabled(flag: FlagKey, enabled: boolean): void {
    this.state.get(flag)!.enabled = enabled;
  }

  setRolloutPercent(flag: FlagKey, percent: number): void {
    if (percent < 0 || percent > 100 || !Number.isFinite(percent)) {
      throw new Error(`rolloutPercent must be in [0, 100]; got ${percent}`);
    }
    this.state.get(flag)!.rolloutPercent = Math.round(percent);
  }

  /**
   * Kill switch — the load-bearing incident response control. Once
   * killed, no tenant gets the feature regardless of overrides. Survives
   * across restarts via the admin endpoint that flips it.
   */
  kill(flag: FlagKey): void {
    this.state.get(flag)!.killed = true;
  }

  /** Undo the kill switch (e.g. after fixing the upstream issue). */
  revive(flag: FlagKey): void {
    this.state.get(flag)!.killed = false;
  }

  allowTenant(flag: FlagKey, tenantId: string): void {
    const s = this.state.get(flag)!;
    s.tenantAllowlist.add(tenantId);
    s.tenantDenylist.delete(tenantId);
  }

  denyTenant(flag: FlagKey, tenantId: string): void {
    const s = this.state.get(flag)!;
    s.tenantDenylist.add(tenantId);
    s.tenantAllowlist.delete(tenantId);
  }

  /** Diagnostic for admin dashboards. */
  snapshot(flag: FlagKey): {
    enabled: boolean; rolloutPercent: number; killed: boolean;
    allowlistCount: number; denylistCount: number;
  } {
    const s = this.state.get(flag)!;
    return {
      enabled: s.enabled,
      rolloutPercent: s.rolloutPercent,
      killed: s.killed,
      allowlistCount: s.tenantAllowlist.size,
      denylistCount: s.tenantDenylist.size,
    };
  }

  snapshotAll(): Array<{ flag: FlagKey } & ReturnType<FeatureFlagService['snapshot']>> {
    return (Object.keys(FEATURE_FLAGS) as FlagKey[]).map(flag => ({
      flag,
      ...this.snapshot(flag),
    }));
  }
}
