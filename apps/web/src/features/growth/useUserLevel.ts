/**
 * useUserLevel — derives the user's capability level from days of use.
 *
 * Days of use are tracked in localStorage (`chrono.user.first-seen`).
 * The very first render seeds the timestamp; every subsequent call
 * computes (now - first-seen) / day.
 *
 * For multi-device parity, the server eventually stores this on the
 * user record; until then localStorage is "good enough" — losing it
 * just resets a user to L1, which is recoverable.
 */

import { useEffect, useState } from 'react';
import { computeLevel, daysUntilNextLevel, isUnlocked, type CapabilityLevel } from './levels';

const STORAGE_KEY = 'chrono.user.first-seen';
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function readFirstSeen(): number {
  if (typeof window === 'undefined') return Date.now();
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = parseInt(raw, 10);
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }
  } catch {
    /* storage unavailable */
  }
  const now = Date.now();
  try {
    window.localStorage.setItem(STORAGE_KEY, String(now));
  } catch {
    /* private mode — ignore */
  }
  return now;
}

interface UserLevelInfo {
  level: CapabilityLevel;
  daysOfUse: number;
  daysUntilNext: number | null;
  hasUnlocked: (feature: string) => boolean;
}

export function useUserLevel(): UserLevelInfo {
  const [firstSeen] = useState<number>(() => readFirstSeen());
  const [now, setNow] = useState<number>(() => Date.now());

  /* Recompute once per minute — capability level shouldn't flip more
   * often than that, and a stale value just delays an unlock by ≤60s. */
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60 * 1000);
    return () => clearInterval(id);
  }, []);

  const daysOfUse = Math.max(0, Math.floor((now - firstSeen) / MS_PER_DAY));
  const level = computeLevel(daysOfUse);
  const daysUntilNext = daysUntilNextLevel(daysOfUse);

  return {
    level,
    daysOfUse,
    daysUntilNext,
    hasUnlocked: (feature: string) => isUnlocked(level, feature),
  };
}
