/**
 * IncidentNotifier — uniform dispatch for incident events to one or
 * more sinks (Slack / Email / PagerDuty / status page).
 *
 * Plan: poc-to-enterprise-ga-2026-v7.3.md §3.7 P1-P
 *
 * Design choices:
 *   - Sinks are pluggable: caller passes a list of NotificationSink
 *     implementations. v1 ships a stdout sink for local dev + a generic
 *     webhook sink. Slack/PagerDuty land as `WebhookSink` configurations.
 *   - Sink failures are isolated: one broken Slack webhook can't block
 *     PagerDuty paging. Each sink's send is wrapped; failures land in
 *     the dispatch report.
 *   - Every dispatch writes a CC7.4 (system operations — incident
 *     response) evidence row regardless of sink outcome, so SOC2
 *     auditors see the incident even if every sink failed.
 *   - No retry logic in v1 — sinks that need retries (PagerDuty)
 *     handle them internally. Retrying notification from the app
 *     introduces ordering surprises that complicate incident timeline
 *     reconstruction.
 */

import type { SyncWriteUnitOfWork } from '@chrono/kernel';
import { recordEvidence } from '../compliance/evidence-store.js';

export type IncidentSeverity = 'critical' | 'warning' | 'info';

export interface IncidentEvent {
  /** Tenant scope; 'platform' for cross-tenant events (e.g. region outage). */
  tenantId: string;
  /** Stable id — used for dedup across sinks; recommended `inc_<uuid>`. */
  incidentId: string;
  severity: IncidentSeverity;
  /** Short summary suitable for Slack title / PagerDuty incident name. */
  title: string;
  /** Longer description; markdown OK on most sinks. */
  description: string;
  /** Optional structured context (alert metric values, trace ids, etc.). */
  context?: Record<string, unknown>;
}

export interface NotificationSink {
  readonly name: string;
  send(event: IncidentEvent): Promise<void>;
}

export interface DispatchReport {
  incidentId: string;
  sinks: Array<{ name: string; ok: boolean; error?: string }>;
}

/**
 * Simple stdout sink for local development + tests. Emits a structured
 * JSON line that the existing pino logger can pick up.
 */
export class StdoutSink implements NotificationSink {
  readonly name = 'stdout';
  async send(event: IncidentEvent): Promise<void> {
    /* Print as a single JSON line so log aggregators can index it. */
    process.stdout.write(JSON.stringify({ ...event, sink: this.name, at: Date.now() }) + '\n');
  }
}

/**
 * Generic webhook sink — POSTs the event as JSON. Caller configures
 * Slack / Discord / custom incident-management endpoints via this one
 * class. PagerDuty uses its own Events API shape; configure a
 * dedicated sink subclass when wiring that in (out of P1-P scope).
 */
export class WebhookSink implements NotificationSink {
  constructor(
    readonly name: string,
    private readonly url: string,
    private readonly timeoutMs: number = 5_000,
  ) {}

  async send(event: IncidentEvent): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(this.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(event),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`webhook ${this.name} returned ${res.status}`);
    } finally {
      clearTimeout(timer);
    }
  }
}

export class IncidentNotifier {
  constructor(
    private readonly sinks: readonly NotificationSink[],
  ) {}

  /**
   * Dispatch to every sink in parallel. Always returns a per-sink
   * report; sink failures land in `error` rather than throwing —
   * callers should never see the notifier itself reject for one
   * sink's misbehaviour.
   *
   * The `tx` argument is for SOC2 evidence write — pass the active
   * unit-of-work. If null is passed, evidence is skipped (e.g. when
   * the incident is about the DB itself).
   */
  async dispatch(tx: SyncWriteUnitOfWork | null, event: IncidentEvent): Promise<DispatchReport> {
    const sendOutcomes = await Promise.all(
      this.sinks.map(async sink => {
        try {
          await sink.send(event);
          return { name: sink.name, ok: true };
        } catch (err) {
          return { name: sink.name, ok: false, error: (err as Error).message };
        }
      }),
    );

    if (tx) {
      try {
        recordEvidence(tx, {
          tenantId: event.tenantId,
          controlId: 'CC7.4',
          evidenceType: 'incident_notification',
          payload: {
            incidentId: event.incidentId,
            severity: event.severity,
            title: event.title,
            sinks: sendOutcomes,
          },
          metadata: { collector_id: 'incident-notifier' },
        });
      } catch { /* never block dispatch on evidence */ }
    }

    return { incidentId: event.incidentId, sinks: sendOutcomes };
  }
}
