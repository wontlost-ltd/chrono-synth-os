/** 组合根建唯一 TenantDbResolver：单库 SingleDbResolver（零回归）/ 多库 fail-closed throw。
 * 本 Plan 生产仍 fail-closed 挡多库（createDatabase guard 未放开）；多库分支供 Plan 1 测试 + Plan 3 放开复用。 */
import type { AppConfig } from '../config/schema.js';
import type { IDatabase } from './database.js';
import type { TenantDbResolver } from './tenant-db-resolver.js';
import { SingleDbResolver } from './tenant-db-resolver.js';
// 注：Plan 1 buildResolver 多库直接 throw，不 import/构造 ShardRouter（noUnusedLocals）——ShardRouter.seedDbs 在 Task 1b 单测里用。

/** 多库尚未就绪（Plan 3 typed bundle 携 verified identity 构造）——fail-closed。 */
export class MultiShardRuntimeNotReadyError extends Error {
  constructor() {
    super('多库 runtime 未就绪（Plan 3 放开）——仅支持单库；多库须经 typed bundle');
  }
}

/** 唯一放开门真源（Codex 第 3 轮 #1——createDatabase/buildResolver/createApp 都调它，删各自重复判断）。 */
export function assertShardingActivationAllowed(config: AppConfig): void {
  if (config.db.shards && Object.keys(config.db.shards).length > 0) {
    throw new MultiShardRuntimeNotReadyError();
  }
}

export function buildResolver(config: AppConfig, hostDb: IDatabase): TenantDbResolver {
  assertShardingActivationAllowed(config); // 多库 → throw（不构造 runtime）
  return new SingleDbResolver(hostDb); // 单库：三方法返同一 hostDb，零回归
}
