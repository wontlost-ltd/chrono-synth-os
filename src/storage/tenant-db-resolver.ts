/**
 * 租户 → shard DB 解析器契约（分片地基 Phase -1）。
 *
 * 分片的统一入口：所有「显式 tenant_id 访问」都应经 `dbForTenant(tenantId)` 取正确 shard 的 db，
 * 而非直接拿裸 `os.getDatabase()`（后者多 shard 下会读写 host DB=错 shard）。平台级表经 `coordinatorDb()`，
 * 跨租户 fan-out 经 `allShardDbs()`。
 *
 * Phase -1 只交契约 + 单库适配器（`SingleDbResolver`：三方法都返回同一 db，行为等价现状，不启用多库）。
 * 真 shard 路由（一致性哈希 + per-shard 池）是 Phase 0 的 `ShardRouter`，本接口是其契约。
 */

import type { IDatabase } from './database.js';

/** 租户 → shard DB 解析契约。所有显式 tenant_id 访问的唯一入口。 */
export interface TenantDbResolver {
  /** 取该租户所在 shard 的 db（单库下恒返回同一 db）。 */
  dbForTenant(tenantId: string): IDatabase;
  /** 取协调库（平台级表 / shard map；单库下=同一 db）。 */
  coordinatorDb(): IDatabase;
  /** 取所有 shard db（供跨租户 fan-out scatter-gather；单库下=[db]）。 */
  allShardDbs(): IDatabase[];
}

/** 单库适配器：三方法都返回构造时传入的同一个 db。等价现状，零回归。 */
export class SingleDbResolver implements TenantDbResolver {
  constructor(private readonly db: IDatabase) {}

  dbForTenant(_tenantId: string): IDatabase {
    return this.db;
  }

  coordinatorDb(): IDatabase {
    return this.db;
  }

  allShardDbs(): IDatabase[] {
    return [this.db];
  }
}
