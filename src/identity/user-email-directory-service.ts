/**
 * 用户 email 目录（全局 email 唯一性 → 更新用户 email）。
 *
 * 分片 Phase 0 · Plan 1b（Task 7）：从 `UserProfileService` 拆出 **mixed-scope** 的 `updateEmail`——
 * users 表的 email 列全局唯一（v013 `unique` + `idx_users_email` 唯一索引，**非**按 tenant scope），
 * 故唯一性冲突检查（`uprofQueryByEmailExclude`：`WHERE email=? AND id!=?`）跨所有租户成立，是「先有
 * email 才能判唯一」的全局约束，不属于「已知 tenantId」的 tenant-scoped 服务范畴。
 *
 * **过渡实现（Plan 1b 单库）**：ctor 收 `TenantDbResolver`，email 唯一性检查/更新/取回 profile 暂经
 * `resolver.coordinatorDb()`——单库下 coordinatorDb 与 dbForTenant 同一 db，行为等价现状、零回归。
 * **不 `new SingleDbResolver` 回退**。**真跨 shard 目录写一致性**（email 全局唯一性在多 shard 下如何
 * 保证：目录表 / 分布式唯一约束）= Plan 1c 替换本类实现，`/users/me` route 注入的接口稳定不变（route
 * 契约不改，只换实现）。故本类 edge 保持 `planned`。
 */

import type { TenantDbResolver } from '../storage/tenant-db-resolver.js';
import {
  uprofQueryByIdGlobal, uprofQueryByEmailExclude, uprofCmdUpdateEmail,
} from '@chrono/kernel';
import type { UserProfileSummaryRow } from '@chrono/kernel';
import { AuthenticationError, ValidationError, ErrorCode } from '../errors/index.js';
import { registerCoreSelfExecutors } from '../storage/executors/index.js';

function userToProfile(row: UserProfileSummaryRow) {
  return {
    userId: row.id,
    email: row.email,
    role: row.role,
    tenantId: row.tenant_id,
    createdAt: new Date(Number(row.created_at)).toISOString(),
  };
}

export class UserEmailDirectoryService {
  constructor(private readonly resolver: TenantDbResolver) {
    registerCoreSelfExecutors();
  }

  /**
   * 更新某用户的 email（全局唯一性检查后落库，返回更新后的 profile）。
   *
   * 无 tenantId 入参——email 全局唯一性是跨租户的目录级约束（mixed-scope）。
   * 过渡：经 coordinatorDb（单库=host db，行为不变）。
   * **诚实边界**：单库下 email 全局唯一即可正确判冲突；真多 shard 下目录写一致性 = Plan 1c。
   */
  updateEmail(userId: string, email: string) {
    const db = this.resolver.coordinatorDb();
    const existing = db.queryOne(uprofQueryByEmailExclude(email, userId));
    if (existing) {
      throw new ValidationError('该邮箱已被使用', ErrorCode.AUTH_EMAIL_EXISTS);
    }
    db.execute(uprofCmdUpdateEmail({ userId, email, now: Date.now() }));
    const row = db.queryOne(uprofQueryByIdGlobal(userId));
    if (!row) throw new AuthenticationError('用户不存在', ErrorCode.AUTH_INVALID_TOKEN);
    return userToProfile(row);
  }
}
