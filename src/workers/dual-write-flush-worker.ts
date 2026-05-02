import { personaCoreDualWrite } from '../data-plane/persona-core-dual-write.js';
import { SqliteEventLedger } from '../data-plane/sqlite-event-ledger.js';
import type { IDatabase } from '../storage/database.js';
import type { Logger } from '../utils/logger.js';

export interface DualWriteFlushWorkerOptions {
  db: IDatabase;
  intervalMs?: number;
  logger?: Logger;
}

export class DualWriteFlushWorker {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly ledger: SqliteEventLedger;
  private readonly intervalMs: number;

  constructor(private readonly opts: DualWriteFlushWorkerOptions) {
    this.ledger = new SqliteEventLedger(opts.db);
    this.intervalMs = opts.intervalMs ?? 5000;
  }

  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => {
      void this.flush().catch(err => {
        this.opts.logger?.error(
          'DualWriteFlushWorker',
          'persona_core outbox flush failed',
          { error: err instanceof Error ? err.message : String(err) },
        );
      });
    }, this.intervalMs);
  }

  stop(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  async flush(): Promise<{ flushed: number; failed: number }> {
    const result = await personaCoreDualWrite.flushOutbox(this.opts.db, this.ledger);
    this.opts.logger?.info('DualWriteFlushWorker', 'persona_core outbox flush complete', result);
    return result;
  }
}
