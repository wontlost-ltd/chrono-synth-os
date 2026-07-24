/**
 * shard 稳定标识符工厂（分片 Phase 0 · Plan 2 公共工具，全 Plan 复用）。
 *
 * 跨 shard fan-out（如 MediaRetention/BillingOutbox）在记录「哪个 shard 失败」时，需要一个**稳定、
 * 确定性、与 db 实例绑定**的短标识——不能用数组下标（allShardDbs() 去重/顺序变动会漂移），也不能
 * 用连接串（测试用内存 db 无有意义连接串，且暴露连接串到 metric label 有泄露风险）。
 *
 * `makeShardKeyer` 返回一个闭包：对同一 IDatabase 实例恒返回同一 key（`shard#0/shard#1/...`，按**首见
 * 顺序**分配单调递增序号）。用 WeakMap 绑定实例身份——db 实例被回收时 key 自动释放，不泄内存。
 * 每个 worker 持有自己的 keyer 实例（`private keyer = makeShardKeyer()`）：同一 worker 内 key 稳定，
 * 不同 worker 之间互不干扰（各自从 shard#0 起编号，label 语义局限在单个 worker 的可观测视角内）。
 */

import type { IDatabase } from './database.js';

/**
 * 建一个 shard 键分配器：对每个首见的 IDatabase 实例按顺序分配 `shard#N`，同一实例后续调用恒返回同键。
 * key 绑定实例身份（WeakMap），非连接串/下标——去重、顺序稳定、无内存泄漏。
 */
export function makeShardKeyer(): (db: IDatabase) => string {
  const keys = new WeakMap<IDatabase, string>();
  let next = 0;
  return (db: IDatabase): string => {
    let key = keys.get(db);
    if (key === undefined) {
      key = `shard#${next++}`;
      keys.set(db, key);
    }
    return key;
  };
}
