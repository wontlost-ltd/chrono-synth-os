/**
 * 端侧 kernel 运行证明（ADR-0052 Edge-P2）。
 *
 * 用端侧确定性 host adapter（DeterministicClock/Random + InMemoryValueUnitOfWork，**零 node:***）
 * 驱动**真实的 kernel value-service 纯函数**跑一条人格价值状态闭环：创建价值 → 更新权重 → 读回 →
 * 删除。证明 `@chrono/kernel` 的领域逻辑能在非 Node、非 SQLite 的端侧存储上运行——可移植性从
 * 「架构承诺」变成「可跑 + 可 golden replay 的证明」。
 *
 * 这是 ADR-0001 可移植承诺的首个真实兑现：kernel 只经注入的 ports 触达存储/时钟/随机，不依赖任何
 * Node 全局。真浏览器 Worker harness（vite/worker 打包）是后续打包基建工作；本证明在 Node test 中
 * 用端侧 adapter 跑同一套 kernel 代码，等价地证明「无 Node 依赖 + 确定性」。
 */

import { createValue, updateValue, getAllValues, deleteValue, type CoreValue } from '@chrono/kernel';
import { DeterministicClock, DeterministicRandom } from './host/deterministic-host.js';
import { InMemoryValueUnitOfWork } from './host/in-memory-value-uow.js';

/** 一次闭环运行的产物（供 golden 比对）。 */
export interface RuntimeProofResult {
  /** 最终所有价值（确定性序）。 */
  readonly values: readonly CoreValue[];
  /** 存储确定性指纹。 */
  readonly hash: string;
}

/**
 * 跑一条确定性价值闭环。同一 (clock 起点, random 种子, 操作脚本) → 同一结果（golden replay）。
 * 操作脚本固定，证明 kernel value-service 在端侧 adapter 上行为确定。
 */
export function runValueClosedLoop(): RuntimeProofResult {
  const tx = new InMemoryValueUnitOfWork();
  const clock = new DeterministicClock(1_000, 1_000);
  const random = new DeterministicRandom('edge');

  /* ① 创建三个核心价值（kernel 纯函数 + 端侧 adapter）。 */
  const explore = createValue(tx, clock, random, '探索', 0.5);
  createValue(tx, clock, random, '稳定', 0.6);
  createValue(tx, clock, random, '联结', 0.4);

  /* ② 更新一个权重（部分 patch）。 */
  updateValue(tx, clock, explore.id, { weight: 0.55 });

  /* ③ 删除一个。 */
  const stable = [...getAllValues(tx).values()].find((v) => v.label === '稳定');
  if (stable) deleteValue(tx, stable.id);

  /* ④ 读回最终状态。 */
  const values = [...getAllValues(tx).values()];
  return { values, hash: tx.snapshotHash() };
}
