/**
 * JWT deny-list — in-memory FIFO with bounded capacity, for revoked jti.
 *
 * Plan: poc-to-enterprise-ga-2026-v7.3.md §2.2 P0-D + §8 #4
 *
 * Use case: explicit revocation of a specific access token (e.g. user logout,
 * SOC2 incident response). Compromised-key-level revocation is handled by
 * KeyRing.markCompromised(); this list is for token-level revocation that
 * doesn't justify rotating the entire signing key.
 *
 * Eviction policy: FIFO by insertion order — when the map reaches `maxEntries`,
 * the OLDEST inserted entry is dropped. Not strictly LRU; we deliberately
 * don't refresh order on `isDenied()` reads because:
 *   1. A deny entry is "fire and forget" — once a jti is denied it stays
 *      denied until its expiresAtMs; reads should not extend its lifetime.
 *   2. LRU-on-read would let an attacker who keeps probing a denied jti
 *      keep that entry pinned, evicting newer denies. FIFO is more
 *      adversary-resistant.
 *
 * Persistence: in-memory only. Restart clears the deny-list — acceptable
 * because access tokens are short-lived (≤ 15min default; expired tokens
 * are already rejected by `exp`). Refresh-token revocation has its own
 * DB-backed path via the existing `refresh_tokens` table.
 *
 * Bounds: capacity-limited (default 100k entries) so an attacker can't
 * OOM the process by spamming logout. At ~50 bytes/jti this is ~5MB.
 */

export interface JtiDenyList {
  deny(jti: string, expiresAtMs: number): void;
  isDenied(jti: string): boolean;
  size(): number;
  /** Clear expired entries; called automatically on each deny()/isDenied(). */
  prune(now?: number): number;
}

interface Entry {
  expiresAtMs: number;
}

export function createJtiDenyList(maxEntries = 100_000): JtiDenyList {
  /* Map preserves insertion order; we leverage that for LRU eviction. */
  const map = new Map<string, Entry>();

  function prune(now: number = Date.now()): number {
    let removed = 0;
    for (const [jti, e] of map) {
      if (e.expiresAtMs <= now) {
        map.delete(jti);
        removed += 1;
      } else {
        /* Entries are not necessarily in expiry order, so we can't break.
         * For very large lists this could be costly; OK at default capacity. */
      }
    }
    return removed;
  }

  function evictIfFull(): void {
    while (map.size >= maxEntries) {
      const oldest = map.keys().next().value;
      if (oldest === undefined) return;
      map.delete(oldest);
    }
  }

  return {
    deny(jti, expiresAtMs) {
      if (!jti) return;
      const now = Date.now();
      if (expiresAtMs <= now) return;  /* already expired */
      prune(now);
      evictIfFull();
      map.set(jti, { expiresAtMs });
    },
    isDenied(jti) {
      if (!jti) return false;
      const entry = map.get(jti);
      if (!entry) return false;
      if (entry.expiresAtMs <= Date.now()) {
        map.delete(jti);
        return false;
      }
      return true;
    },
    size() {
      return map.size;
    },
    prune,
  };
}
