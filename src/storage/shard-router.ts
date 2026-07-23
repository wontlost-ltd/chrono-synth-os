/**
 * ShardRouter（分片地基 Phase 0）——实现 Phase -1 的 TenantDbResolver 契约。
 *
 * 按 tenantId 确定性模哈希路由到对应 shard 的 IDatabase;per-shard 懒建连接池,**按 connStr 去重缓存**
 * （同 shard 多租户共享一池,不按 tenant——防连接爆;coordinator 与某 shard 用同一 connStr 时也自动复用同实例）。
 * default 租户钉显式 homeShardId。
 * ShardRouter 是**自建**池的 owner:幂等 close、init 失败回收、共享实例只关一次。
 *
 * ⚠️ borrowed 例外：`seedDbs` 预填的 db（由外部建好、外部拥有,如 Plan 3 typed bundle 复用已建的
 * hostDb）不受本类 close 管辖——router 只借用,不关闭、不在 initialize 失败回收时误关。
 * owned（buildDb 建的）与 borrowed（seedDbs 预填的）按 connStr 区分,详见 `owned` 集合。
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
  /** 按 connStr 预填的外部已建 db（borrowed——外部拥有,router 借用不 close）。供 Plan 3 typed bundle 复用已建 hostDb。 */
  readonly seedDbs?: Record<string, IDatabase>;
}

export class ShardRouter implements TenantDbResolver {
  private readonly shards: Record<string, string>;
  private readonly homeShardId: string;
  private readonly coordinatorConnStr: string;
  private readonly buildDb: (connStr: string) => IDatabase;
  /* 按 connStr 缓存 db（connStr 是 db 身份的稳定键——coordinator==某 shard 时自动复用同实例,防重复池/重复 close）。 */
  private readonly byConnStr = new Map<string, IDatabase>();
  /* owned：本 router 通过 buildDb 建的 connStr 集合——只有这些在 close()/init 失败回收时被关。
     seedDbs 预填的 connStr 不进这个集合 → borrowed,close() 略过。 */
  private readonly owned = new Set<string>();
  private closed = false;

  constructor(cfg: ShardRouterConfig) {
    if (!(cfg.homeShardId in cfg.shards)) {
      throw new Error(`ShardRouter: homeShardId '${cfg.homeShardId}' 不在 shards 中`);
    }
    this.shards = cfg.shards;
    this.homeShardId = cfg.homeShardId;
    this.coordinatorConnStr = cfg.coordinatorConnStr ?? cfg.shards[cfg.homeShardId]!;
    this.buildDb = cfg.buildDb;
    for (const [connStr, db] of Object.entries(cfg.seedDbs ?? {})) {
      this.byConnStr.set(connStr, db);  // 预填,不加入 owned → borrowed
    }
  }

  private dbForConn(connStr: string): IDatabase {
    let db = this.byConnStr.get(connStr);
    if (!db) {
      db = this.buildDb(connStr);
      this.byConnStr.set(connStr, db);
      this.owned.add(connStr);  // buildDb 建的 → owned,close() 时负责关闭
    }
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
    /* 返唯一物理 db：两 shardId 映射同一 connStr 时只出现一次（防 fan-out 消费方对同库重复执行）。
     * 按 shards 声明顺序取首次出现，稳定顺序。 */
    const seen = new Set<string>();
    const out: IDatabase[] = [];
    for (const connStr of Object.values(this.shards)) {
      if (seen.has(connStr)) continue;
      seen.add(connStr);
      out.push(this.dbForConn(connStr));
    }
    return out;
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

  /** 幂等关闭所有 owned 缓存 db（按 connStr 去重 → 共享实例只关一次）；borrowed（seedDbs 预填）不关。 */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const connStr of this.owned) {
      const db = this.byConnStr.get(connStr);
      if (!db) continue;
      try { db.close(); } catch { /* 关闭失败不阻断其余 */ }
    }
    this.byConnStr.clear();
    this.owned.clear();
  }
}
