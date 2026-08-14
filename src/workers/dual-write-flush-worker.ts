/**
 * persona_core dual-write outbox flush worker（把 persona_core_ledger_outbox 落进 SqliteEventLedger）。
 *
 * **分片 fan-out（Plan 2 · Task 2）**：persona_core_ledger_outbox 是 per-shard 表——每个 shard 各自积压
 * 待落 ledger 的事件。旧 worker 只对一个中心 db 构造一个 SqliteEventLedger 并 flush 一次，多 shard 部署下：
 *   ① 非-home shard 的 outbox 永不被 drain（事件永远卡在 outbox，ledger 缺失）；
 *   ② 若复用同一个中心 ledger 去 flush 别 shard 的 outbox，会把 A shard 的 outbox 行写进**中心 ledger
 *      库**——跨 shard 串写（数据落错 shard，违分片铁律）。
 *
 * 故 ctor 收 `TenantDbResolver`，flush 遍历 `allShardDbs()`：**循环内、每个 shard 现构造
 * `new SqliteEventLedger(shardDb)`**——令「outbox 源库」与「ledger 目标库」恒为同一个 shardDb，绝不跨 shard
 * 串写（本 task 的唯一核心正确性）。逐 shard try/catch 隔离：某 shard 抛错（DB 连接坏）只记入 shardErrors、
 * 不拖累其余 shard、不整体崩。单库下 `allShardDbs()=[db]`，等价现状。
 */

import { personaCoreDualWrite } from '../data-plane/persona-core-dual-write.js';
import { SqliteEventLedger } from '../data-plane/sqlite-event-ledger.js';
import { makeShardKeyer } from '../storage/shard-key.js';
import type { TenantDbResolver } from '../storage/tenant-db-resolver.js';
import type { Logger } from '../utils/logger.js';

const LAYER = 'DualWriteFlushWorker';

export interface DualWriteFlushWorkerOptions {
  resolver: TenantDbResolver;
  intervalMs?: number;
  logger?: Logger;
}

/** flush 聚合结果：跨 shard 求和 + 逐 shard 错误明细（error 为 message string，非 Error 对象）。 */
export interface DualWriteFlushResult {
  totalFlushed: number;
  totalFailed: number;
  shardErrors: Array<{ shardKey: string; error: string }>;
}

export class DualWriteFlushWorker {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly intervalMs: number;
  /* shard db → 稳定 key（首见顺序 shard#N，绑实例身份），供 shardErrors 定位坏 shard。 */
  private readonly keyer = makeShardKeyer();

  constructor(private readonly opts: DualWriteFlushWorkerOptions) {
    this.intervalMs = opts.intervalMs ?? 5000;
  }

  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => {
      void this.flush().catch(err => {
        this.opts.logger?.error(
          LAYER,
          'persona_core outbox flush failed',
          { error: err instanceof Error ? err.message : String(err) },
        );
      });
    }, this.intervalMs);
  }

  stop(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * 跨所有 shard fan-out drain persona_core_ledger_outbox。
   *
   * 每个 shard：`new SqliteEventLedger(shardDb)`（源库=ledger 库同一 shardDb，防跨 shard 串写）→
   * `flushOutbox(shardDb, ledger)` 累加 flushed/failed。逐 shard try/catch：某 shard 抛错只记 shardErrors +
   * logger.error（error 转 message string），好 shard 仍 flush（不整体崩）。
   */
  async flush(): Promise<DualWriteFlushResult> {
    let totalFlushed = 0;
    let totalFailed = 0;
    const shardErrors: Array<{ shardKey: string; error: string }> = [];

    for (const shardDb of this.opts.resolver.allShardDbs()) {
      const shardKey = this.keyer(shardDb);
      try {
        /* 循环内每 shard 现构造：源库=ledger 库同一 shardDb，绝不复用中心 ledger（防串写核心）。 */
        const ledger = new SqliteEventLedger(shardDb);
        const { flushed, failed } = await personaCoreDualWrite.flushOutbox(shardDb, ledger);
        totalFlushed += flushed;
        totalFailed += failed;
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        shardErrors.push({ shardKey, error });
        this.opts.logger?.error(
          LAYER,
          `shard ${shardKey} outbox flush 整体失败（隔离，不拖累其余 shard）`,
          { error },
        );
      }
    }

    this.opts.logger?.info(LAYER, 'persona_core outbox flush complete', {
      totalFlushed,
      totalFailed,
      shardErrors,
    });
    return { totalFlushed, totalFailed, shardErrors };
  }
}
