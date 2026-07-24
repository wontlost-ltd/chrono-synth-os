/**
 * tool_invocations retention 清理（F4）
 *
 * 周期性删除：
 *   - invoked_at < (now - retentionMs)
 *   - 但保留 status='pending_confirmation'（尚需用户决策）
 *
 * 单次每 shard 各自最多清理 maxBatchesPerCycle × batchSize 行；超出留到下一周期，避免长事务阻塞写入。
 *
 * **分片 fan-out（Plan 2 · Task 4）**：ctor 收 `TenantDbResolver`，flushOnce 遍历 `allShardDbs()` 对每个
 * shard 各 `new ToolPermissionService(shardDb).pruneInvocationsBefore(...)`——只跑一库会让非-home shard 的
 * tool_invocations 永不回收（容量漂移）。逐 shard try/catch 隔离：某 shard 抛错只记 shardErrors + logger.error
 * （失败不静默），不拖累其余 shard；聚合各 shard 删除计数。批次预算语义定为**每 shard 各自最多
 * maxBatchesPerCycle 批**（外层 for shard、内层批次循环不变）——续批判据仍用 pruneInvocationsBefore
 * 返回 count===batchSize 近似（该方法只返 number 无 mayHaveMore，判据照旧）。
 * 单库下 `allShardDbs()=[db]`，等价现状、零回归。
 */

import { ToolPermissionService } from './tool-permission-service.js';
import type { TenantDbResolver } from '../storage/tenant-db-resolver.js';
import { makeShardKeyer } from '../storage/shard-key.js';
import type { Logger } from '../utils/logger.js';

const LAYER = 'ToolInvocationsRetentionWorker';

export interface ToolInvocationsRetentionOptions {
  intervalMs: number;
  retentionMs: number;
  batchSize: number;
  /** 单周期**每 shard** 最多 N 次批次（避免一次跑光单个 shard 的数据库） */
  maxBatchesPerCycle: number;
}

/** flushOnce 聚合结果：跨 shard 删除数求和 + 逐 shard 错误明细（坏 shard 不静默丢失清理能力）。 */
export interface ToolInvocationsFlushResult {
  deleted: number;
  batches: number;
  shardErrors: Array<{ shardKey: string; error: string }>;
}

const DEFAULT_OPTIONS: ToolInvocationsRetentionOptions = {
  intervalMs: 60 * 60 * 1000,
  retentionMs: 90 * 24 * 60 * 60 * 1000,
  batchSize: 1000,
  maxBatchesPerCycle: 10,
};

export class ToolInvocationsRetentionWorker {
  private readonly options: ToolInvocationsRetentionOptions;
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;
  /* 每个 worker 持有自己的 keyer：同一 shard db 实例恒返稳定 shardKey（shard#0/shard#1/...），非数组下标。 */
  private readonly keyer = makeShardKeyer();

  constructor(
    private readonly resolver: TenantDbResolver,
    private readonly logger: Logger,
    options: Partial<ToolInvocationsRetentionOptions> = {},
  ) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.running) return;
      this.running = true;
      this.flushOnce()
        .catch((err) => this.logger.error(LAYER, '清理任务失败', err))
        .finally(() => { this.running = false; });
    }, this.options.intervalMs);
    this.timer.unref?.();
    this.logger.info(
      LAYER,
      `启动 retention worker（每 ${this.options.intervalMs}ms 运行；保留 ${this.options.retentionMs}ms）`,
    );
  }

  isHealthy(): boolean {
    return this.timer !== undefined;
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    while (this.running) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  /**
   * 显式触发一次清理（运维/测试用），返回跨 shard 聚合删除数量 + 逐 shard 错误明细。
   *
   * 跨所有 shard fan-out：逐 shard 各建一个 ToolPermissionService(shardDb) 跑本 shard 的批次循环。
   * 逐 shard try/catch 隔离——某 shard 抛错只记 shardErrors + logger.error（失败不静默），不拖累其余 shard。
   */
  async flushOnce(): Promise<ToolInvocationsFlushResult> {
    const cutoff = Date.now() - this.options.retentionMs;
    let total = 0;
    let batches = 0;
    const shardErrors: Array<{ shardKey: string; error: string }> = [];

    for (const shardDb of this.resolver.allShardDbs()) {
      const shardKey = this.keyer(shardDb);
      try {
        const permissions = new ToolPermissionService(shardDb);
        /* 每 shard 各自最多 maxBatchesPerCycle 批（外层 shard、内层批次循环不变）。 */
        for (let i = 0; i < this.options.maxBatchesPerCycle; i++) {
          const removed = permissions.pruneInvocationsBefore(cutoff, this.options.batchSize);
          total += removed;
          batches++;
          /* pruneInvocationsBefore 只返 number（无 mayHaveMore）：续批判据用 count===batchSize 近似。 */
          if (removed < this.options.batchSize) break;
        }
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        shardErrors.push({ shardKey, error });
        this.logger.error(
          LAYER,
          `shard ${shardKey} tool_invocations 清理失败（隔离，不拖累其余 shard）: ${error}`,
        );
      }
    }

    if (total > 0) {
      this.logger.info(LAYER, `已清理 ${total} 条 tool_invocations（${batches} 批次，跨 ${this.resolver.allShardDbs().length} shard）`);
    }
    return { deleted: total, batches, shardErrors };
  }
}
