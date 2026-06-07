/**
 * Feature flag layer (P3.2).
 *
 * Provider-agnostic facade: the application reads
 * `useFeatureFlag('flag.id', defaultValue)` and the implementation
 * decides what to do. Three providers are supported out of the box:
 *
 *  1. **Static** — values baked into runtime config. Default. Useful
 *     for deploy-gate flags ("enable-new-billing-ui").
 *  2. **Local override** — value pulled from localStorage; lets a
 *     developer flip a flag in their browser without redeploy.
 *     Always wins over static when present.
 *  3. **Remote** (planned) — fetched from
 *     `GET /api/v1/admin/feature-flags`; cached for 60s. Wired by
 *     setting `FeatureFlagRegistry.remote = ...` at app bootstrap.
 *
 * Design notes:
 *  - Flags are strongly typed via the `FeatureFlagId` union below.
 *    Adding a flag is one line in this file. We intentionally do not
 *    accept arbitrary strings — typo'd flag names are a common source
 *    of surprise behaviour.
 *  - The hook is synchronous; the registry decides values at module
 *    init. Async fetches (remote provider) update the registry and
 *    notify listeners; the hook re-renders.
 */

import { useEffect, useState } from 'react';

/* Add a new flag here, then it's instantly reachable from useFeatureFlag. */
export type FeatureFlagId =
  | 'cmdk.enabled'
  | 'changelog.drawer.enabled'
  | 'onboarding.checklist.enabled'
  | 'onboarding.aha_moment.enabled'
  | 'analytics.tracking.enabled'
  | 'experimental.values_health_dashboard';

type FlagValue = boolean | string | number;

interface FlagSnapshot {
  values: Map<FeatureFlagId, FlagValue>;
  source: Map<FeatureFlagId, 'static' | 'override' | 'remote'>;
}

/* Provider connectivity state — exposed via `useRemoteFlagStatus` so
 * debug UI / health pages can show whether the SSE link is live. */
export type RemoteFlagStatus = 'idle' | 'connecting' | 'live' | 'stale';
let remoteStatus: RemoteFlagStatus = 'idle';
const statusListeners = new Set<() => void>();

const LOCAL_STORAGE_PREFIX = 'chrono.flag.';

/* Default values are the safe "ship this, let people opt out" stance.
 * Disable a flag here to deploy with it off until a follow-up flip. */
const DEFAULTS: Record<FeatureFlagId, FlagValue> = {
  'cmdk.enabled': true,
  'changelog.drawer.enabled': true,
  'onboarding.checklist.enabled': true,
  'onboarding.aha_moment.enabled': false,
  'analytics.tracking.enabled': true,
  'experimental.values_health_dashboard': false,
};

let snapshot: FlagSnapshot = buildSnapshot();
const listeners = new Set<() => void>();

function readLocalOverride(id: FeatureFlagId): FlagValue | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(LOCAL_STORAGE_PREFIX + id);
    if (raw === null) return null;
    /* localStorage stores strings; coerce to the expected type. */
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    const n = Number(raw);
    if (!Number.isNaN(n) && /^-?\d+(\.\d+)?$/.test(raw)) return n;
    return raw;
  } catch {
    return null;
  }
}

function buildSnapshot(): FlagSnapshot {
  const values = new Map<FeatureFlagId, FlagValue>();
  const source = new Map<FeatureFlagId, 'static' | 'override' | 'remote'>();

  for (const id of Object.keys(DEFAULTS) as FeatureFlagId[]) {
    const override = readLocalOverride(id);
    if (override !== null) {
      values.set(id, override);
      source.set(id, 'override');
    } else {
      values.set(id, DEFAULTS[id]);
      source.set(id, 'static');
    }
  }

  return { values, source };
}

function notify(): void {
  for (const fn of listeners) fn();
}

/** Replace a flag value at runtime (e.g. from a remote provider).
 *  Marks the source as 'remote' so future debug surfaces can surface
 *  which provider won. */
export function setFlagValue(id: FeatureFlagId, value: FlagValue, providerSource: 'remote' = 'remote'): void {
  /* Local override always wins even over remote — explicit dev intent. */
  if (snapshot.source.get(id) === 'override') return;
  snapshot.values.set(id, value);
  snapshot.source.set(id, providerSource);
  notify();
}

export function getFlagValue<T extends FlagValue = boolean>(id: FeatureFlagId, fallback: T): T {
  const v = snapshot.values.get(id);
  return (v === undefined ? fallback : v) as T;
}

export function getFlagSource(id: FeatureFlagId): 'static' | 'override' | 'remote' {
  return snapshot.source.get(id) ?? 'static';
}

/** React hook — re-renders when the flag's value changes. */
export function useFeatureFlag<T extends FlagValue = boolean>(id: FeatureFlagId, fallback: T): T {
  const [value, setValue] = useState(() => getFlagValue(id, fallback));
  useEffect(() => {
    const handler = () => setValue(getFlagValue(id, fallback));
    listeners.add(handler);
    return () => { listeners.delete(handler); };
  }, [id, fallback]);
  return value;
}

/* Test hook — resets the registry to defaults and clears listeners. */
export function _resetFeatureFlagsForTest(): void {
  snapshot = buildSnapshot();
  listeners.clear();
}

/** Re-read overrides from localStorage. Useful when devtools change a
 *  flag and want to refresh without page reload. */
export function refreshFlagsFromStorage(): void {
  snapshot = buildSnapshot();
  notify();
}

/* ── Remote provider connectivity ─────────────────────────────────── */

/** Update remote status + notify subscribers. */
export function _setRemoteStatus(next: RemoteFlagStatus): void {
  if (remoteStatus === next) return;
  remoteStatus = next;
  for (const fn of statusListeners) fn();
}

export function getRemoteStatus(): RemoteFlagStatus {
  return remoteStatus;
}

/** React hook — re-renders when SSE provider state changes. */
export function useRemoteFlagStatus(): RemoteFlagStatus {
  const [s, setS] = useState(remoteStatus);
  useEffect(() => {
    const handler = (): void => setS(remoteStatus);
    statusListeners.add(handler);
    return () => { statusListeners.delete(handler); };
  }, []);
  return s;
}
