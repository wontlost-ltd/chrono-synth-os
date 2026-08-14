import type { Logger } from '../utils/logger.js';
import type { TenantDbResolver } from '../storage/tenant-db-resolver.js';
import { makeShardKeyer } from '../storage/shard-key.js';
import {
  SettlementReconciliationService,
  type SettlementReconciliationRun,
} from './settlement-reconciliation-service.js';

const LAYER = 'SettlementReconciliationWorker';

export interface SettlementReconciliationWorkerOptions {
  pollIntervalMs: number;
  batchSize: number;
}

/**
 * flush 公开返回契约（分片 Phase 0 · Plan 2 · Task 3）：
 * 各 shard 结算产出的 runs concat + 逐 shard 隔离时失败 shard 收进 shardErrors（含稳定 shardKey）。
 * 明确返回结构（非只「聚合 runs」），调用方据 shardErrors 告警——坏 shard 不静默丢失结算能力。
 */
export interface SettlementReconciliationFlushResult {
  runs: SettlementReconciliationRun[];
  shardErrors: Array<{ shardKey: string; error: string }>;
}

const DEFAULT_OPTIONS: SettlementReconciliationWorkerOptions = {
  pollIntervalMs: 5 * 60 * 1000,
  batchSize: 100,
};

export class SettlementReconciliationWorker {
  private readonly options: SettlementReconciliationWorkerOptions;
  private timer: ReturnType<typeof setInterval> | undefined;
  private currentRun: Promise<SettlementReconciliationFlushResult> | undefined;
  /** 每个 worker 持有自己的 keyer：同一 db 实例恒返稳定 shardKey（shard#0/shard#1/...），非数组下标。 */
  private readonly keyer = makeShardKeyer();

  constructor(
    private readonly resolver: TenantDbResolver,
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

  flush(): Promise<SettlementReconciliationFlushResult> {
    if (this.currentRun) return this.currentRun;
    const run = Promise.resolve(this.flushInternal()).finally(() => {
      if (this.currentRun === run) {
        this.currentRun = undefined;
      }
    });
    this.currentRun = run;
    return run;
  }

  private flushInternal(): SettlementReconciliationFlushResult {
    /* 跨 shard fan-out：遍历 allShardDbs() 逐 shard 各自枚举其租户并对账（单库下 allShardDbs()=[db]，
     * 行为等价现状）。逐 shard try/catch 隔离：某 shard 整体抛错只记 shardErrors、不拖累其余 shard——
     * 目标是修复所有 shard 的结算漂移，一个坏 shard 不该阻止健康 shard 对账。 */
    const runs: SettlementReconciliationRun[] = [];
    const shardErrors: Array<{ shardKey: string; error: string }> = [];

    for (const db of this.resolver.allShardDbs()) {
      const shardKey = this.keyer(db);
      try {
        const service = new SettlementReconciliationService(db);
        for (const run of service.reconcileTenants(this.options.batchSize)) {
          runs.push(run);
        }
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        shardErrors.push({ shardKey, error });
        this.logger.error(
          LAYER,
          `settlement reconciliation shard ${shardKey} 对账失败（不影响其余 shard）: ${error}`,
        );
      }
    }

    const repaired = runs.reduce((sum, item) => sum + item.repairedSettlements, 0);
    if (repaired > 0) {
      this.logger.warn(
        LAYER,
        `settlement reconciliation 修复完成（tenants=${runs.length}, repaired=${repaired}）`,
      );
    }

    return { runs, shardErrors };
  }
}
