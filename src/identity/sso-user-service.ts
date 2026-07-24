/**
 * SSO User Provisioning Application Service
 * 封装 OIDC/SSO 回调中用户查找或创建、租户引导的数据访问与业务逻辑。
 *
 * 租户分片 Phase 0 · Plan 1c Task 6 —— mixed-scope（先平台级经协调库目录定位 email→tenant，
 * 再租户级写 shard）。全局 email 查从裸 `tx.queryOne(authQueryUserBriefByEmail)`（错-shard、
 * 不经目录）改为 `directory.resolveByEmail(canonicalizeEmail(email))`（协调库权威目录），
 * 写走 `resolver.dbForTenant(tenantId)` 单事务 + `bootCmdMarkComplete(tenantId, operationId)`。
 *
 * 无密码流：SSO/OIDC 用户由身份提供商鉴权，不落 users.password_hash 有效凭据，故经
 * `reservePasswordlessTenant`（门面内部生成一次性随机 operationId、无 resume 续做——SSO/OIDC
 * callback state 一次性无跨请求重试语义；崩溃 PENDING 由 Task 8 恢复 worker 凭 bootstrap COMPLETE 收敛）。
 *
 * email 归一化贯穿：v124 迁移把 `users.email` 归一化为 `LOWER(TRIM(email))`，故所有 email 入参先经
 * `canonicalizeEmail`，目录查/写、shard users.email 一律写 canon 值——否则大小写混合 email 的老用户
 * 在 SSO/OIDC 路径查不到 → 账号锁死（违「绝不破坏用户空间」）。
 */

import { randomUUID } from 'node:crypto';
import type { UserRole } from '../types/auth.js';
import { AuthenticationError, ErrorCode } from '../errors/index.js';
import { syncPlanToQuota } from '../billing/plans.js';
import { IdentityWriter } from './identity-service.js';
import { canonicalizeEmail } from './email-canonical.js';
import { TenantIdentityDirectory } from './tenant-identity-directory.js';
import type { TenantDbResolver } from '../storage/tenant-db-resolver.js';
import {
  authQueryUserById, authQueryUserCountByTenant, authQuerySubExists,
  authCmdCreateUser, authCmdCreateSubscription,
  authCmdUpdateDisplayName,
  bootQueryByOperation, bootCmdMarkComplete,
} from '@chrono/kernel';
import { registerCoreSelfExecutors } from '../storage/executors/index.js';

export interface SsoUserResult {
  userId: string;
  tenantId: string;
  role: UserRole;
  isNew: boolean;
}

/** SSO 候选身份生成器（测试 seam：注确定性 id 验 canonical 身份重入）。 */
export interface IdGenerator {
  tenantId(): string;
  userId(): string;
}

/** 生产默认：随机租户/用户 id（candidate；canonical 以目录 reserve 读回为准）。 */
const DEFAULT_ID_GEN: IdGenerator = {
  tenantId: () => `tenant_${randomUUID()}`,
  userId: () => `user_${randomUUID()}`,
};

export class SsoUserService {
  /** 协调库身份目录门面：email→tenant 目录 reserve/activate/resolve 全经它（Plan 1c Task 4）。 */
  private readonly directory: TenantIdentityDirectory;

  /**
   * 分片 Plan 1c：SSO/OIDC 用户创建先经协调库目录定位 tenant，再经 `resolver.dbForTenant(tenantId)`
   * 落正确 shard，非裸 `new IdentityService(tx)`。idGen 是候选身份生成器（canonical 以目录 reserve
   * 读回为准，测试注确定性 id）。
   */
  constructor(
    private readonly resolver: TenantDbResolver,
    private readonly idGen: IdGenerator = DEFAULT_ID_GEN,
  ) {
    registerCoreSelfExecutors();
    this.directory = new TenantIdentityDirectory(this.resolver);
  }

  /** 以已定位的 tenantId 现造 tenant-bound 身份写内核（tenantId+shard db 同一构造绑定）。 */
  private identityWriter(tenantId: string): IdentityWriter {
    return new IdentityWriter(tenantId, this.resolver.dbForTenant(tenantId));
  }

  /**
   * OIDC 用户查找或创建：email 已属其他 tenant → 抛 AUTH_SSO_FAILED（从协调库目录判定，非某 shard
   * users 查）；一致或全新 → 经 `dbForTenant(expectedTenantId)` 建/取。
   */
  findOrCreateForOidc(email: string, expectedTenantId: string, displayName?: string): SsoUserResult {
    const canonEmail = canonicalizeEmail(email);
    const entry = this.directory.resolveByEmail(canonEmail);

    if (entry) {
      /* email 已在目录中登记 → 校验所属 tenant 与 OIDC 租户一致（跨租户即拒）。 */
      if (entry.tenantId !== expectedTenantId) {
        throw new AuthenticationError('该邮箱已绑定其他 tenant，无法通过当前 OIDC 租户登录', ErrorCode.AUTH_SSO_FAILED);
      }
      if (entry.userId === null) {
        throw new AuthenticationError('目录项缺少 user 绑定，无法完成 OIDC 登录', ErrorCode.AUTH_SSO_FAILED);
      }
      const shardDb = this.resolver.dbForTenant(expectedTenantId);
      this.ensureSubscription(expectedTenantId, shardDb);
      this.identityWriter(expectedTenantId).ensureForUser(entry.userId, canonEmail.split('@')[0]);
      const role = this.existingUserRole(entry.userId, shardDb);
      return { userId: entry.userId, tenantId: expectedTenantId, role, isNew: false };
    }

    /* 全新 email：目录无密码预留（内部随机 operationId）→ canonical 身份 + operationId 写 shard。 */
    const reservation = this.directory.reservePasswordlessTenant({
      tenantId: expectedTenantId, userId: this.idGen.userId(), email: canonEmail,
    });
    /* reservedByUs=false 表示并发下他人刚占 email（一次性 state 无续做）→ 拒。 */
    if (!reservation.reservedByUs) {
      throw new AuthenticationError('该邮箱注册进行中，无法通过 OIDC 创建用户', ErrorCode.AUTH_SSO_FAILED);
    }

    const { canonicalTenantId, canonicalUserId, operationId } = reservation;
    const shardDb = this.resolver.dbForTenant(canonicalTenantId);
    const role = this.provisionShardUser({
      tenantId: canonicalTenantId, userId: canonicalUserId, email: canonEmail,
      passwordHash: 'oidc-managed', operationId, shardDb,
    });

    if (displayName) {
      shardDb.execute(authCmdUpdateDisplayName({ userId: canonicalUserId, displayName, now: Date.now() }));
    }

    this.directory.activateTenant({ email: canonEmail, operationId });
    return { userId: canonicalUserId, tenantId: canonicalTenantId, role, isNew: true };
  }

  /**
   * SSO (Auth0) 用户查找或创建：自动分配新 tenant。email 已 ACTIVE → 走既有用户路径（返回已绑
   * tenant）；全新 → `reservePasswordlessTenant`（自生成候选 tenant/user）→ canonical 身份写 shard。
   */
  findOrCreateForSso(email: string): SsoUserResult {
    const canonEmail = canonicalizeEmail(email);
    const existing = this.directory.resolveByEmail(canonEmail);

    if (existing) {
      if (existing.userId === null) {
        throw new AuthenticationError('目录项缺少 user 绑定，无法完成 SSO 登录', ErrorCode.AUTH_SSO_FAILED);
      }
      const shardDb = this.resolver.dbForTenant(existing.tenantId);
      this.ensureSubscription(existing.tenantId, shardDb);
      this.identityWriter(existing.tenantId).ensureForUser(existing.userId, canonEmail.split('@')[0]);
      const role = this.existingUserRole(existing.userId, shardDb);
      return { userId: existing.userId, tenantId: existing.tenantId, role, isNew: false };
    }

    /* 全新 email：SSO 自生成候选 tenant/user，目录无密码预留读回 canonical 身份。 */
    const reservation = this.directory.reservePasswordlessTenant({
      tenantId: this.idGen.tenantId(), userId: this.idGen.userId(), email: canonEmail,
    });
    if (!reservation.reservedByUs) {
      throw new AuthenticationError('该邮箱注册进行中，无法通过 SSO 创建用户', ErrorCode.AUTH_SSO_FAILED);
    }

    const { canonicalTenantId, canonicalUserId, operationId } = reservation;
    const shardDb = this.resolver.dbForTenant(canonicalTenantId);
    const role = this.provisionShardUser({
      tenantId: canonicalTenantId, userId: canonicalUserId, email: canonEmail,
      passwordHash: 'sso-managed', operationId, shardDb,
    });

    this.directory.activateTenant({ email: canonEmail, operationId });
    return { userId: canonicalUserId, tenantId: canonicalTenantId, role, isNew: true };
  }

  /* ── 私有 ── */

  /**
   * per-operation bootstrap 完成标记 + shard 单事务写 user/subscription/quota + identity。
   * 已 COMPLETE 即本次 operation 已落地（重试）→ 跳过重建（幂等）。返回该用户在 tenant 内的角色。
   */
  private provisionShardUser(input: {
    tenantId: string;
    userId: string;
    email: string;
    passwordHash: string;
    operationId: string;
    shardDb: ReturnType<TenantDbResolver['dbForTenant']>;
  }): UserRole {
    const { tenantId, userId, email, passwordHash, operationId, shardDb } = input;
    const boot = shardDb.queryOne(bootQueryByOperation(tenantId, operationId));

    /* 重试（本次 operation 已 COMPLETE）：user/subscription/quota/identity 已在首次落地，
     * 读回既存 user 的实际角色返回（绝不重算——重算会因 count≥1 误把首用户降级为 member）。 */
    if (boot?.status === 'COMPLETE') {
      return this.existingUserRole(userId, shardDb);
    }

    /* 首用户 admin、后续 member（tenant 内用户计数在写前取，此路径必是新写）。 */
    const countRow = shardDb.queryOne(authQueryUserCountByTenant(tenantId));
    const role: UserRole = (countRow?.count ?? 0) === 0 ? 'admin' : 'member';

    /* IdentityWriter.create 内部自开事务（node:sqlite 平坦 BEGIN 不可嵌套），故在主事务前独立写；
     * 一旦 COMPLETE 落地即代表身份已建（重试见 COMPLETE 跳过）。 */
    new IdentityWriter(tenantId, shardDb).ensureForUser(userId, email.split('@')[0]);

    const now = Date.now();
    const periodEnd = now + 365 * 24 * 60 * 60 * 1000;
    shardDb.transaction(() => {
      shardDb.execute(authCmdCreateUser({
        id: userId, email, passwordHash, role, tenantId, now,
      }));
      this.ensureSubscriptionTx(tenantId, shardDb, now, periodEnd);
      shardDb.execute(bootCmdMarkComplete({ tenantId, operationId, now }));
    });
    return role;
  }

  /** 读回既存 shard user 的角色（未命中兜底 member）。 */
  private existingUserRole(
    userId: string, shardDb: ReturnType<TenantDbResolver['dbForTenant']>,
  ): UserRole {
    const row = shardDb.queryOne(authQueryUserById(userId));
    return (row?.role as UserRole) ?? 'member';
  }

  /** 幂等确保 tenant 有订阅（事务外，供既有用户路径调用）。 */
  private ensureSubscription(
    tenantId: string, shardDb: ReturnType<TenantDbResolver['dbForTenant']>,
  ): void {
    const now = Date.now();
    const periodEnd = now + 365 * 24 * 60 * 60 * 1000;
    shardDb.transaction(() => this.ensureSubscriptionTx(tenantId, shardDb, now, periodEnd));
  }

  /** 事务内确保订阅 + quota（已存在则不重建）。 */
  private ensureSubscriptionTx(
    tenantId: string, shardDb: ReturnType<TenantDbResolver['dbForTenant']>,
    now: number, periodEnd: number,
  ): void {
    const sub = shardDb.queryOne(authQuerySubExists(tenantId));
    if (sub) return;
    shardDb.execute(authCmdCreateSubscription({
      id: `sub_${randomUUID()}`,
      tenantId,
      stripeCustomerId: null,
      periodStart: now,
      periodEnd,
      now,
    }));
    syncPlanToQuota(shardDb, tenantId, 'free');
  }
}
