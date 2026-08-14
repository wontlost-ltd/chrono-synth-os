/**
 * 多-shard 验收脚手架（测试专用）。实现 TenantDbResolver，用多个独立物理 db 断言分片路由分流。
 * 「铺路不激活」子片唯一能真正验证正确性的手段：单库下 dbForTenant 与 coordinatorDb 是同一 db，
 * 普通功能测试证不出路由对错；本 Fake 注独立 db，让「数据真落对 shard」可断言。
 * allShardDbs 去重语义与真实 ShardRouter 对齐（按实例身份去重、稳定顺序）。
 */
import type { IDatabase } from '../../storage/database.js';
import type { TenantDbResolver } from '../../storage/tenant-db-resolver.js';

export interface FakeShardConfig {
  readonly coordinator: IDatabase;
  /** shardId → 该 shard 的独立 db 实例。 */
  readonly shards: Record<string, IDatabase>;
  /** tenantId → shardId 映射。未映射的 tenantId 调 dbForTenant 抛错（防测试疏漏静默走错）。 */
  readonly tenantToShard: Record<string, string>;
  /**
   * 未映射 tenantId 的回退 shardId（可选）。缺省时未映射即抛（防测试疏漏）。
   *
   * 真实 `ShardRouter.dbForTenant` 对任意 tenantId 一致性哈希路由、**永不因未知租户抛错**——register
   * 会为全新随机 tenantId 立即 dbForTenant 落 shard。需在「注册后才知 tenantId」的测试（如 injection-chain）
   * 里模拟这一语义时，用本字段给未映射租户一个确定性默认 shard，与真实路由的「新租户即可路由」对齐。
   */
  readonly defaultShardId?: string;
}

export class FakeMultiShardResolver implements TenantDbResolver {
  constructor(private readonly cfg: FakeShardConfig) {}

  dbForTenant(tenantId: string): IDatabase {
    const shardId = this.cfg.tenantToShard[tenantId] ?? this.cfg.defaultShardId;
    if (!shardId) throw new Error(`FakeMultiShardResolver: tenantId '${tenantId}' 无 shard 映射（测试须显式声明或设 defaultShardId）`);
    const db = this.cfg.shards[shardId];
    if (!db) throw new Error(`FakeMultiShardResolver: shardId '${shardId}' 无 db`);
    return db;
  }

  coordinatorDb(): IDatabase {
    return this.cfg.coordinator;
  }

  allShardDbs(): IDatabase[] {
    /* 按实例身份去重、稳定顺序（与真实 ShardRouter 按 connStr 去重语义对齐——此处实例即身份）。 */
    const seen = new Set<IDatabase>();
    const out: IDatabase[] = [];
    for (const db of Object.values(this.cfg.shards)) {
      if (seen.has(db)) continue;
      seen.add(db);
      out.push(db);
    }
    return out;
  }
}
