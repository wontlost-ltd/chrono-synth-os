/**
 * SCIM 租户目录（token → tenant 定位）。
 *
 * 分片 Phase 0 · Plan 1b（Task 6）：从 `TenantEnterpriseProfileService` 拆出 **mixed-scope** 的
 * SCIM token 读写——`resolveScimTenant(token)` 无 tenantId 入参（token 本身即定位符），是「先有 token
 * 才能定位 tenant」的反查路径，不属于「已知 tenantId」的 tenant-scoped 服务范畴。
 *
 * **过渡实现（Plan 1b 单库）**：ctor 收 `TenantDbResolver`，token 存/查暂经 `resolver.coordinatorDb()`
 * ——单库下 coordinatorDb 与 dbForTenant 同一 db，行为等价现状、零回归。**不 `new SingleDbResolver` 回退**。
 * **真跨 shard 目录一致性**（token 落哪个 shard、全局唯一性、跨 shard resolve）= Plan 1c 替换本类实现，
 * `registerScimRoutes` 注入的接口稳定不变（route 契约不改，只换实现）。故本类 edge 保持 `planned`。
 */

import { createHash } from 'node:crypto';
import type { TenantDbResolver } from '../storage/tenant-db-resolver.js';
import {
  tprofQueryByScimToken,
  tprofQueryByTenant,
  tprofCmdUpdateScimToken,
  tprofCmdInsertWithScimToken,
} from '@chrono/kernel';
import { registerCoreSelfExecutors } from '../storage/executors/index.js';

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export class ScimTenantDirectory {
  constructor(private readonly resolver: TenantDbResolver) {
    registerCoreSelfExecutors();
  }

  /**
   * 存/轮换某租户的 SCIM token（哈希后落库）。
   *
   * 过渡：经 coordinatorDb（单库=host db）。已有 profile 行则 UPDATE token 哈希，否则 INSERT。
   */
  storeScimToken(tenantId: string, token: string): void {
    const db = this.resolver.coordinatorDb();
    const existing = db.queryOne(tprofQueryByTenant(tenantId));
    const now = Date.now();
    const tokenHash = hashToken(token);
    if (existing) {
      db.execute(tprofCmdUpdateScimToken({ tenantId, tokenHash, now }));
      return;
    }
    db.execute(tprofCmdInsertWithScimToken({ tenantId, tokenHash, now }));
  }

  /**
   * 由 SCIM Bearer token 反查所属租户（token→tenant，无 tenantId 入参——mixed-scope）。
   *
   * 过渡：经 coordinatorDb（单库=host db）。哈希 token 后按 scim_token_hash 唯一命中一行。
   * **诚实边界**：单库下 token 全局唯一即可正确定位；真多 shard 下 token 目录一致性 = Plan 1c。
   */
  resolveScimTenant(token: string): { tenantId: string } | null {
    const row = this.resolver.coordinatorDb().queryOne(tprofQueryByScimToken(hashToken(token)));
    if (!row) return null;
    return { tenantId: row.tenant_id };
  }
}
