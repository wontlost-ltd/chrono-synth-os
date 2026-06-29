/**
 * 任务唤醒对账周期 worker（ADR-0057 L8c-wire）——把 L8c reconciler 接上**生产周期触发**。
 *
 * L8c reconciler 此前只暴露按需 reconcileTenant()/reconcileOnce()，生产无周期触发——意味着 capability-learned
 * 事件真丢投时挂起任务不会被自动补唤醒（要等运维手动调）。本 worker 用 setInterval 周期触发 reconcileTenant，
 * 把「事件丢失永久挂起」的兜底真正自动化，闭合 L8c 的「engine built, steering wheel unconnected」最后一环。
 *
 * 与 QuotaUsageRetentionWorker 同款手法：setInterval + running 重入守卫 + unref + start/stop/isHealthy +
 * flushOnce（显式触发，运维/测试用）。确定性：用注入的 now()（OS 时钟）非 Date.now()，可测可复现。
 *
 * 失败隔离：单轮对账异常只记 error 不崩 worker（reconciler 内部已逐任务隔离，这里再兜一层）。
 */

import type { TaskWakeReconciler, ReconcileStats } from './task-wake-reconciler.js';
import type { Logger } from '../utils/logger.js';

const LAYER = 'TaskWakeReconcilerWorker';

export interface TaskWakeReconcilerWorkerOptions {
  /** 周期间隔（默认 10 分钟——丢事件兜底不需高频，足够及时且不扰动）。 */
  readonly intervalMs: number;
}

const DEFAULT_OPTIONS: TaskWakeReconcilerWorkerOptions = {
  intervalMs: 10 * 60 * 1000,
};

export class TaskWakeReconcilerWorker {
  private readonly options: TaskWakeReconcilerWorkerOptions;
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;

  constructor(
    private readonly reconciler: TaskWakeReconciler,
    private readonly now: () => number,
    private readonly logger: Logger,
    options: Partial<TaskWakeReconcilerWorkerOptions> = {},
  ) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.running) return;  /* 重入守卫：上一轮未完不叠加。 */
      this.running = true;
      try {
        this.flushOnce();
      } catch (err) {
        this.logger.error(LAYER, '周期对账失败（已隔离）', err as Error);
      } finally {
        this.running = false;
      }
    }, this.options.intervalMs);
    this.timer.unref?.();  /* 不阻止进程退出。 */
    this.logger.info(LAYER, `启动唤醒对账 worker（每 ${this.options.intervalMs}ms 反扫一次本租户学习 blocked 任务）`);
  }

  isHealthy(): boolean {
    return this.timer !== undefined;
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** 显式触发一次对账（运维/测试用）。反扫本租户全部 org 的学习 blocked 任务。 */
  flushOnce(now: number = this.now()): ReconcileStats {
    return this.reconciler.reconcileTenant(now);
  }
}
