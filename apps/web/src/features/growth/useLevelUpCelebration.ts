/**
 * useLevelUpCelebration — fires once per level boundary crossing.
 *
 * Watches `useUserLevel().level` and compares to the last-seen level
 * persisted in localStorage. When the live level outranks the stored one,
 * we emit the celebration event exactly once and bump storage.
 *
 * The persistence key is intentionally separate from `chrono.user.first-seen`
 * so wiping celebrations doesn't reset the day counter.
 */

import { useEffect, useState } from 'react';
import type { CapabilityLevel } from './levels';
import { useUserLevel } from './useUserLevel';

const STORAGE_KEY = 'chrono.user.last-celebrated-level';
const RANK: Record<CapabilityLevel, number> = { L1: 0, L2: 1, L3: 2, L4: 3 };

function readLastCelebrated(): CapabilityLevel | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY) as CapabilityLevel | null;
    return raw && raw in RANK ? raw : null;
  } catch {
    return null;
  }
}

function writeLastCelebrated(level: CapabilityLevel): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, level);
  } catch {
    /* private mode — celebration may re-fire next session, acceptable */
  }
}

export interface LevelUpEvent {
  from: CapabilityLevel;
  to: CapabilityLevel;
}

interface UseLevelUpResult {
  /** The most recent unacknowledged level-up, or null. */
  pending: LevelUpEvent | null;
  /** Acknowledge & dismiss the celebration; persists current level. */
  acknowledge: () => void;
}

export function useLevelUpCelebration(): UseLevelUpResult {
  const { level } = useUserLevel();
  const [pending, setPending] = useState<LevelUpEvent | null>(null);

  useEffect(() => {
    /* L1 is the floor. We only celebrate the *first* observation of any
     * level above L1 — the welcome intro covers L1 itself. */
    const lastSeen = readLastCelebrated();
    if (!lastSeen) {
      /* Bootstrap: record the current level so subsequent runs only flag
       * forward transitions. Don't fire a celebration on first visit; the
       * welcome intro handles that. */
      writeLastCelebrated(level);
      return;
    }
    if (RANK[level] > RANK[lastSeen]) {
      setPending({ from: lastSeen, to: level });
    }
  }, [level]);

  const acknowledge = () => {
    if (!pending) return;
    writeLastCelebrated(pending.to);
    setPending(null);
  };

  return { pending, acknowledge };
}

/** Test-only reset. */
export function _resetCelebrationForTest(): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}
