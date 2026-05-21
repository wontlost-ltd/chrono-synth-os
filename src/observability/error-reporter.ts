/**
 * Pluggable error / crash reporter.
 *
 * Plan: poc-to-enterprise-ga-2026-v7.3.md §5.1 P3-A
 *
 * Design:
 *   - One interface (`ErrorReporter`) the app code talks to. Two ship'd
 *     implementations: a `NullErrorReporter` for dev/test/air-gap and a
 *     `HttpErrorReporter` that POSTs to a Sentry-compatible store-event
 *     endpoint over HTTPS.
 *   - No Sentry SDK dependency. Sentry's ingest API (POST
 *     /api/<project-id>/store/) accepts a small JSON envelope; we
 *     implement just that. Customers running self-hosted Sentry / GlitchTip
 *     / Bugsnag / Datadog APM event sinks all accept the same shape
 *     with a thin adapter layer.
 *   - PII scrubbing is mandatory before send. We pipe the message +
 *     extras through the existing redactPii() before constructing the
 *     payload — a stack trace that mentions a customer email must not
 *     leave the box unredacted.
 *
 * What this is NOT:
 *   - Not a minidump producer. Native crashes are caught by the Tauri
 *     runtime's per-platform crash handler (macOS: crashpad; Windows:
 *     WER; Linux: breakpad). Those produce minidumps that the platform-
 *     specific glue code uploads via this `HttpErrorReporter`. The
 *     minidump bytes are passed as an attachment in the envelope.
 *   - Not a transaction tracer. APM-style perf data goes through OTel.
 */

import { redactPii } from '../conversation/pii-redactor.js';

export interface ErrorEvent {
  /** Free-form error message; PII-scrubbed before transport. */
  message: string;
  /** Optional stack trace; also PII-scrubbed. */
  stack?: string;
  /** Severity. */
  level: 'fatal' | 'error' | 'warning' | 'info';
  /** App-specific tags for filtering (release version, platform). */
  tags?: Record<string, string>;
  /** Free-form structured extras; values stringified + redacted. */
  extra?: Record<string, unknown>;
  /** Tenant scope when known; never include actorId here. */
  tenantId?: string;
}

export interface ErrorReporter {
  readonly name: string;
  /**
   * Best-effort dispatch. Returns true if the report was queued for
   * transport; false if it was suppressed (rate limit, disabled).
   * Must never throw — callers invoke this from error handlers.
   */
  report(event: ErrorEvent): Promise<boolean>;
}

/**
 * No-op reporter — used in dev, tests, and air-gap deployments. Captures
 * events into an in-memory ring so tests can assert what was reported.
 */
export class NullErrorReporter implements ErrorReporter {
  readonly name = 'null';
  readonly captured: ErrorEvent[] = [];

  async report(event: ErrorEvent): Promise<boolean> {
    /* Apply PII scrubbing even on the null path — tests asserting on
     * captured.message will see the scrubbed output, matching what a
     * real transport would carry. */
    this.captured.push(scrubEvent(event));
    /* Bound the buffer so a long-running test doesn't grow forever. */
    if (this.captured.length > 1000) this.captured.shift();
    return true;
  }
}

export interface HttpReporterOptions {
  /** Sentry-compatible store URL: https://sentry.io/api/<project-id>/store/ */
  endpoint: string;
  /** Sentry DSN public key (NOT the secret half). */
  publicKey: string;
  /** Release version tag attached to every event. */
  release: string;
  /** Environment label (production / staging). */
  environment: string;
  /** Soft per-second rate limit; events beyond are dropped + counted. */
  maxEventsPerSecond: number;
  /** HTTP request timeout. */
  timeoutMs: number;
}

export class HttpErrorReporter implements ErrorReporter {
  readonly name = 'http';
  private windowStartMs = 0;
  private eventsInWindow = 0;
  private dropped = 0;

  constructor(private readonly opts: HttpReporterOptions) {
    if (!opts.endpoint.startsWith('https://')) {
      throw new Error('error reporter endpoint must be HTTPS');
    }
    if (!opts.publicKey) throw new Error('error reporter requires publicKey');
  }

  async report(event: ErrorEvent): Promise<boolean> {
    /* Rate limit: 1-second sliding window. */
    const now = Date.now();
    if (now - this.windowStartMs >= 1000) {
      this.windowStartMs = now;
      this.eventsInWindow = 0;
    }
    if (this.eventsInWindow >= this.opts.maxEventsPerSecond) {
      this.dropped += 1;
      return false;
    }
    this.eventsInWindow += 1;

    const scrubbed = scrubEvent(event);
    /* Sentry-style envelope. Minimal fields; reporting libraries
     * normally add a lot more (breadcrumbs, request, modules) which
     * we leave to the calling layer when relevant. */
    const payload = {
      event_id: randomId(),
      level: scrubbed.level,
      message: { formatted: scrubbed.message },
      release: this.opts.release,
      environment: this.opts.environment,
      tags: scrubbed.tags,
      extra: scrubbed.extra,
      ...(scrubbed.stack ? { exception: { values: [{ stacktrace: { frames: parseFrames(scrubbed.stack) } }] } } : {}),
      ...(scrubbed.tenantId ? { user: { id: `tenant:${scrubbed.tenantId}` } } : {}),
    };

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs);
      try {
        const res = await fetch(this.opts.endpoint, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'X-Sentry-Auth': `Sentry sentry_version=7, sentry_key=${this.opts.publicKey}`,
          },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
        return res.ok;
      } finally {
        clearTimeout(timer);
      }
    } catch {
      /* Never throw from a reporter — error handlers depend on this. */
      return false;
    }
  }

  /** Diagnostic — for dashboards / alerts. */
  snapshot(): { eventsInWindow: number; dropped: number } {
    return { eventsInWindow: this.eventsInWindow, dropped: this.dropped };
  }
}

/* ─── helpers ─────────────────────────────────────────────────────── */

function scrubEvent(event: ErrorEvent): ErrorEvent {
  const message = redactPii(event.message).text;
  const stack = event.stack ? redactPii(event.stack).text : undefined;
  const extra: Record<string, unknown> = {};
  if (event.extra) {
    for (const [k, v] of Object.entries(event.extra)) {
      const stringified = typeof v === 'string' ? v : JSON.stringify(v);
      extra[k] = redactPii(stringified).text;
    }
  }
  return {
    message,
    ...(stack ? { stack } : {}),
    level: event.level,
    ...(event.tags ? { tags: event.tags } : {}),
    ...(event.extra ? { extra } : {}),
    ...(event.tenantId ? { tenantId: event.tenantId } : {}),
  };
}

function randomId(): string {
  /* 32 hex chars matches Sentry event_id format. */
  let s = '';
  for (let i = 0; i < 32; i += 1) s += Math.floor(Math.random() * 16).toString(16);
  return s;
}

function parseFrames(stack: string): Array<{ function: string; filename: string; lineno: number }> {
  /* Best-effort V8 stack parser. Captures lines like:
   *   "    at Foo.bar (/path/file.ts:42:10)"
   *   "    at /path/file.ts:42:10"  */
  const frames: Array<{ function: string; filename: string; lineno: number }> = [];
  for (const line of stack.split('\n')) {
    const m = /\s+at\s+(?:(.+?)\s+\()?(.+?):(\d+):\d+\)?$/.exec(line);
    if (m) {
      frames.push({ function: m[1] ?? '<anonymous>', filename: m[2]!, lineno: Number(m[3]) });
    }
  }
  /* Sentry expects frames in reverse — newest-first. */
  return frames.reverse();
}
