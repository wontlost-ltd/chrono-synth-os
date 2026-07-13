/**
 * 确定性进修周期 worker（ADR-0057 进修闭环生产驱动——把 DeterministicLearningService 接上周期触发）。
 *
 * 此前 pending 学习请求登记后**没有任何后台在教它**（LearningOrchestratorL6 生产零装配）——任务因缺
 * 能力挂起后永久 learning_required、永远醒不来（批评者的头号致命缺口）。本 worker 用 setInterval 周期
 * 触发 DeterministicLearningService.driveOnce()，让挂起的学习请求真正被零-LLM 确定性教学+验收+落核，
 * 学会后 emit capability-learned → 下游 TaskWakeHandler 自动唤醒重跑那个挂起的任务。
 *
 * 与 TaskWakeReconcilerWorker 同款手法：setInterval + running 重入守卫 + unref + start/stop/isHealthy +
 * driveOnce（显式触发，运维/测试用）。确定性：用注入的 now()（OS 时钟）非 Date.now()。
 * 失败隔离：单轮异常只记 error 不崩 worker（service 内部已逐条隔离，这里再兜一层）。
 */

import type { DeterministicLearningService, DriveStats } from '../intelligence/deterministic-learning-service.js';
import type { Logger } from '../utils/logger.js';

const LAYER = 'LearningWorker';

export interface LearningWorkerOptions {
  /** 周期间隔（默认 5 分钟——挂起任务应较及时被教，但无需高频）。 */
  readonly intervalMs: number;
}

const DEFAULT_OPTIONS: LearningWorkerOptions = {
  intervalMs: 5 * 60 * 1000,
};

export class LearningWorker {
  private readonly options: LearningWorkerOptions;
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;

  constructor(
    private readonly service: DeterministicLearningService,
    private readonly logger: Logger,
    options: Partial<LearningWorkerOptions> = {},
  ) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.running) return;  /* 重入守卫：上一轮未完不叠加。 */
      this.running = true;
      try {
        this.driveOnce();
      } catch (err) {
        this.logger.error(LAYER, '周期进修失败（已隔离）', err as Error);
      } finally {
        this.running = false;
      }
    }, this.options.intervalMs);
    this.timer.unref?.();  /* 不阻止进程退出。 */
    this.logger.info(LAYER, `启动确定性进修 worker（每 ${this.options.intervalMs}ms 驱动一轮 pending 学习请求）`);
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

  /** 显式驱动一轮（运维/测试用）。枚举本租户全部 pending 学习请求，零-LLM 确定性教学+验收+落核。 */
  driveOnce(): DriveStats {
    return this.service.driveOnce();
  }
}
