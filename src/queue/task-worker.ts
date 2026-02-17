/**
 * 任务工作者
 * 轮询 TaskQueue 并分发给注册的处理器
 */

import type { TaskQueue, TaskRecord } from './task-queue.js';
import type { EventBus } from '../events/event-bus.js';
import type { Logger } from '../utils/logger.js';
import { runWithTenant } from '../multi-tenant/tenant-context.js';

export type TaskHandler = (task: TaskRecord) => Promise<unknown>;

const LAYER = 'TaskWorker';

export class TaskWorker {
  private readonly handlers = new Map<string, TaskHandler>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = 0;

  constructor(
    private readonly queue: TaskQueue,
    private readonly bus: EventBus,
    private readonly logger: Logger,
    private readonly pollIntervalMs = 1000,
    private readonly maxConcurrent = 2,
    private readonly maxRetries = 3,
  ) {}

  /** 注册任务处理器 */
  register(type: string, handler: TaskHandler): void {
    this.handlers.set(type, handler);
  }

  /** 启动轮询 */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick(); }, this.pollIntervalMs);
    this.logger.info(LAYER, `工作者已启动（间隔=${this.pollIntervalMs}ms, 并发=${this.maxConcurrent}）`);
  }

  /** 停止轮询 */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.logger.info(LAYER, '工作者已停止');
  }

  /** 单次轮询：出队并执行任务 */
  private async tick(): Promise<void> {
    while (this.running < this.maxConcurrent) {
      const task = this.queue.dequeue();
      if (!task) break;

      this.running++;
      void this.handleTask(task).finally(() => { this.running--; });
    }
  }

  /** 执行单个任务（在租户上下文中运行） */
  private async handleTask(task: TaskRecord): Promise<void> {
    const handler = this.handlers.get(task.type);
    if (!handler) {
      this.queue.fail(task.id, `未注册的任务类型: ${task.type}`);
      this.bus.emit('task:failed', { taskId: task.id, error: `未注册的任务类型: ${task.type}` });
      return;
    }

    await runWithTenant(task.tenantId, async () => {
      try {
        const result = await handler(task);
        this.queue.complete(task.id, result);
        this.bus.emit('task:completed', { taskId: task.id, result: result ?? null });
        this.logger.info(LAYER, `任务完成: ${task.id} (类型=${task.type})`);
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);

        if (task.retryCount + 1 < (task.maxRetries || this.maxRetries)) {
          const delay = Math.min(30_000, 1000 * 2 ** task.retryCount);
          const availableAt = Date.now() + delay;
          this.queue.reschedule(task.id, task.retryCount + 1, availableAt, errorMsg);
          this.logger.warn(LAYER, `任务重试 ${task.retryCount + 1}: ${task.id} (延迟=${delay}ms)`);
        } else {
          this.queue.fail(task.id, errorMsg);
          this.bus.emit('task:failed', { taskId: task.id, error: errorMsg });
          this.logger.error(LAYER, `任务失败: ${task.id} — ${errorMsg}`);
        }
      }
    });
  }
}
