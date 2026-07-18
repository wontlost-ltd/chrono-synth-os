import type { IDatabase } from '../storage/database.js';
import type { Logger } from '../utils/logger.js';
import { PersonaCoreService } from './persona-core-service.js';
import { SingleDbResolver } from '../storage/tenant-db-resolver.js';

const LAYER = 'RuntimeRecoveryWorker';

export interface RuntimeRecoveryWorkerOptions {
  pollIntervalMs: number;
  sessionTimeoutMs: number;
  maxRetries: number;
  batchSize: number;
}

export interface RuntimeRecoveryResult {
  scanned: number;
  recovered: number;
  timedOut: number;
  /** 逐 shard 隔离：某 shard 恢复时抛错记录到此处（不影响其余 shard），worker 据此告警。 */
  shardErrors: { shard: string; error: string }[];
}

const DEFAULT_OPTIONS: RuntimeRecoveryWorkerOptions = {
  pollIntervalMs: 5_000,
  sessionTimeoutMs: 60_000,
  maxRetries: 2,
  batchSize: 100,
};

export class RuntimeRecoveryWorker {
  private readonly options: RuntimeRecoveryWorkerOptions;
  private timer: ReturnType<typeof setInterval> | undefined;
  private currentRun: Promise<RuntimeRecoveryResult> | undefined;

  constructor(
    private readonly db: IDatabase,
    private readonly logger: Logger,
    options: Partial<RuntimeRecoveryWorkerOptions> = {},
  ) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.flush().catch((err) => {
        this.logger.error(LAYER, 'runtime recovery flush 失败', err);
      });
    }, this.options.pollIntervalMs);
    this.timer.unref?.();
    this.logger.info(LAYER, `runtime recovery worker 已启动（poll=${this.options.pollIntervalMs}ms）`);
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

  flush(): Promise<RuntimeRecoveryResult> {
    if (this.currentRun) return this.currentRun;
    const run = Promise.resolve(this.flushInternal()).finally(() => {
      if (this.currentRun === run) {
        this.currentRun = undefined;
      }
    });
    this.currentRun = run;
    return run;
  }

  private flushInternal(): RuntimeRecoveryResult {
    /* worker 当前构造器仍收单一 IDatabase（app.ts 传根 db）：经 SingleDbResolver 包一层，
     * allDbs()=[this.db]——单库下 fan-out 遍历一次，行为等价现状。
     * recoverTimedOutRuntimeSessions 本身已真 fan-out（marketplace 层遍历 source.allDbs()），
     * 多 shard 场景由调用方传入真正的多-shard resolver 时自动生效，此处零改动即可复用。 */
    const service = PersonaCoreService.fromResolver(new SingleDbResolver(this.db));
    const result = service.recoverTimedOutRuntimeSessions({
      now: Date.now(),
      sessionTimeoutMs: this.options.sessionTimeoutMs,
      maxRetries: this.options.maxRetries,
      limit: this.options.batchSize,
    });

    if (result.recovered > 0 || result.timedOut > 0) {
      this.logger.warn(
        LAYER,
        `runtime recovery 处理完成（scanned=${result.scanned}, recovered=${result.recovered}, timedOut=${result.timedOut}）`,
      );
    }
    /* 逐 shard 隔离：坏 shard 不拖累其余 shard，但须告警暴露（否则静默丢失恢复能力）。 */
    for (const shardError of result.shardErrors) {
      this.logger.warn(
        LAYER,
        `runtime recovery shard ${shardError.shard} 恢复失败（不影响其余 shard）: ${shardError.error}`,
      );
    }
    return result;
  }
}
