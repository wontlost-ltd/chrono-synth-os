/**
 * ShardRouter（分片地基 Phase 0）——实现 Phase -1 的 TenantDbResolver 契约。
 *
 * 按 tenantId 确定性模哈希路由到对应 shard 的 IDatabase;per-shard 懒建连接池,**按 connStr 去重缓存**
 * （同 shard 多租户共享一池,不按 tenant——防连接爆;coordinator 与某 shard 用同一 connStr 时也自动复用同实例）。
 * default 租户钉显式 homeShardId。
 * ShardRouter 是这些池的**唯一 owner**:幂等 close、init 失败回收、共享实例只关一次。
 *
 * ⚠️ 生产多 shard activation 由上层 fail-closed 挡（任何非空 db.shards 拒绝生产启动,见 createDatabase guard）——
 * 本类是可单测的引擎,测试注入 config 直构。
 */

import type { IDatabase } from './database.js';
import type { TenantDbResolver } from './tenant-db-resolver.js';
import { shardIdForTenant } from './shard-hash.js';

export interface ShardRouterConfig {
  readonly shards: Record<string, string>;
  readonly homeShardId: string;
  readonly coordinatorConnStr?: string;
  readonly buildDb: (connStr: string) => IDatabase;
}

export class ShardRouter implements TenantDbResolver {
  private readonly shards: Record<string, string>;
  private readonly homeShardId: string;
  private readonly coordinatorConnStr: string;
  private readonly buildDb: (connStr: string) => IDatabase;
  /* 按 connStr 缓存 db（connStr 是 db 身份的稳定键——coordinator==某 shard 时自动复用同实例,防重复池/重复 close）。 */
  private readonly byConnStr = new Map<string, IDatabase>();
  private closed = false;

  constructor(cfg: ShardRouterConfig) {
    if (!(cfg.homeShardId in cfg.shards)) {
      throw new Error(`ShardRouter: homeShardId '${cfg.homeShardId}' 不在 shards 中`);
    }
    this.shards = cfg.shards;
    this.homeShardId = cfg.homeShardId;
    this.coordinatorConnStr = cfg.coordinatorConnStr ?? cfg.shards[cfg.homeShardId]!;
    this.buildDb = cfg.buildDb;
  }

  private dbForConn(connStr: string): IDatabase {
    let db = this.byConnStr.get(connStr);
    if (!db) { db = this.buildDb(connStr); this.byConnStr.set(connStr, db); }
    return db;
  }

  dbForTenant(tenantId: string): IDatabase {
    const shardId = tenantId === 'default'
      ? this.homeShardId
      : shardIdForTenant(tenantId, Object.keys(this.shards));
    return this.dbForConn(this.shards[shardId]!);
  }

  coordinatorDb(): IDatabase {
    return this.dbForConn(this.coordinatorConnStr);
  }

  allShardDbs(): IDatabase[] {
    return Object.values(this.shards).map((c) => this.dbForConn(c));
  }

  /** 预建+预迁移所有 shard + 协调库（生产启动预热,避免懒建同步迁移阻塞首请求）。中途失败回收已建。 */
  initialize(): void {
    try {
      for (const connStr of Object.values(this.shards)) this.dbForConn(connStr);
      this.dbForConn(this.coordinatorConnStr);
    } catch (err) {
      this.close();  // init 失败回收已建的池,不半泄漏
      throw err;
    }
  }

  /** 幂等关闭所有缓存 db（按 connStr 去重 → 共享实例只关一次）。 */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const db of this.byConnStr.values()) {
      try { db.close(); } catch { /* 关闭失败不阻断其余 */ }
    }
    this.byConnStr.clear();
  }
}
