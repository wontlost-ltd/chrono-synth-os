/**
 * Analytics shim — buffered, fire-and-forget event tracking.
 *
 * Events are queued in memory and flushed on:
 *  - reaching the batch threshold (BATCH_SIZE)
 *  - the document going to background (visibilitychange = hidden)
 *  - explicit flush()
 *
 * The transport is currently a console.debug log + a placeholder POST that
 * the backend route in P1.7.2's plan (POST /api/v1/analytics/events) will
 * accept once it lands. Until then, missing-route 4xx is swallowed silently —
 * we never want a telemetry failure to break the user flow.
 *
 * Event naming convention (lowercase + dot-separated, mirrors OTel-ish):
 *   onboarding.step.viewed
 *   onboarding.step.completed
 *   feature.first_use.<feature_id>
 *   empty_state.cta.clicked
 */

export interface AnalyticsEvent {
  name: string;
  /** Captured in payload; PII-free strings only. Numbers and booleans OK. */
  properties?: Record<string, string | number | boolean | null>;
  /** Captured automatically; callers don't need to set */
  ts?: number;
}

const BATCH_SIZE = 20;
const FLUSH_ENDPOINT = '/api/v1/analytics/events';

const queue: AnalyticsEvent[] = [];
let flushScheduled = false;

function nowMs(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? Date.now()
    : Date.now();
}

function scheduleFlush(): void {
  if (flushScheduled) return;
  flushScheduled = true;
  /* setTimeout 0 batches events fired in the same tick into one POST. */
  setTimeout(() => {
    flushScheduled = false;
    void flush();
  }, 0);
}

export function track(name: string, properties?: AnalyticsEvent['properties']): void {
  queue.push({ name, properties, ts: nowMs() });
  if (import.meta.env.DEV) {
    /* eslint-disable-next-line no-console */
    console.debug('[analytics]', name, properties ?? {});
  }
  if (queue.length >= BATCH_SIZE) {
    void flush();
  } else {
    scheduleFlush();
  }
}

export async function flush(): Promise<void> {
  if (queue.length === 0) return;
  const batch = queue.splice(0, queue.length);

  /* Resolve the bearer dynamically — avoids importing session module here
   * (analytics is imported eagerly; session must stay tree-shakeable). The
   * dynamic import is awaited only when we actually have events to flush. */
  let auth: Record<string, string> = {};
  try {
    const session = (await import('../store/session')).getSession();
    if (session.accessToken) auth = { Authorization: `Bearer ${session.accessToken}` };
  } catch { /* session module not available — fire anonymously */ }

  /* Use sendBeacon when the document is unloading — guaranteed delivery
   * even if the page is being torn down. Fall back to fetch otherwise.
   * sendBeacon cannot carry custom headers, so unauthenticated beacon
   * pings will 401; that's acceptable lossy telemetry on unload. */
  if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function' && document.visibilityState === 'hidden') {
    const ok = navigator.sendBeacon(
      FLUSH_ENDPOINT,
      new Blob([JSON.stringify({ events: batch })], { type: 'application/json' }),
    );
    if (ok) return;
  }

  try {
    const res = await fetch(FLUSH_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...auth },
      body: JSON.stringify({ events: batch }),
      credentials: 'include',
      keepalive: true,
    });
    /* 401/404 = telemetry route absent or session not yet established.
     * Either is a no-op from the user's perspective; do not log. */
    if (!res.ok && res.status !== 401 && res.status !== 404) {
      /* unexpected status — drop silently per the "telemetry must never break flow" rule */
    }
  } catch {
    /* Network gone — drop batch */
  }
}

let lifecycleAttached = false;

/** Idempotent — call once near app bootstrap. Sets up flush-on-hide. */
export function initAnalytics(): void {
  if (lifecycleAttached || typeof document === 'undefined') return;
  lifecycleAttached = true;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      void flush();
    }
  });
  window.addEventListener('pagehide', () => {
    void flush();
  });
}

/* Test hook — exported only for vitest, not intended for application use. */
export function _resetAnalyticsForTest(): void {
  queue.length = 0;
  flushScheduled = false;
  lifecycleAttached = false;
}
