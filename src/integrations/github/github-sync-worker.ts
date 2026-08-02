/**
 * GithubSyncWorker —— 组织级驻留的周期驱动（让数字人装好 App 后自己持续学完整个组织）。
 *
 * 此前 GitHub 学习只在人工 POST /learn-github 时发生一次，全仓无任何 GitHub 定时器——
 * 「长期驻入组织」这个诉求因此不成立。本 worker 用 setInterval 周期触发组织轮转同步。
 *
 * 与 LearningWorker / TaskWakeReconcilerWorker 同款手法：setInterval + running 重入守卫 +
 * unref + start/stop/isHealthy/driveOnce。单租户作用域（跟随宿主 OS 实例），零新架构概念。
 *
 * **默认关闭**：这是会自动发出站请求、自动消耗 LLM 老师额度的后台循环，默认开启对现有
 * 部署构成行为突变，必须显式启用。
 *
 * 失败隔离：单轮异常只记 error 不崩 worker（learnOrg 内部已逐 repo 隔离，这里再兜一层）。
 */

import type { Logger } from '../../utils/logger.js';

const LAYER = 'GithubSyncWorker';

export interface GithubSyncWorkerOptions {
  /** 是否启用（默认 false——自动出站 + 消耗 LLM 额度的循环不默认开）。 */
  readonly enabled: boolean;
  /**
   * 周期间隔毫秒（默认 30 分钟）。组织知识沉淀不是实时告警，无需高频；
   * 配合每轮 5 个仓库，一个 50 仓库的组织约 5 小时轮完一周。
   */
  readonly intervalMs: number;
}

const DEFAULT_OPTIONS: GithubSyncWorkerOptions = {
  enabled: false,
  intervalMs: 30 * 60 * 1000,
};

/** 一轮组织同步的驱动函数（由组合根注入，内部装配 ReadPort 并调 learnOrg）。 */
export type OrgSyncDriver = () => Promise<void>;

export class GithubSyncWorker {
  private readonly options: GithubSyncWorkerOptions;
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;

  constructor(
    private readonly drive: OrgSyncDriver,
    private readonly logger: Logger,
    options: Partial<GithubSyncWorkerOptions> = {},
  ) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  start(): void {
    if (!this.options.enabled) return;   /* 默认关闭：未显式启用则不起循环。 */
    if (this.timer) return;              /* 幂等：重复 start 不叠加定时器。 */
    this.timer = setInterval(() => {
      void this.driveOnce();             /* 重入守卫在 driveOnce 内。 */
    }, this.options.intervalMs);
    this.timer.unref?.();                /* 不阻止进程退出。 */
    this.logger.info(LAYER, `启动 GitHub 组织同步 worker（每 ${this.options.intervalMs}ms 轮转一批仓库）`);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  isHealthy(): boolean {
    return this.timer !== undefined;
  }

  /**
   * 显式驱动一轮（运维/测试用，也是定时器的回调）。
   * 重入守卫：上一轮未完则直接返回，不叠加。
   * 异常在此隔离、绝不向外抛——单轮失败不该影响后续周期。
   */
  async driveOnce(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.drive();
    } catch (err) {
      this.logger.error(LAYER, '组织同步单轮失败（已隔离）', err as Error);
    } finally {
      this.running = false;
    }
  }
}
