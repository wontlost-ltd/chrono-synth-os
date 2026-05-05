import type { SyncWriteUnitOfWork } from '@chrono/kernel';
import type { Logger } from '../utils/logger.js';
import {
  SettlementReconciliationService,
  type SettlementReconciliationRun,
} from './settlement-reconciliation-service.js';

const LAYER = 'SettlementReconciliationWorker';

export interface SettlementReconciliationWorkerOptions {
  pollIntervalMs: number;
  batchSize: number;
}

const DEFAULT_OPTIONS: SettlementReconciliationWorkerOptions = {
  pollIntervalMs: 5 * 60 * 1000,
  batchSize: 100,
};

export class SettlementReconciliationWorker {
  private readonly options: SettlementReconciliationWorkerOptions;
  private timer: ReturnType<typeof setInterval> | undefined;
  private currentRun: Promise<SettlementReconciliationRun[]> | undefined;

  constructor(
    private readonly tx: SyncWriteUnitOfWork,
    private readonly logger: Logger,
    options: Partial<SettlementReconciliationWorkerOptions> = {},
  ) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.flush().catch((err) => {
        this.logger.error(LAYER, 'settlement reconciliation flush 失败', err);
      });
    }, this.options.pollIntervalMs);
    this.timer.unref?.();
    this.logger.info(LAYER, `settlement reconciliation worker 已启动（poll=${this.options.pollIntervalMs}ms）`);
  }

  isHealthy(): boolean {
    return this.timer !== undefined;
  }

  get inflight(): number {
    return this.currentRun ? 1 : 0;
  }

  async stop(drainTimeoutMs = 10_000): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }

    if (!this.currentRun) return;

    const deadline = Date.now() + drainTimeoutMs;
    while (Date.now() < deadline) {
      const run = this.currentRun;
      if (!run) break;
      await run.catch(() => undefined);
    }
  }

  flush(): Promise<SettlementReconciliationRun[]> {
    if (this.currentRun) return this.currentRun;
    const run = Promise.resolve(this.flushInternal()).finally(() => {
      if (this.currentRun === run) {
        this.currentRun = undefined;
      }
    });
    this.currentRun = run;
    return run;
  }

  private flushInternal(): SettlementReconciliationRun[] {
    const service = new SettlementReconciliationService(this.tx);
    const runs = service.reconcileTenants(this.options.batchSize);
    const repaired = runs.reduce((sum, item) => sum + item.repairedSettlements, 0);

    if (repaired > 0) {
      this.logger.warn(
        LAYER,
        `settlement reconciliation 修复完成（tenants=${runs.length}, repaired=${repaired}）`,
      );
    }

    return runs;
  }
}
