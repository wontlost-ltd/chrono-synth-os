/**
 * Remote feature-flag provider (Step 10).
 *
 * Wires the static flag registry (`./featureFlags`) to the OS-side
 * SSE + bootstrap API at /api/v1/feature-flags. Call
 * `bootstrapFeatureFlagsRemote()` once at app start (next to
 * `bootstrapTheme()` in main.tsx) and the rest takes care of itself:
 *
 *   1. GET /api/v1/feature-flags/bootstrap → seed values into the
 *      registry under source='remote'. Local-storage overrides keep
 *      winning (intentional — dev intent always overrides backend).
 *   2. Open EventSource('/api/v1/feature-flags/stream'). On
 *      'snapshot' or 'change' events, push new values via
 *      setFlagValue.
 *   3. On 'error', mark provider stale via _setRemoteStatus('stale')
 *      and let the browser's EventSource native exponential backoff
 *      reconnect. Stale flags keep their last known values — we
 *      explicitly do not revert to defaults during a network blip.
 *
 * Design notes:
 *   - We do NOT throw on bootstrap failure. A backend that's slow to
 *     come up should not block the SPA from rendering. The user just
 *     sees default values until the SSE link comes online.
 *   - We do NOT use TanStack Query here even though the codebase
 *     uses it for normal data: the flag registry is intentionally
 *     module-singleton (synchronous reads from any component without
 *     a context boundary), and adding a query around it would
 *     introduce a useless render layer.
 *   - The provider only knows flag IDs the OS chose to send. Any
 *     local `FeatureFlagId` the OS doesn't recognise (e.g. a
 *     just-added flag still rolling out) keeps its static default.
 */

import {
  setFlagValue,
  _setRemoteStatus,
  type FeatureFlagId,
} from './featureFlags';
import { API_BASE_URL } from '../config';

type FlagValue = boolean | string | number;

interface BootstrapEntry {
  flag: string;
  value: FlagValue;
  source: 'remote';
}

interface ChangeEntry {
  flag: string;
  value: FlagValue;
}

/** Apply one OS-side entry to the local registry, narrowing the flag id.
 *  The cast is forward-compat insurance: an OS deploy that introduces
 *  a new web.* flag before the web rebuilds will land in the snapshot
 *  via setFlagValue. Callers reading through `useFeatureFlag` won't
 *  see it (the FeatureFlagId union doesn't include it), but the
 *  registry tolerates the extra entry. */
function applyEntry(entry: { flag: string; value: FlagValue }): void {
  setFlagValue(entry.flag as FeatureFlagId, entry.value);
}

/* Track the active EventSource so HMR / tests can tear it down. */
let activeStream: EventSource | null = null;

async function fetchBootstrap(signal: AbortSignal): Promise<void> {
  const res = await fetch(`${API_BASE_URL}/api/v1/feature-flags/bootstrap`, {
    credentials: 'include',
    signal,
  });
  if (!res.ok) {
    /* Don't throw — log and let the SSE link be the source of truth
     * once it comes up. A 401 here usually means the user hasn't
     * logged in yet; flags will start working after auth. */
    console.warn(`[feature-flags] bootstrap failed: HTTP ${res.status}`);
    return;
  }
  const body = (await res.json()) as { flags: BootstrapEntry[] };
  if (!Array.isArray(body?.flags)) return;
  for (const entry of body.flags) {
    applyEntry(entry);
  }
}

function openStream(): EventSource {
  /* EventSource is the standardised browser SSE client. It handles
   * exponential backoff reconnects natively — we just need to update
   * status on connect / error to let the UI know. */
  const es = new EventSource(`${API_BASE_URL}/api/v1/feature-flags/stream`, {
    withCredentials: true,
  });

  es.addEventListener('open', () => {
    _setRemoteStatus('live');
  });

  es.addEventListener('snapshot', (ev: MessageEvent) => {
    try {
      const data = JSON.parse(ev.data) as { flags: BootstrapEntry[] };
      for (const entry of data.flags ?? []) applyEntry(entry);
    } catch (err) {
      console.warn('[feature-flags] bad snapshot payload', err);
    }
  });

  es.addEventListener('change', (ev: MessageEvent) => {
    try {
      const entry = JSON.parse(ev.data) as ChangeEntry;
      applyEntry(entry);
    } catch (err) {
      console.warn('[feature-flags] bad change payload', err);
    }
  });

  /* EventSource error fires both on connection failure AND on the
   * browser-side reconnect grace period. We treat all of them as
   * 'stale' — values keep their last known state, status surfaces
   * the degraded condition to anyone subscribed via useRemoteFlagStatus. */
  es.addEventListener('error', () => {
    _setRemoteStatus('stale');
  });

  return es;
}

/**
 * Wire up the remote provider. Idempotent — calling more than once
 * (e.g. during HMR) closes the previous stream first.
 *
 * Returns a teardown function (chiefly for tests).
 *
 * The teardown closes the stream THIS call opened, not whatever the
 * module-level activeStream points at right now. Without this
 * instance-scoping, an old teardown captured during HMR could close
 * the freshly-opened stream from the subsequent bootstrap call.
 */
export function bootstrapFeatureFlagsRemote(): () => void {
  /* SSR / non-browser bail. */
  if (typeof window === 'undefined' || typeof EventSource === 'undefined') {
    return () => {};
  }

  /* HMR safety: close the previous stream. */
  if (activeStream) {
    activeStream.close();
    activeStream = null;
  }

  _setRemoteStatus('connecting');

  const ac = new AbortController();
  /* Fire bootstrap + stream in parallel. The stream's 'snapshot'
   * event will overwrite anything bootstrap set if they race —
   * stream is the more recent source of truth. */
  fetchBootstrap(ac.signal).catch((err) => {
    if (err.name !== 'AbortError') {
      console.warn('[feature-flags] bootstrap error', err);
    }
  });

  const localStream = openStream();
  activeStream = localStream;

  return () => {
    ac.abort();
    localStream.close();
    /* Only clear module-level reference if it still points at us;
     * otherwise a newer bootstrap has already taken over. */
    if (activeStream === localStream) {
      activeStream = null;
      _setRemoteStatus('idle');
    }
  };
}
