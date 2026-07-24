/**
 * 感知媒体引用 retention 清理 worker（ADR-0051 Phase 3 / ADR-0052 Edge-P5）。
 *
 * `runMediaRetention` 早已实现（按 delete_after ≤ now 全局扫描过期引用 → 删对象存储对象 → 删引用行），
 * 但此前**没有周期触发器**——只在测试里被调。后果：
 *   - GDPR Art.17 擦除闭环断裂：privacy eraseData 只**标记** perception_media_refs 为 erased +
 *     delete_after=0，依赖本 worker 才真正删对象+删行；不跑则原始媒体永不物理删除、引用行无限堆积。
 *   - 过期媒体引用永不回收（容量/合规漂移）。
 * 本 worker 用与 QuotaUsageRetentionWorker / ConversationRetentionWorker 同款手法（setInterval +
 * 重入守卫 + unref + start/stop/isHealthy + 显式 flushOnce），把它接进生产周期。
 *
 * **分片 fan-out（Plan 2 · Task 1）**：ctor 收 `TenantDbResolver`，flushOnce 遍历 `allShardDbs()` 对每个
 * shard 各跑一次 runMediaRetention——GDPR Art.17 擦除必须覆盖**所有** shard，只跑一个库会让非-home shard
 * 的过期媒体永不物理删（合规漏擦）。逐 shard try/catch 隔离 + 健康状态机（有 shard 连续失败 → degraded）+
 * 模块级 metric（唯一所有者，供 /metrics 暴露）。
 *
 * **调用契约**：每个 shard db 都必须是该 shard 的 root/admin DB（runMediaRetention 在其上全局扫该 shard
 * 所有租户的过期引用；误传 TenantDatabase 会被改写成单租户扫描）。单库下 `allShardDbs()=[db]`，等价现状。
 */

import type { Logger } from '../../utils/logger.js';
import type { ObjectStorageClient } from '../../privacy/object-storage-client.js';
import type { TenantDbResolver } from '../../storage/tenant-db-resolver.js';
import { makeShardKeyer } from '../../storage/shard-key.js';
import { runMediaRetention, type ObjectStorageEraser } from './media-ref-store.js';

const LAYER = 'MediaRetentionWorker';

/**
 * 模块级 media retention 可观测状态（**唯一所有者**）。
 *
 * 分片 fan-out 下需要跨进程可读的「坏 shard 计数 / 降级状态」供 /metrics 暴露。所有权定死：
 *   - **worker.flushOnce 是唯一写方**（失败 shard-run 累加 shardEraseFailures；set degraded=isHealthy 取反）；
 *   - **registerMetricsRoutes 只读它**（绝不把 worker 实例传进 route，避免第二来源/生命周期耦合）。
 * 与 billingMetrics 同款模块级形态（内存计数器，非函数），Prometheus/JSON 直接读这些字段。
 */
export const mediaRetentionMetrics = {
  /* shard 整体擦除失败累计（shard 抛错 或 该 shard runMediaRetention 返 failed>0 都记一次；可告警）。 */
  shardEraseFailures: 0,
  /* 降级 gauge：0=健康，1=降级（有 shard 处于连续失败态）。worker 每轮 flush 后 set。 */
  degraded: 0,
};

/**
 * 把 ObjectStorageClient 适配成 ObjectStorageEraser——GDPR Art.17 物理删除真实闭环。
 *
 * ObjectStorageClient.delete 各后端（local/S3/GCS/Azure）已实现且幂等（对象不存在视为成功），
 * 正符合 ObjectStorageEraser 契约。真实 IO 错误（网络/权限/SDK 未装）由 delete 抛出 → runMediaRetention
 * 计 failed、保留引用行下周期重试（fail-closed，不造孤儿）。
 */
export class ObjectStorageClientEraser implements ObjectStorageEraser {
  constructor(private readonly client: ObjectStorageClient) {}
  async erase(objectKey: string): Promise<void> {
    await this.client.delete(objectKey);
  }
}

export interface MediaRetentionOptions {
  intervalMs: number;
}

const DEFAULT_OPTIONS: MediaRetentionOptions = {
  /* 每 6 小时一次——与其它 retention worker 同节奏；过期媒体清理不需更频繁。 */
  intervalMs: 6 * 60 * 60 * 1000,
};

/**
 * 默认对象存储擦除器：**fail-closed**（未配置真实对象存储删除能力时抛错）。
 *
 * ⚠️ 绝不能用「成功的 no-op」做默认（Codex Critical）：runMediaRetention 在 `erase()` resolve 后
 * **立即删引用行**——若 erase 是假成功的 no-op，则 DB 行（含 object_key 定位）被删而真实对象仍在，
 * 原始媒体变成**不可追踪的孤儿，永远无法补删**（比不跑 worker 更糟：不跑至少保留定位）。
 *
 * 故默认 erase **抛错** → runMediaRetention 计入 failed、**保留引用行**（含 object_key）→ 下周期重试。
 * 真实 S3/R2/minio 删除能力在部署期注入（替换本默认）。这样：未配对象存储删除 = 行保留可重试（无孤儿、
 * GDPR-pending 可见可补做）；接了真实 driver = 正常删对象 + 删行闭环。
 */
export class FailClosedObjectStorageEraser implements ObjectStorageEraser {
  constructor(private readonly logger: Logger) {}
  async erase(objectKey: string): Promise<void> {
    this.logger.warn(LAYER, `对象存储删除能力未配置，跳过删除并保留引用行待重试（绝不删定位造孤儿）: ${objectKey}`);
    throw new Error('object storage eraser not configured: keeping media ref for retry (fail-closed)');
  }
}

/** 单个 shard 的连续失败追踪（供健康状态机判定 degraded）。 */
interface ShardFailureState {
  consecutiveFailures: number;
  lastFailureAt: number;
}

/** flushOnce 聚合结果：跨 shard 求和 + 逐 shard 错误明细（保留 totalFailed + per-shard，供告警/诊断）。 */
export interface MediaFlushResult {
  totalErased: number;
  totalFailed: number;
  shardErrors: Array<{ shardKey: string; error: string }>;
}

export class MediaRetentionWorker {
  private readonly options: MediaRetentionOptions;
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;
  /* shard db → 稳定 key（首见顺序 shard#N，绑实例身份），供 metric label / shardErrors 定位坏 shard。 */
  private readonly keyer = makeShardKeyer();
  /* 处于连续失败态的 shard（成功即删）。非空 → 降级；健康状态机的唯一真值来源。 */
  private readonly shardFailures = new Map<string, ShardFailureState>();

  constructor(
    private readonly resolver: TenantDbResolver,
    private readonly eraser: ObjectStorageEraser,
    private readonly logger: Logger,
    private readonly now: () => number = () => Date.now(),
    options: Partial<MediaRetentionOptions> = {},
  ) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.running) return;
      this.running = true;
      this.flushOnce()
        .then((r) => {
          /* 强制告警（非「决定」）：有任一 shard 失败就记 error，防坏 shard 静默漏擦。 */
          if (r.shardErrors.length > 0 || r.totalFailed > 0) {
            this.logger.error(LAYER, '媒体 retention 有 shard 清理失败（下周期重试）', {
              totalFailed: r.totalFailed,
              shardErrors: r.shardErrors,
            });
          }
        })
        .catch((err) => this.logger.error(LAYER, '媒体 retention 清理失败', err as Error))
        .finally(() => { this.running = false; });
    }, this.options.intervalMs);
    this.timer.unref?.();
    this.logger.info(LAYER, `启动媒体 retention worker（每 ${this.options.intervalMs}ms 运行）`);
  }

  /** 健康 = timer 已 start 且无 shard 处于连续失败态（保 timer 生命周期语义：未 start/stop 后恒 false）。 */
  isHealthy(): boolean {
    return this.timer !== undefined && this.shardFailures.size === 0;
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
   * 显式触发一次清理（运维/测试用；timer 回调也走此路径）。
   *
   * 跨所有 shard fan-out（GDPR Art.17：非-home shard 的过期媒体也必须物理删）：逐 shard try/catch 隔离——
   * 某 shard 抛错（如 DB 连接坏）只记入 shardErrors、不拖累其余 shard；某 shard runMediaRetention 返
   * failed>0（对象存储 IO 故障、引用行已保留待重试）也计为该 shard 失败。两种失败都：recordFailure +
   * shardEraseFailures++ + logger.error；成功则 recordSuccess（清该 shard 失败态）。最后 set degraded gauge。
   */
  async flushOnce(): Promise<MediaFlushResult> {
    let totalErased = 0;
    let totalFailed = 0;
    const shardErrors: Array<{ shardKey: string; error: string }> = [];

    for (const shardDb of this.resolver.allShardDbs()) {
      const shardKey = this.keyer(shardDb);
      try {
        const { erased, failed } = await runMediaRetention(shardDb, this.eraser, this.now());
        totalErased += erased;
        totalFailed += failed;
        if (failed > 0) {
          /* runMediaRetention 内部已隔离单对象失败并保留引用行；此处按 shard 级失败告警。 */
          this.recordFailure(shardKey);
          mediaRetentionMetrics.shardEraseFailures++;
          this.logger.error(LAYER, `shard ${shardKey} 媒体擦除部分失败（引用行保留下周期重试）`, { failed });
        } else {
          this.recordSuccess(shardKey);
        }
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        shardErrors.push({ shardKey, error });
        this.recordFailure(shardKey);
        mediaRetentionMetrics.shardEraseFailures++;
        this.logger.error(LAYER, `shard ${shardKey} 媒体 retention 整体失败（隔离，不拖累其余 shard）`, { error });
      }
    }

    /* 唯一写方：worker flushOnce 更新模块级 degraded gauge（isHealthy 取反）。 */
    mediaRetentionMetrics.degraded = this.isHealthy() ? 0 : 1;
    return { totalErased, totalFailed, shardErrors };
  }

  /** 记该 shard 一次失败（累加连续失败次数 + 记时刻）。 */
  private recordFailure(shardKey: string): void {
    const prev = this.shardFailures.get(shardKey);
    this.shardFailures.set(shardKey, {
      consecutiveFailures: (prev?.consecutiveFailures ?? 0) + 1,
      lastFailureAt: this.now(),
    });
  }

  /** 该 shard 本轮成功 → 清失败态（连续失败链断开，恢复健康）。 */
  private recordSuccess(shardKey: string): void {
    this.shardFailures.delete(shardKey);
  }
}
