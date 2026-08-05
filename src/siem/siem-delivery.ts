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
  /** 进行中的 drain；并发 flush() 复用它而非另起一轮（见 flush 注释）。 */
  private inFlight: Promise<void> | undefined;

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
   * to preserve event ordering — SIEM expects sequenced delivery.
   *
   * 单飞：定时器与外部调用天然并发，而 drain 循环在 peek 与 shift 之间有 await
   * 断点。若允许并发进入，两个 flush 会读到同一条目→重复投递，随后两次 shift
   * 各删一条→后一条从未投递却消失。故并发调用复用同一次 drain 的 Promise。 */
  async flush(): Promise<void> {
    if (this.inFlight) {
      /* 复用进行中的 drain。但**不能就此返回**：调用方可能在上一轮 drain 判空之后、
       * finally 清除 inFlight 之前入队（drain 为空时同步走完，这个窗口必然存在）。
       * 那样新事件既没被上一轮看到，又因复用旧 Promise 而无人处理，将无限期滞留。
       * 故等旧 drain 落定后重新检查队列——有残留就再跑一轮。 */
      await this.inFlight;
      if (this.buffer.length === 0) return;
      return this.flush();
    }
    this.inFlight = this.drain().finally(() => { this.inFlight = undefined; });
    return this.inFlight;
  }

  private async drain(): Promise<void> {
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
