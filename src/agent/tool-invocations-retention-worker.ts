/**
 * tool_invocations retention 清理（F4）
 *
 * 周期性删除：
 *   - invoked_at < (now - retentionMs)
 *   - 但保留 status='pending_confirmation'（尚需用户决策）
 *
 * 单次最多清理 batchSize 行；超出留到下一周期，避免长事务阻塞写入。
 */

import type { ToolPermissionService } from './tool-permission-service.js';
import type { Logger } from '../utils/logger.js';

const LAYER = 'ToolInvocationsRetentionWorker';

export interface ToolInvocationsRetentionOptions {
  intervalMs: number;
  retentionMs: number;
  batchSize: number;
  /** 单周期最多 N 次批次（避免一次跑光数据库） */
  maxBatchesPerCycle: number;
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

  constructor(
    private readonly permissions: ToolPermissionService,
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

  /** 显式触发一次清理（运维/测试用），返回总删除数量 */
  async flushOnce(): Promise<{ deleted: number; batches: number }> {
    const cutoff = Date.now() - this.options.retentionMs;
    let total = 0;
    let batches = 0;
    for (let i = 0; i < this.options.maxBatchesPerCycle; i++) {
      const removed = this.permissions.pruneInvocationsBefore(cutoff, this.options.batchSize);
      total += removed;
      batches++;
      if (removed < this.options.batchSize) break;
    }
    if (total > 0) {
      this.logger.info(LAYER, `已清理 ${total} 条 tool_invocations（${batches} 批次）`);
    }
    return { deleted: total, batches };
  }
}
