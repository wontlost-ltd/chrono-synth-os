/**
 * 用户 email 目录（全局 email 唯一性 → 更新用户 email）。
 *
 * 分片 Phase 0 · Plan 1b（Task 7）从 `UserProfileService` 拆出 **mixed-scope** 的 `updateEmail`——
 * users 表的 email 列全局唯一（v013 `unique` + `idx_users_email` 唯一索引，**非**按 tenant scope），
 * 唯一性冲突检查跨所有租户成立，是「先有 email 才能判唯一」的平台级约束，不属于「已知 tenantId」的
 * tenant-scoped 服务范畴。
 *
 * **Plan 1c（Task 9）跨库可恢复状态机**：改 email 是**跨库**写——coordinator 的 email→tenant 目录
 * （平台级唯一性）+ 该租户 shard 的 users.email 列——两者非原子。用 Task 4 的 `TenantIdentityDirectory`
 * 三方法（reserveEmailChange → shard UPDATE → completeEmailChange）状态机，配合 Task 8 恢复 worker，
 * 保证跨库崩溃窗口任一点都**不锁死**（无「新旧 email 都登不上」）：
 *
 *   1. 唯一性：`directory.resolveByEmail(canon(newEmail))` 非 null 且属**他租户** → 拒（AUTH_EMAIL_EXISTS）。
 *   2. `reserveEmailChange`：新 email 建 PENDING（operation_kind='EMAIL_CHANGE', previous=canon(oldEmail)），
 *      旧 email ACTIVE **保留不删**（同租户占用/目标已被他人占 → reserveEmailChange 内 readback 抛）。
 *   3. shard 事务：`UPDATE users SET email=canon(newEmail) WHERE tenant_id=? AND id=userId`（按
 *      `dbForTenant(tenantId)` 取对 shard，tenant-scoped predicate 防同库多租户误改）。
 *   4. `completeEmailChange`：CAS 新 email PENDING→ACTIVE 命中后才删旧 email 目录项（CAS 未命中抛错、
 *      **绝不删旧**——见门面注释）。
 *   5. 崩溃恢复：Task 8 worker 的 EMAIL_CHANGE 分支凭 **shard 权威 email** 收敛（shard==新→complete /
 *      shard==旧→rollback），**不依赖用户再调 updateEmail**。
 *
 * **login 别名语义（Codex #3.1）**：ACTIVE 目录 email 项是「允许登录的别名」——login 按目录 entry.userId
 * 取 shard user（`AuthService.login`），**绝不比较 shard 当前 user.email 与登录输入**。故步骤 3 后步骤 4
 * 前崩溃时旧 email 仍 ACTIVE、shard.email 已== 新：login(旧) 经旧 ACTIVE alias 定位到 userId → shard 按
 * userId 取到（email 已新）user → 密码对即通；login(新) 因新 email 仍 PENDING 定位不到 → 暂拒（恢复后通）。
 * **旧 email 始终可登录**，无锁死。
 *
 * `oldEmail` 从 **shard user 权威**读（非调用方传入），确保状态机以 shard 现状为基准；`operationId`
 * 确定性派生自 (tenantId, userId, canonNewEmail)——同参重试复用同一 reservation（幂等占位、不产生第二个
 * PENDING）。route 契约（`/users/me` PATCH）稳定：JWT 带 tenantId + userId(sub) + body.email。
 */

import { createHash } from 'node:crypto';
import type { TenantDbResolver } from '../storage/tenant-db-resolver.js';
import {
  uprofQueryByIdGlobal, uprofCmdUpdateEmail, authQueryUserById,
} from '@chrono/kernel';
import type { UserProfileSummaryRow } from '@chrono/kernel';
import { AuthenticationError, ValidationError, ErrorCode } from '../errors/index.js';
import { registerCoreSelfExecutors } from '../storage/executors/index.js';
import { canonicalizeEmail } from './email-canonical.js';
import { TenantIdentityDirectory } from './tenant-identity-directory.js';

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
  /** 协调库身份目录门面：email→tenant 目录 reserve/complete/resolve 全经它（Plan 1c Task 4）。 */
  private readonly directory: TenantIdentityDirectory;

  constructor(private readonly resolver: TenantDbResolver) {
    registerCoreSelfExecutors();
    this.directory = new TenantIdentityDirectory(this.resolver);
  }

  /**
   * 更新某用户的 email（跨库可恢复状态机，返回更新后的 profile）。
   *
   * @param tenantId 用户所属租户（JWT 带）——定位 shard + tenant-scoped 写 + reserveEmailChange 归属。
   * @param userId   用户 id（JWT sub）——shard user 主键 + 目录项 userId。
   * @param email    目标新 email（归一化前的原值）。
   *
   * 语义要点：
   *   - oldEmail 从 shard user 权威读（非入参）；newEmail 与 oldEmail 归一化后相等 → 幂等 no-op 返回当前 profile。
   *   - 跨租户唯一性：目标 email 已属他租户 → AUTH_EMAIL_EXISTS（步骤 1 前置门 + reserveEmailChange readback 双守）。
   *   - 跨库崩溃窗口不锁死：completeEmailChange 未命中即抛、绝不删旧（旧 ACTIVE alias 始终可 login，恢复 worker 收敛）。
   */
  updateEmail(tenantId: string, userId: string, email: string) {
    const canonNew = canonicalizeEmail(email);

    /* 步骤 0：从 shard 权威读当前 user（按 tenantId 定位对 shard、tenant-scoped 校验）。 */
    const shardDb = this.resolver.dbForTenant(tenantId);
    const user = shardDb.queryOne(authQueryUserById(userId));
    if (!user || user.tenant_id !== tenantId) {
      throw new AuthenticationError('用户不存在', ErrorCode.AUTH_INVALID_TOKEN);
    }
    /* register/backfill 已存归一化 email；再归一化一次防御历史非归一化 shard 值（幂等）。 */
    const canonOld = canonicalizeEmail(user.email);

    /* operationId 确定性派生：同 (tenantId,userId,newEmail) 重试复用同一 reservation（幂等占位）。 */
    const operationId = `chg:${createHash('sha256').update(`${tenantId}:${userId}:${canonNew}`).digest('hex')}`;

    /* 幂等收敛（Codex Task 9 复审 #2）：新旧归一化相等（含步骤 3 后步骤 4 前崩的同参重试——shard 已== 新）
     * → 不重启状态机。但若协调库仍留本次 opId 的新 email PENDING（步骤 4 未跑完），**主动完成它**（active
     * convergence，不只依赖 Task 8 worker）；否则（已 ACTIVE / 无项）→ 纯 no-op 返回当前 profile。 */
    if (canonOld === canonNew) {
      const pending = this.directory.resolveByEmail(canonNew);
      if (pending && pending.status === 'PENDING' && pending.operationKind === 'EMAIL_CHANGE'
        && pending.tenantId === tenantId && pending.previousLookupValue !== null) {
        this.directory.completeEmailChange({
          oldEmail: pending.previousLookupValue, newEmail: canonNew, operationId,
        });
      }
      return userToProfile(this.readProfile(shardDb, userId));
    }

    /* 步骤 1：跨租户唯一性——目标 email 已属**他租户** ACTIVE/PENDING → 拒（前置门，快速失败）。 */
    const existing = this.directory.resolveByEmail(canonNew);
    if (existing && existing.tenantId !== tenantId) {
      throw new ValidationError('该邮箱已被使用', ErrorCode.AUTH_EMAIL_EXISTS);
    }

    /* 步骤 2：新 email 建 PENDING（EMAIL_CHANGE, previous=canonOld），旧 email ACTIVE 保留不删。
     * 目标 email 已被他人（他 operationId）占 → reserveEmailChange 内 readback 抛 AUTH_EMAIL_EXISTS。 */
    this.directory.reserveEmailChange({ tenantId, userId, oldEmail: canonOld, newEmail: canonNew, operationId });

    /* 步骤 3：shard 事务改 users.email（tenant-scoped：WHERE tenant_id=? AND id=?）。 */
    shardDb.execute(uprofCmdUpdateEmail({ tenantId, userId, email: canonNew, now: Date.now() }));

    /* 步骤 4：CAS 新 email PENDING→ACTIVE 命中后才删旧 email（未命中抛错、绝不删旧——门面守）。 */
    this.directory.completeEmailChange({ oldEmail: canonOld, newEmail: canonNew, operationId });

    return userToProfile(this.readProfile(shardDb, userId));
  }

  /** 从 shard 读回 profile（状态机写后取回新 email）；缺失即完整性违规 fail-closed。 */
  private readProfile(shardDb: ReturnType<TenantDbResolver['dbForTenant']>, userId: string): UserProfileSummaryRow {
    const row = shardDb.queryOne(uprofQueryByIdGlobal(userId));
    if (!row) throw new AuthenticationError('用户不存在', ErrorCode.AUTH_INVALID_TOKEN);
    return row;
  }
}
