/**
 * 跨 shard scatter-gather 聚合原语（租户分片 Phase 0 · Plan 2 · Task 5）。
 *
 * 跨租户只读聚合（metrics）需要遍历 `resolver.allShardDbs()` 逐 shard 各查一份，再由协调层合并成一个
 * 平台级结果。合并算法**因指标而异**（diversity 全局重算 / count SUM / updated_at MAX / usage 全局
 * sort+limit），故本原语把「fan-out + 逐 shard try/catch 隔离 + 收失败 shardErrors」抽成公共骨架，
 * 把「每 shard 查什么」（perShard）与「成功结果怎么合」（merge）留给调用方——两者用**双泛型**分离：
 *  - `TShard`：单个 shard 的原始查询产物（如某 shard 的 backlog 计数、原始 style 行、原始 usage 行）；
 *  - `TData` ：协调层合并后的最终结果（如两 shard SUM 后的 backlog、全局重算的多样性、全局 sort 的 usage）。
 *
 * 坏 shard 隔离铁律（与 Task 1-3 fan-out worker 同款）：某 shard `perShard` 抛错**只记 shardErrors、
 * 不拖累其余 shard**（逐 shard try/catch），最终 merge 只吃成功 shard 的结果 → `degraded=true`。这是
 * 「partial failure 显式降级」而非「静默当零 / 整体抛」——调用方据 shardErrors 告警，data 仍是健康 shard
 * 的部分聚合。单库下 `allShardDbs()=[db]`，行为等价现状（degraded=false、无 shardErrors）。
 *
 * shardKey 由调用方注入的 `keyer`（`makeShardKeyer()`）产出：对同一 db 实例恒返稳定 `shard#N`，非数组
 * 下标（去重/顺序漂移安全）、非连接串（无泄露）。每个消费者持有自己的 keyer 实例（label 语义局限单消费者）。
 */

import type { IDatabase } from '../storage/database.js';
import type { TenantDbResolver } from '../storage/tenant-db-resolver.js';

/**
 * scatter-gather 聚合结果：合并后的 `data` + 降级标志 + 逐 shard 失败明细。
 * @typeParam TData 协调层合并后的最终结果类型。
 */
export interface ShardAggregate<TData> {
  /** 协调层合并后的最终结果（仅含成功 shard 的贡献）。 */
  readonly data: TData;
  /** 是否有 shard 失败（有→true，调用方据此暴露降级信号）。 */
  readonly degraded: boolean;
  /** 逐 shard 失败明细（稳定 shardKey + 错误信息）；无失败为空数组。 */
  readonly shardErrors: ReadonlyArray<{ readonly shardKey: string; readonly error: string }>;
}

/**
 * 遍历所有 shard，逐 shard 跑 `perShard(db)` 收集成功结果，坏 shard 记入 shardErrors（不抛），
 * 再用 `merge(成功结果[])` 合成最终 `data`。
 *
 * @typeParam TShard 单个 shard 的原始查询产物。
 * @typeParam TData  协调层合并后的最终结果。
 * @param resolver 租户→shard 解析器；`allShardDbs()` 提供跨租户 fan-out 的全 shard db（单库下=[db]）。
 * @param keyer    shard 键分配器（`makeShardKeyer()`）；对同一 db 恒返稳定 shard#N。
 * @param perShard 单 shard 查询：入参该 shard 的 db，出参该 shard 的原始产物（可能抛错→被隔离）。
 * @param merge    合并函数：入参**成功** shard 的产物数组，出参最终 data（如 SUM/全局重算/全局 sort）。
 */
export function aggregateShards<TShard, TData>(
  resolver: TenantDbResolver,
  keyer: (db: IDatabase) => string,
  perShard: (db: IDatabase) => TShard,
  merge: (results: TShard[]) => TData,
): ShardAggregate<TData> {
  const results: TShard[] = [];
  const shardErrors: Array<{ shardKey: string; error: string }> = [];

  for (const db of resolver.allShardDbs()) {
    const shardKey = keyer(db);
    try {
      results.push(perShard(db));
    } catch (err) {
      shardErrors.push({ shardKey, error: err instanceof Error ? err.message : String(err) });
    }
  }

  return { data: merge(results), degraded: shardErrors.length > 0, shardErrors };
}
