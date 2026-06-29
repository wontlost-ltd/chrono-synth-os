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
 * **调用契约**：tx 必须是 root/admin DB（runMediaRetention 全局扫所有租户过期引用；误传 TenantDatabase
 * 会被改写成单租户扫描 → 其他租户媒体永不清理）。app.ts 用 root tx 构造。
 */

import type { SyncWriteUnitOfWork } from '@chrono/kernel';
import type { Logger } from '../../utils/logger.js';
import type { ObjectStorageClient } from '../../privacy/object-storage-client.js';
import { runMediaRetention, type ObjectStorageEraser } from './media-ref-store.js';

const LAYER = 'MediaRetentionWorker';

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

export class MediaRetentionWorker {
  private readonly options: MediaRetentionOptions;
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;

  constructor(
    private readonly tx: SyncWriteUnitOfWork,
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
        .catch((err) => this.logger.error(LAYER, '媒体 retention 清理失败', err as Error))
        .finally(() => { this.running = false; });
    }, this.options.intervalMs);
    this.timer.unref?.();
    this.logger.info(LAYER, `启动媒体 retention worker（每 ${this.options.intervalMs}ms 运行）`);
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

  /** 显式触发一次清理（运维/测试用）；返回擦除/失败计数。 */
  async flushOnce(): Promise<{ erased: number; failed: number }> {
    const result = await runMediaRetention(this.tx, this.eraser, this.now());
    if (result.erased > 0 || result.failed > 0) {
      this.logger.info(LAYER, `媒体 retention：已擦除 ${result.erased} 个过期引用，失败 ${result.failed} 个（下周期重试）`);
    }
    return result;
  }
}
