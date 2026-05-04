/**
 * 对话数据 retention 清理（P1-C 加固 10）
 *
 * 周期性删除超过保留期的 conversation_messages 行：
 *   - retention_class='standard' → 默认 90 天
 *   - retention_class='extended' → 默认 365 天
 *   - retention_class='litigation_hold' → 永不删除（监管或法律需求）
 *
 * 同时清理 conversation_confirmation_tokens 中过期未消费的 token。
 */

import type { ConversationService } from './conversation-service.js';
import type { ConfirmationTokenStore } from './confirmation-token-store.js';
import type { Logger } from '../utils/logger.js';

const LAYER = 'ConversationRetentionWorker';

export interface RetentionWorkerOptions {
  /** 周期间隔，默认 1 小时 */
  intervalMs: number;
  /** standard 类保留毫秒数，默认 90 天 */
  standardRetentionMs: number;
  /** extended 类保留毫秒数，默认 365 天 */
  extendedRetentionMs: number;
  /** 单次清理上限批 */
  batchSize: number;
}

const DEFAULT_OPTIONS: RetentionWorkerOptions = {
  intervalMs: 60 * 60 * 1000,
  standardRetentionMs: 90 * 24 * 60 * 60 * 1000,
  extendedRetentionMs: 365 * 24 * 60 * 60 * 1000,
  batchSize: 1000,
};

export class ConversationRetentionWorker {
  private readonly options: RetentionWorkerOptions;
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;

  constructor(
    private readonly service: ConversationService,
    private readonly tokenStore: ConfirmationTokenStore,
    private readonly logger: Logger,
    options: Partial<RetentionWorkerOptions> = {},
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
    this.logger.info(LAYER, `启动 retention worker（每 ${this.options.intervalMs}ms 运行一次）`);
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    /* 等待正在执行的任务完成 */
    while (this.running) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  /** 显式触发一次清理（用于测试或运维） */
  async flushOnce(): Promise<{ messagesDeleted: number; tokensPruned: number }> {
    const now = Date.now();
    const messagesDeleted = this.service.pruneByRetention({
      now,
      standardCutoffMs: this.options.standardRetentionMs,
      extendedCutoffMs: this.options.extendedRetentionMs,
    });
    const tokensPruned = this.tokenStore.pruneExpired(now);
    if (messagesDeleted > 0 || tokensPruned > 0) {
      this.logger.info(LAYER, `清理完成：messages=${messagesDeleted} tokens=${tokensPruned}`);
    }
    return { messagesDeleted, tokensPruned };
  }
}
