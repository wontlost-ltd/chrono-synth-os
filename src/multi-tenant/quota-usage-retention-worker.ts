/**
 * quota_usage retention 清理。
 *
 * quota_usage 按 (tenant_id, resource, window_start) 每个时间窗一行。consumeQuota/checkQuota **只读
 * 当前窗口**——窗口一旦关闭（window_start 远早于当前），该行就是纯死重，永不再被读，却无限累积。
 * 本 worker 周期性删除 window_start < (now - retentionMs) 的旧窗口行。
 *
 * 单次最多 batchSize 行 × maxBatchesPerCycle 批，避免长事务阻塞配额写入。与
 * ToolInvocationsRetentionWorker 同款手法。
 */

import type { QuotaManager } from './quota-manager.js';
import type { Logger } from '../utils/logger.js';

const LAYER = 'QuotaUsageRetentionWorker';

export interface QuotaUsageRetentionOptions {
  intervalMs: number;
  /** 保留多久的窗口（默认 7 天——远超任何合理计量窗口，删的都是确定死掉的旧窗口）。 */
  retentionMs: number;
  batchSize: number;
  /** 单周期最多 N 批（避免一次跑光数据库）。 */
  maxBatchesPerCycle: number;
}

const DEFAULT_OPTIONS: QuotaUsageRetentionOptions = {
  intervalMs: 6 * 60 * 60 * 1000,
  retentionMs: 7 * 24 * 60 * 60 * 1000,
  batchSize: 1000,
  maxBatchesPerCycle: 10,
};

export class QuotaUsageRetentionWorker {
  private readonly options: QuotaUsageRetentionOptions;
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;

  constructor(
    private readonly quota: QuotaManager,
    private readonly logger: Logger,
    options: Partial<QuotaUsageRetentionOptions> = {},
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

  /** 显式触发一次清理（运维/测试用），返回总删除数量。 */
  async flushOnce(now: number = Date.now()): Promise<{ deleted: number; batches: number }> {
    const cutoff = now - this.options.retentionMs;
    let total = 0;
    let batches = 0;
    for (let i = 0; i < this.options.maxBatchesPerCycle; i++) {
      /* pruneUsageBefore 内部按各资源 window_ms 算当前窗口、绝不删当前窗口（即使 retentionMs <
       * window_ms 也安全）。 */
      const removed = this.quota.pruneUsageBefore(now, cutoff, this.options.batchSize);
      total += removed;
      batches++;
      if (removed < this.options.batchSize) break;
    }
    if (total > 0) {
      this.logger.info(LAYER, `已清理 ${total} 条 quota_usage 旧窗口（${batches} 批次）`);
    }
    return { deleted: total, batches };
  }
}
