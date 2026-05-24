/**
 * Shared utilities for persona-core sub-services.
 *
 * Extracted from `persona-core-service.ts` as part of the Step 16
 * split. Previously these were file-private functions inside the
 * god-object; the memory-service split needs them too, so they
 * graduated to a module-level export.
 *
 * Why not `src/utils/*`? These are persona-core-specific helpers
 * (memory-sensitivity normalisation, score rounding) that don't
 * generalise. Keeping them adjacent makes the split obvious — a
 * future marketplace-service split can also import from here without
 * a cross-module dependency.
 */

import type { PersonaMemorySensitivity } from './types.js';

/** Parse JSON safely; return `fallback` on any failure so callers
 *  don't have to wrap every `JSON.parse` in try/catch. Used heavily
 *  in row-to-model translation where the underlying column may be
 *  null or malformed in old rows. */
export function safeJsonParse<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

/** Round to `digits` decimal places (default 4). The persona-core
 *  domain uses 4-digit precision throughout (reputation deltas,
 *  growth scores) because that's the granularity SQLite REAL gives
 *  us reliably without floating-point drift. */
export function round(value: number, digits = 4): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** Clamp to inclusive bounds. */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Convert dollar-amount to integer minor units (cents). */
export function toMinor(value: number): number {
  return Math.round(value * 100);
}

/** Convert integer minor units back to a 4-digit rounded dollar. */
export function fromMinor(value: number): number {
  return round(value / 100, 4);
}

/** Narrow an arbitrary input to the PersonaMemorySensitivity enum.
 *  Unknown / null values fall back to `'private'` — the safest
 *  default (no encryption + no ownerRestricted gate). */
export function normalizeMemorySensitivity(value: string | null | undefined): PersonaMemorySensitivity {
  switch (value) {
    case 'encrypted':
    case 'owner-restricted':
      return value;
    case 'private':
    default:
      return 'private';
  }
}
