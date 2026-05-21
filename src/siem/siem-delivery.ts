/**
 * SIEM delivery — buffered, retryable forwarding of audit events.
 *
 * Plan: poc-to-enterprise-ga-2026-v7.3.md §4 P1-Q-3 + §8 #22
 *
 * Design:
 *   - In-memory ring buffer holds events when the SIEM endpoint is
 *     unreachable; capacity-bounded so a long outage doesn't OOM the
 *     pod. On overflow, oldest events go to dead-letter (separate
 *     bounded list) and an alert metric ticks.
 *   - Delivery is async + idempotent: caller `enqueue(event)` returns
 *     immediately. A background flusher attempts delivery on a timer.
 *   - Retry: on transport failure, retain in main buffer (head) and
 *     bump retry count. After maxRetries, move to dead-letter.
 *   - 4xx response from SIEM = permanent failure (don't retry, dead-letter).
 *     5xx response = transient (retry).
 *
 * What this is NOT:
 *   - Not a durable queue. Process crash loses in-flight events. P1-Q-3-ext
 *     adds DB-backed outbox using the existing audit hash chain.
 *   - Not a high-throughput pipeline. Designed for the audit-log volume
 *     (≤100/sec); FluentBit / Vector should sit between us and the
 *     downstream SIEM at higher rates.
 */

export interface SiemTransport {
  /** Deliver one wire-format payload (CEF / syslog / etc.). */
  deliver(payload: string): Promise<{ ok: true } | { ok: false; permanent: boolean; reason: string }>;
}

export interface SiemDeliveryOptions {
  maxBufferSize: number;
  maxDeadLetterSize: number;
  maxRetries: number;
  /** Pause between flush attempts in ms. Set to 0 to disable the
   * automatic background flusher and drive flushes externally. */
  flushIntervalMs: number;
}

export const DEFAULT_SIEM_OPTIONS: SiemDeliveryOptions = {
  maxBufferSize: 10_000,
  maxDeadLetterSize: 1_000,
  maxRetries: 3,
  flushIntervalMs: 0,
};

interface BufferEntry {
  payload: string;
  retries: number;
  enqueuedAtMs: number;
}

export interface SiemSnapshot {
  pending: number;
  deadLettered: number;
  delivered: number;
  permanentFailures: number;
  transientFailures: number;
  overflowDrops: number;
}

export class SiemDelivery {
  private readonly buffer: BufferEntry[] = [];
  private readonly deadLetter: BufferEntry[] = [];
  private delivered = 0;
  private permanentFailures = 0;
  private transientFailures = 0;
  private overflowDrops = 0;
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly transport: SiemTransport,
    private readonly opts: SiemDeliveryOptions = DEFAULT_SIEM_OPTIONS,
  ) {
    if (opts.flushIntervalMs > 0) {
      this.timer = setInterval(() => {
        void this.flush();
      }, opts.flushIntervalMs);
      this.timer.unref(); /* don't block process exit */
    }
  }

  enqueue(payload: string): void {
    if (this.buffer.length >= this.opts.maxBufferSize) {
      /* Buffer full — move oldest to dead-letter, drop quietly only when
       * dead-letter is full too. */
      const evicted = this.buffer.shift();
      if (evicted) {
        if (this.deadLetter.length < this.opts.maxDeadLetterSize) {
          this.deadLetter.push(evicted);
        } else {
          this.overflowDrops += 1;
        }
      }
    }
    this.buffer.push({ payload, retries: 0, enqueuedAtMs: Date.now() });
  }

  /** Attempt to drain the buffer. Stops on first transient failure
   * to preserve event ordering — SIEM expects sequenced delivery. */
  async flush(): Promise<void> {
    while (this.buffer.length > 0) {
      const entry = this.buffer[0]!;
      let result: Awaited<ReturnType<SiemTransport['deliver']>>;
      try {
        result = await this.transport.deliver(entry.payload);
      } catch (err) {
        /* Transport itself threw — treat as transient. */
        result = { ok: false, permanent: false, reason: (err as Error).message };
      }
      if (result.ok) {
        this.buffer.shift();
        this.delivered += 1;
        continue;
      }
      if (result.permanent) {
        this.buffer.shift();
        this.moveToDeadLetter(entry);
        this.permanentFailures += 1;
        continue;
      }
      /* Transient — bump retry count; if maxed, dead-letter and continue
       * (don't block on a poison message). */
      entry.retries += 1;
      this.transientFailures += 1;
      if (entry.retries >= this.opts.maxRetries) {
        this.buffer.shift();
        this.moveToDeadLetter(entry);
      } else {
        /* Stop here — preserve order; retry the same entry on next flush. */
        return;
      }
    }
  }

  private moveToDeadLetter(entry: BufferEntry): void {
    if (this.deadLetter.length < this.opts.maxDeadLetterSize) {
      this.deadLetter.push(entry);
    } else {
      this.overflowDrops += 1;
    }
  }

  /** Diagnostic + alerting surface. */
  snapshot(): SiemSnapshot {
    return {
      pending: this.buffer.length,
      deadLettered: this.deadLetter.length,
      delivered: this.delivered,
      permanentFailures: this.permanentFailures,
      transientFailures: this.transientFailures,
      overflowDrops: this.overflowDrops,
    };
  }

  /** Inspect dead-letter queue (for operator review / re-enqueue). */
  drainDeadLetter(): string[] {
    const out = this.deadLetter.map(e => e.payload);
    this.deadLetter.length = 0;
    return out;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
