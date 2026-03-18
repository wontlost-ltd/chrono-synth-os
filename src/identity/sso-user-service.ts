/**
 * SSO User Provisioning Application Service
 * 封装 OIDC/SSO 回调中用户查找或创建、租户引导的数据访问与业务逻辑
 */

import { randomUUID } from 'node:crypto';
import type { IDatabase } from '../storage/database.js';
import type { SyncWriteUnitOfWork } from '@chrono/kernel';
import type { UserRole } from '../types/auth.js';
import { AuthenticationError, ErrorCode } from '../errors/index.js';
import { syncPlanToQuota } from '../billing/plans.js';
import { IdentityService } from './identity-service.js';
import {
  authQueryUserBriefByEmail, authQuerySubExists,
  authQueryUserCountByTenant,
  authCmdCreateUser, authCmdCreateSubscription,
  authCmdUpdateDisplayName,
} from '@chrono/kernel';
import { directUnitOfWork } from '../storage/direct-uow-adapter.js';
import { registerCoreSelfExecutors } from '../storage/executors/index.js';

export interface SsoUserResult {
  userId: string;
  tenantId: string;
  role: UserRole;
  isNew: boolean;
}

export class SsoUserService {
  private readonly tx: SyncWriteUnitOfWork;
  private readonly identityService: IdentityService;

  constructor(private readonly db: IDatabase) {
    registerCoreSelfExecutors();
    this.tx = directUnitOfWork(db);
    this.identityService = new IdentityService(db);
  }

  /**
   * OIDC 用户查找或创建：要求 email 所属 tenant 与 expectedTenantId 一致
   */
  findOrCreateForOidc(email: string, expectedTenantId: string, displayName?: string): SsoUserResult {
    const existing = this.tx.queryOne(authQueryUserBriefByEmail(email));

    if (existing) {
      if (existing.tenant_id !== expectedTenantId) {
        throw new AuthenticationError('该邮箱已绑定其他 tenant，无法通过当前 OIDC 租户登录', ErrorCode.AUTH_SSO_FAILED);
      }
      this.ensureTenantBootstrap(expectedTenantId, existing.id, email);
      return { userId: existing.id, tenantId: expectedTenantId, role: existing.role as UserRole, isNew: false };
    }

    const userId = `user_${randomUUID()}`;
    const now = Date.now();
    const countRow = this.tx.queryOne(authQueryUserCountByTenant(expectedTenantId));
    const userCount = countRow?.count ?? 0;
    const role: UserRole = userCount === 0 ? 'admin' : 'member';

    this.tx.execute(authCmdCreateUser({
      id: userId, email, passwordHash: 'oidc-managed', role, tenantId: expectedTenantId, now,
    }));

    this.bootstrapTenant(expectedTenantId, userId, email);

    if (displayName) {
      this.tx.execute(authCmdUpdateDisplayName({ userId, displayName, now }));
    }

    return { userId, tenantId: expectedTenantId, role, isNew: true };
  }

  /**
   * SSO (Auth0) 用户查找或创建：自动分配新 tenant
   */
  findOrCreateForSso(email: string): SsoUserResult {
    const existing = this.tx.queryOne(authQueryUserBriefByEmail(email));

    if (existing) {
      this.ensureTenantBootstrap(existing.tenant_id, existing.id, email);
      return { userId: existing.id, tenantId: existing.tenant_id, role: existing.role as UserRole, isNew: false };
    }

    const userId = randomUUID();
    const tenantId = `tenant_${randomUUID()}`;
    const now = Date.now();

    this.tx.execute(authCmdCreateUser({
      id: userId, email, passwordHash: 'sso-managed', role: 'admin', tenantId, now,
    }));

    this.bootstrapTenant(tenantId, userId, email);

    return { userId, tenantId, role: 'admin', isNew: true };
  }

  /** 确保 tenant 有订阅和用户有身份（幂等，可在事务外调用） */
  private ensureTenantBootstrap(tenantId: string, userId: string, email: string): void {
    this.ensureSubscription(tenantId);
    this.identityService.ensureForUser(userId, tenantId, email.split('@')[0]);
  }

  /** 在事务内创建订阅+身份（用于新用户注册） */
  private bootstrapTenant(tenantId: string, userId: string, email: string): void {
    this.ensureSubscription(tenantId);
    this.identityService.ensureForUser(userId, tenantId, email.split('@')[0]);
  }

  private ensureSubscription(tenantId: string): void {
    const sub = this.tx.queryOne(authQuerySubExists(tenantId));
    if (!sub) {
      const now = Date.now();
      this.tx.execute(authCmdCreateSubscription({
        id: `sub_${randomUUID()}`,
        tenantId,
        stripeCustomerId: null,
        periodStart: now,
        periodEnd: now + 365 * 24 * 60 * 60 * 1000,
        now,
      }));
      syncPlanToQuota(this.db, tenantId, 'free');
    }
  }
}
