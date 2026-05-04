/**
 * Auth Application Service
 * 封装注册、登录、令牌刷新、登出的数据访问与业务逻辑
 */

import { createHash, randomUUID } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';
import type { FastifyInstance } from 'fastify';
import type { IDatabase } from '../storage/database.js';
import type { SyncWriteUnitOfWork } from '@chrono/kernel';
import type { AppConfig } from '../config/schema.js';
import type { JwtPayload } from '../types/auth.js';
import { ErrorCode, StateError, AuthenticationError } from '../errors/index.js';
import { createCustomer } from '../billing/stripe-client.js';
import { syncPlanToQuota } from '../billing/plans.js';
import { IdentityService } from './identity-service.js';
import {
  authQueryUserByEmail, authQueryUserById, authQueryRefreshToken,
  authCmdCreateUser, authCmdCreateSubscription,
  authCmdCreateRefreshToken, authCmdRevokeTokenById,
  authCmdRevokeTokenByHash, authCmdRevokeTokensByUser,
  authCmdCleanupExpiredTokens,
  subqQueryActivePlan,
} from '@chrono/kernel';
import { directUnitOfWork } from '../storage/direct-uow-adapter.js';
import { asUow, unwrapDb, type UowOrDb } from '../storage/uow-helpers.js';
import { registerCoreSelfExecutors } from '../storage/executors/index.js';

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export interface RegisterResult {
  userId: string;
  email: string;
  tenantId: string;
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export interface LoginResult {
  userId: string;
  email: string;
  tenantId: string;
  role: string;
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export interface RefreshResult {
  userId: string;
  email: string;
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export class AuthService {
  private readonly tx: SyncWriteUnitOfWork;
  /** UoW 模式下为 null；syncPlanToQuota / IdentityService / cleanupExpired
   *  都依赖 IDatabase，这些路径在 UoW 模式下应被外部组合时显式转换。 */
  private readonly db: IDatabase | null;

  constructor(
    uowOrDb: UowOrDb,
    private readonly config: AppConfig,
  ) {
    registerCoreSelfExecutors();
    this.tx = asUow(uowOrDb);
    this.db = unwrapDb(uowOrDb);
  }

  async register(app: FastifyInstance, email: string, password: string): Promise<RegisterResult> {
    const existing = this.tx.queryOne(authQueryUserByEmail(email));
    if (existing) {
      throw new StateError('该邮箱已注册', ErrorCode.AUTH_EMAIL_EXISTS);
    }

    const now = Date.now();
    const userId = `user_${randomUUID()}`;
    const passwordHash = await hash(password);
    const tenantId = `tenant_${randomUUID()}`;

    this.tx.execute(authCmdCreateUser({
      id: userId, email, passwordHash, role: 'admin', tenantId, now,
    }));

    let stripeCustomerId: string | null = null;
    if (this.config.stripe.enabled) {
      try {
        const customer = await createCustomer(this.config, email, tenantId);
        stripeCustomerId = customer.id;
      } catch (e) { app.log.warn(`Stripe 客户创建失败: ${e instanceof Error ? e.message : String(e)}`); }
    }

    const subId = `sub_${randomUUID()}`;
    const periodEnd = now + 365 * 24 * 60 * 60 * 1000;
    this.tx.execute(authCmdCreateSubscription({
      id: subId, tenantId, stripeCustomerId, periodStart: now, periodEnd, now,
    }));

    if (this.db) syncPlanToQuota(this.db, tenantId, 'free');

    const identityService = new IdentityService(this.db ?? this.tx);
    identityService.create(userId, tenantId, email.split('@')[0]);

    const tokens = await this.generateTokenPair(app, userId, tenantId, 'admin');
    return { userId, email, tenantId, ...tokens };
  }

  async login(app: FastifyInstance, email: string, password: string): Promise<LoginResult> {
    const user = this.tx.queryOne(authQueryUserByEmail(email));
    if (!user) {
      throw new AuthenticationError('邮箱或密码错误', ErrorCode.AUTH_INVALID_CREDENTIALS);
    }

    const valid = await verify(user.password_hash, password);
    if (!valid) {
      throw new AuthenticationError('邮箱或密码错误', ErrorCode.AUTH_INVALID_CREDENTIALS);
    }

    const tokens = await this.generateTokenPair(app, user.id, user.tenant_id, user.role);
    return { userId: user.id, email: user.email, tenantId: user.tenant_id, role: user.role, ...tokens };
  }

  async refresh(app: FastifyInstance, refreshToken: string): Promise<RefreshResult> {
    const tokenHash = hashToken(refreshToken);
    const row = this.tx.queryOne(authQueryRefreshToken(tokenHash));

    if (!row || row.expires_at < Date.now()) {
      throw new AuthenticationError('刷新令牌无效或已过期', ErrorCode.AUTH_EXPIRED);
    }

    this.tx.execute(authCmdRevokeTokenById(row.id));

    const user = this.tx.queryOne(authQueryUserById(row.user_id));
    if (!user) {
      throw new AuthenticationError('用户不存在', ErrorCode.AUTH_INVALID_TOKEN);
    }

    const tokens = await this.generateTokenPair(app, user.id, user.tenant_id, user.role);
    return { userId: user.id, email: user.email, ...tokens };
  }

  logout(refreshToken: string | undefined, jwtUser: JwtPayload | undefined): void {
    if (refreshToken) {
      const tokenHash = hashToken(refreshToken);
      this.tx.execute(authCmdRevokeTokenByHash(tokenHash));
    }
    if (jwtUser) {
      this.tx.execute(authCmdRevokeTokensByUser(jwtUser.sub));
    }
  }

  revokeByTokenHash(tokenHash: string): void {
    this.tx.execute(authCmdRevokeTokenByHash(tokenHash));
  }

  revokeByRawToken(rawToken: string): void {
    if (typeof rawToken !== 'string' || !rawToken) return;
    this.revokeByTokenHash(hashToken(rawToken));
  }

  async generateTokenPair(
    app: FastifyInstance,
    userId: string,
    tenantId: string,
    role: string,
  ): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
    const sub = this.tx.queryOne(subqQueryActivePlan(tenantId));
    const planId = sub?.plan_id ?? 'free';
    const signPayload = { sub: userId, tenantId, role, planId } as unknown as JwtPayload;
    const accessToken = app.jwt.sign(signPayload);

    const refreshToken = randomUUID();
    const tokenHash = hashToken(refreshToken);
    const now = Date.now();
    const expiresAt = now + this.config.jwt.refreshTtlMs;

    this.tx.execute(authCmdCreateRefreshToken({
      id: `rt_${randomUUID()}`, userId, tokenHash, expiresAt, now,
    }));

    return {
      accessToken,
      refreshToken,
      expiresIn: Math.floor(this.config.jwt.accessTtlMs / 1000),
    };
  }

  cleanupExpiredTokens(): number {
    /* UoW 模式下没有 db.transaction 包裹，但 cleanup 是单条 DELETE，不破坏一致性 */
    if (this.db) return AuthService.cleanupExpired(this.db);
    return this.tx.execute(authCmdCleanupExpiredTokens({
      cutoff: Date.now() - 30 * 24 * 60 * 60 * 1000,
    })).rowsAffected;
  }

  static cleanupExpired(db: IDatabase): number {
    registerCoreSelfExecutors();
    const tx = directUnitOfWork(db);
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    let changes = 0;
    db.transaction(() => {
      changes = tx.execute(authCmdCleanupExpiredTokens({ cutoff })).rowsAffected;
    });
    return changes;
  }
}
