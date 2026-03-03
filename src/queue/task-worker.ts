/**
 * 任务工作者
 * 轮询 TaskQueue 并分发给注册的处理器
 * 安全治理：任务类型白名单 + 每任务超时 + 取消支持
 */

import type { TaskQueue, TaskRecord } from './task-queue.js';
import type { EventBus } from '../events/event-bus.js';
import type { Logger } from '../utils/logger.js';
import { runWithTenant } from '../multi-tenant/tenant-context.js';

export type TaskHandler = (task: TaskRecord, signal: AbortSignal) => Promise<unknown>;

const LAYER = 'TaskWorker';
const DEFAULT_TASK_TIMEOUT_MS = 120_000;

export class TaskWorker {
  private readonly handlers = new Map<string, TaskHandler>();
  private readonly taskTimeouts = new Map<string, number>();
  private readonly activeAbortControllers = new Map<string, AbortController>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private reaperTimer: ReturnType<typeof setInterval> | undefined;
  private purgeTimer: ReturnType<typeof setInterval> | undefined;
  private running = 0;

  constructor(
    private readonly queue: TaskQueue,
    private readonly bus: EventBus,
    private readonly logger: Logger,
    private readonly pollIntervalMs = 1000,
    private readonly maxConcurrent = 2,
    private readonly maxRetries = 3,
    private readonly reapIntervalMs = 60_000,
    private readonly staleThresholdMs = 300_000,
  ) {}

  /** 注册任务处理器（含可选超时） */
  register(type: string, handler: TaskHandler, timeoutMs?: number): void {
    this.handlers.set(type, handler);
    if (timeoutMs !== undefined) {
      this.taskTimeouts.set(type, timeoutMs);
    }
  }

  /** 取消正在执行的任务 */
  cancelTask(taskId: string): boolean {
    const controller = this.activeAbortControllers.get(taskId);
    if (controller) {
      controller.abort();
      this.logger.info(LAYER, `任务已取消: ${taskId}`);
      return true;
    }
    return false;
  }

  /** 获取已注册的任务类型列表 */
  get registeredTypes(): string[] {
    return [...this.handlers.keys()];
  }

  /** 启动轮询 */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick(); }, this.pollIntervalMs);
    this.reaperTimer = setInterval(() => { this.reapStale(); }, this.reapIntervalMs);
    /* 每小时清理过期的已完成/失败任务 */
    this.purgeTimer = setInterval(() => { this.purgeCompleted(); }, 60 * 60 * 1000);
    this.logger.info(LAYER, `工作者已启动（间隔=${this.pollIntervalMs}ms, 并发=${this.maxConcurrent}）`);
  }

  /** 当前是否健康：轮询已启动且无积压失败 */
  isHealthy(): boolean {
    return this.timer !== undefined;
  }

  /** 当前正在执行的任务数 */
  get inflight(): number {
    return this.running;
  }

  /** 停止轮询并等待正在执行的任务完成 */
  async stop(drainTimeoutMs = 10_000): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    if (this.reaperTimer) {
      clearInterval(this.reaperTimer);
      this.reaperTimer = undefined;
    }
    if (this.purgeTimer) {
      clearInterval(this.purgeTimer);
      this.purgeTimer = undefined;
    }
    if (this.running > 0) {
      this.logger.info(LAYER, `等待 ${this.running} 个进行中的任务完成…`);
      const deadline = Date.now() + drainTimeoutMs;
      while (this.running > 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
      }
      if (this.running > 0) {
        this.logger.warn(LAYER, `排空超时，仍有 ${this.running} 个任务未完成`);
      }
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

  /** 清理过期已完成任务 */
  private purgeCompleted(): void {
    try {
      const purged = this.queue.purgeCompleted();
      if (purged > 0) {
        this.logger.info(LAYER, `清理 ${purged} 个过期已完成任务`);
      }
    } catch (err) {
      this.logger.error(LAYER, `已完成任务清理失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** 回收卡死任务 */
  private reapStale(): void {
    try {
      const reaped = this.queue.reapStaleTasks(this.staleThresholdMs);
      if (reaped > 0) {
        this.logger.warn(LAYER, `回收 ${reaped} 个卡死任务`);
      }
    } catch (err) {
      this.logger.error(LAYER, `卡死任务回收失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** 执行单个任务（在租户上下文中运行，含超时和取消支持） */
  private async handleTask(task: TaskRecord): Promise<void> {
    const handler = this.handlers.get(task.type);
    if (!handler) {
      const error = `未注册的任务类型: ${task.type}（已注册: ${this.registeredTypes.join(', ') || '无'}）`;
      this.queue.fail(task.id, error);
      this.bus.emit('task:failed', { taskId: task.id, error, tenantId: task.tenantId });
      this.logger.warn(LAYER, `拒绝未知任务类型: ${task.type} (任务=${task.id})`);
      return;
    }

    const controller = new AbortController();
    this.activeAbortControllers.set(task.id, controller);
    const timeoutMs = this.taskTimeouts.get(task.type) ?? DEFAULT_TASK_TIMEOUT_MS;
    const timer = setTimeout(() => {
      controller.abort();
      this.logger.warn(LAYER, `任务超时 (${timeoutMs}ms): ${task.id} (类型=${task.type})`);
    }, timeoutMs);

    try {
      await runWithTenant(task.tenantId, async () => {
        try {
          const result = await handler(task, controller.signal);
          if (controller.signal.aborted) {
            throw new Error(`任务执行超时 (${timeoutMs}ms)`);
          }
          this.queue.complete(task.id, result);
          this.bus.emit('task:completed', { taskId: task.id, result: result ?? null, tenantId: task.tenantId });
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
            this.bus.emit('task:failed', { taskId: task.id, error: errorMsg, tenantId: task.tenantId });
            this.logger.error(LAYER, `任务失败: ${task.id} — ${errorMsg}`);
          }
        }
      });
    } finally {
      clearTimeout(timer);
      this.activeAbortControllers.delete(task.id);
    }
  }
}
