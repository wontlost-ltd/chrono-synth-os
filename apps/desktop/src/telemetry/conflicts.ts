/**
 * Conflict-resolution telemetry.
 *
 * Emits one event per user interaction with the conflict inbox UI.
 * Event shape mirrors `chrono-synth-os/src/sync/conflict-scenario-harness.ts`
 * so the P3-E within-subjects study can ingest desktop-emitted events
 * alongside the synthetic harness output.
 *
 * STRICT PII RULE:
 *   - We emit `entityType` (one of 5 enum values) but NEVER `entityId`,
 *     `tenantId`, `conflictId`, or any free-form text. `conflictId` is
 *     a UUID — by itself not PII, but combined with the user's tenant
 *     it can trace back to specific persona/memory rows. Belt-and-
 *     braces: keep the surface minimal.
 *   - `action` is from the closed enum of 4 — non-identifying.
 *   - `durationMs` is the only continuous field; useful for the SEQ
 *     time-on-task metric (Layer 1 P90 ≤2min).
 *   - `outcome` is success / version_conflict / network_error /
 *     validation_error — categorical, non-identifying.
 *
 * Where the data goes:
 *   - In production: posted to the configured analytics endpoint via
 *     the existing chrono-synth-os /api/v1/analytics/events route (TBD
 *     once analytics shipping is wired desktop-side).
 *   - In tests / dev: caller can install a sink via `setTelemetrySink`
 *     to capture events synchronously. The default sink is a no-op so
 *     production calls don't accidentally block on a missing endpoint.
 */

export type ConflictTelemetryEvent =
  | {
      kind: 'conflict.view';
      entityType: 'persona' | 'memory' | 'task' | 'device' | 'policy';
      severity: 'blocking' | 'warning';
    }
  | {
      kind: 'conflict.resolve.attempt';
      entityType: 'persona' | 'memory' | 'task' | 'device' | 'policy';
      action: 'keep_local' | 'keep_server' | 'duplicate' | 'merge_manually';
    }
  | {
      kind: 'conflict.resolve.complete';
      entityType: 'persona' | 'memory' | 'task' | 'device' | 'policy';
      action: 'keep_local' | 'keep_server' | 'duplicate' | 'merge_manually';
      outcome: 'success' | 'version_conflict' | 'network_error' | 'validation_error';
      durationMs: number;
    };

export type TelemetrySink = (event: ConflictTelemetryEvent) => void;

let sink: TelemetrySink = () => {};

/** Replace the global sink. Tests install a recording sink here; the
 *  production sink (TBD) replaces it from main.tsx bootstrap. */
export function setTelemetrySink(next: TelemetrySink): void {
  sink = next;
}

/** Reset to no-op — used by tests in afterEach to avoid leaking sinks
 *  between cases. */
export function _resetTelemetrySinkForTest(): void {
  sink = () => {};
}

export function emitConflictTelemetry(event: ConflictTelemetryEvent): void {
  /* Defensive: never let a thrown sink crash the UI. Telemetry must
   * fail open. */
  try {
    sink(event);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[telemetry] sink error', err);
  }
}
