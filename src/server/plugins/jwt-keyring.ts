/**
 * JWT KeyRing — multi-kid key lifecycle state machine (P0-D #1).
 *
 * Plan: poc-to-enterprise-ga-2026-v7.3.md §2.2 P0-D + §8 #4
 *
 * 4 states per key:
 *   active      — sign new tokens; verify; published in JWKS
 *   grace       — verify-only (rollover window); published in JWKS; no new sign
 *   retired     — verifies nothing; not in JWKS
 *   compromised — instant deny-list; identical to retired but explicit
 *
 * Invariants:
 *   - exactly ONE active key at any time
 *   - signing always picks the active key
 *   - verifying selects by `kid`; falls back to single legacy key if no kid
 *
 * Runtime mutability: rotate() updates state in-memory; persistence is
 * deferred to P1-M (DB-backed key store + break-glass admin).
 */

import { createHash, createPublicKey, type KeyObject } from 'node:crypto';

export type JwtKeyState = 'active' | 'grace' | 'retired' | 'compromised';
export type JwtAlgorithm = 'HS256' | 'HS384' | 'HS512' | 'RS256' | 'ES256';

export interface JwtKeyEntry {
  kid: string;
  state: JwtKeyState;
  algorithm: JwtAlgorithm;
  privateKey: string;  /* PEM; empty for non-active or symmetric */
  publicKey: string;   /* PEM; empty for symmetric */
  secret: string;      /* shared secret; empty for asymmetric */
}

export interface KeyRingSnapshot {
  active: JwtKeyEntry;
  graceKeys: JwtKeyEntry[];
  retiredKids: string[];
  compromisedKids: string[];
}

/**
 * Resolve a stable kid from key material when caller didn't provide one.
 * Asymmetric: canonical SPKI DER hash (rotation-stable across PEM whitespace).
 * Symmetric: hash of `${issuer}-${secret-length}` (no secret leakage).
 */
export function deriveKid(entry: { algorithm: JwtAlgorithm; publicKey: string; secret: string }, issuer: string): string {
  const isAsymmetric = entry.algorithm.startsWith('RS') || entry.algorithm.startsWith('ES');
  if (isAsymmetric && entry.publicKey) {
    try {
      const der = createPublicKey({ key: entry.publicKey, format: 'pem' }).export({ type: 'spki', format: 'der' });
      return createHash('sha256').update(der as Buffer).digest('hex').slice(0, 16);
    } catch {
      return createHash('sha256').update(entry.publicKey).digest('hex').slice(0, 16);
    }
  }
  const seed = `${issuer}-${entry.secret.length}`;
  return createHash('sha256').update(seed).digest('hex').slice(0, 16);
}

/** Throws on construction if invariants violated. */
export class KeyRing {
  private keys: Map<string, JwtKeyEntry>;
  private activeKidValue: string;

  constructor(entries: JwtKeyEntry[]) {
    this.keys = new Map();
    for (const e of entries) {
      if (this.keys.has(e.kid)) {
        throw new Error(`KeyRing: duplicate kid "${e.kid}"`);
      }
      this.keys.set(e.kid, { ...e });
    }
    const active = entries.filter(e => e.state === 'active');
    if (active.length !== 1) {
      throw new Error(`KeyRing: exactly 1 active key required, got ${active.length}`);
    }
    this.activeKidValue = active[0]!.kid;
  }

  /** Active kid (the only one allowed to sign new tokens). */
  activeKid(): string {
    return this.activeKidValue;
  }

  /** Look up entry by kid. Returns undefined for unknown kids. */
  get(kid: string): JwtKeyEntry | undefined {
    return this.keys.get(kid);
  }

  /** Return the entry suitable for *signing* (always the active key). */
  signEntry(): JwtKeyEntry {
    const e = this.keys.get(this.activeKidValue);
    if (!e) throw new Error('KeyRing: active key vanished — internal invariant violated');
    return e;
  }

  /**
   * Return the entry suitable for *verifying* a token with the given kid.
   * Returns undefined if:
   *   - kid is unknown
   *   - kid is retired or compromised (verification must fail)
   * Active and grace states both verify.
   */
  verifyEntry(kid: string | undefined): JwtKeyEntry | undefined {
    if (!kid) return undefined;
    const e = this.keys.get(kid);
    if (!e) return undefined;
    if (e.state === 'retired' || e.state === 'compromised') return undefined;
    return e;
  }

  /** All entries currently published in JWKS (active + grace). */
  publishedEntries(): JwtKeyEntry[] {
    return Array.from(this.keys.values()).filter(e => e.state === 'active' || e.state === 'grace');
  }

  /** All entries; useful for /admin/keys diagnostics and tests. */
  allEntries(): JwtKeyEntry[] {
    return Array.from(this.keys.values()).map(e => ({ ...e }));
  }

  /**
   * Rotate keys.
   *
   * @param newActive   - new key to mark as active (must already exist OR be in addNew)
   * @param oldActiveNewState - what to do with the previously active key (default 'grace')
   * @param addNew      - new keys to insert (optional). The newActive kid may be one of these.
   *
   * Guarantees: exactly 1 active afterwards; previous active transitions to oldActiveNewState.
   */
  rotate(opts: {
    newActiveKid: string;
    oldActiveNewState?: JwtKeyState;
    addNew?: JwtKeyEntry[];
  }): void {
    const oldActiveNewState: JwtKeyState = opts.oldActiveNewState ?? 'grace';

    /* Atomic rotate: validate against a CLONED key map; only commit on success.
     * Without this, errors after partial mutation (e.g. one addNew already
     * inserted before newActiveKid is rejected) would leave the ring in
     * inconsistent state. */
    const cloned = new Map<string, JwtKeyEntry>();
    for (const [k, v] of this.keys) cloned.set(k, { ...v });

    if (opts.addNew) {
      for (const n of opts.addNew) {
        if (cloned.has(n.kid)) {
          throw new Error(`KeyRing.rotate: kid "${n.kid}" already exists`);
        }
        cloned.set(n.kid, { ...n });
      }
    }

    const newActive = cloned.get(opts.newActiveKid);
    if (!newActive) {
      throw new Error(`KeyRing.rotate: unknown kid "${opts.newActiveKid}"`);
    }
    if (newActive.state !== 'active' && newActive.state !== 'grace') {
      throw new Error(`KeyRing.rotate: kid "${opts.newActiveKid}" cannot become active from state ${newActive.state}`);
    }

    /* Transition old active. */
    const oldActive = cloned.get(this.activeKidValue);
    if (oldActive && oldActive.kid !== opts.newActiveKid) {
      oldActive.state = oldActiveNewState;
    }

    /* Promote new active. */
    newActive.state = 'active';

    /* Post-condition: exactly one active in the cloned map. */
    const activeCount = Array.from(cloned.values()).filter(e => e.state === 'active').length;
    if (activeCount !== 1) {
      throw new Error(`KeyRing.rotate: post-condition violated — ${activeCount} active keys after rotate`);
    }

    /* Commit. */
    this.keys = cloned;
    this.activeKidValue = newActive.kid;
  }

  /**
   * Mark a kid as compromised. Instant revocation: verification stops
   * accepting tokens with this kid.
   *
   * If the compromised kid was the active key, the caller MUST first rotate
   * to a new active key (otherwise no key can sign). This guards against
   * accidental self-destruction.
   */
  markCompromised(kid: string): void {
    const e = this.keys.get(kid);
    if (!e) throw new Error(`KeyRing.markCompromised: unknown kid "${kid}"`);
    if (e.kid === this.activeKidValue) {
      throw new Error(`KeyRing.markCompromised: refusing to compromise the active key "${kid}" — rotate first`);
    }
    e.state = 'compromised';
  }

  /** Convenience: derive a snapshot view (for diagnostics / logs / tests). */
  snapshot(): KeyRingSnapshot {
    const all = Array.from(this.keys.values());
    return {
      active: all.find(e => e.state === 'active')!,
      graceKeys: all.filter(e => e.state === 'grace'),
      retiredKids: all.filter(e => e.state === 'retired').map(e => e.kid),
      compromisedKids: all.filter(e => e.state === 'compromised').map(e => e.kid),
    };
  }
}

/** Build a `KeyObject` for asymmetric verify keys. Throws on bad PEM. */
export function buildVerifyKeyObject(entry: JwtKeyEntry): KeyObject | string {
  const isAsym = entry.algorithm.startsWith('RS') || entry.algorithm.startsWith('ES');
  if (isAsym) {
    return createPublicKey({ key: entry.publicKey, format: 'pem' });
  }
  return entry.secret;
}

/** Build a key shape suitable for @fastify/jwt's signer (KeyLike or string). */
export function buildSignKeyObject(entry: JwtKeyEntry): string {
  /* fast-jwt accepts PEM string directly for asymmetric, or a shared secret string. */
  const isAsym = entry.algorithm.startsWith('RS') || entry.algorithm.startsWith('ES');
  if (isAsym) {
    if (!entry.privateKey) {
      throw new Error(`KeyRing.buildSignKeyObject: kid "${entry.kid}" has no privateKey`);
    }
    return entry.privateKey;
  }
  return entry.secret;
}
