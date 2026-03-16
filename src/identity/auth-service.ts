/**
 * Auth Application Service
 * 封装注册、登录、令牌刷新、登出的数据访问与业务逻辑
 */

import { createHash, randomUUID } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';
import type { FastifyInstance } from 'fastify';
import type { IDatabase } from '../storage/database.js';
import type { AppConfig } from '../config/schema.js';
import type { JwtPayload, UserRow, RefreshTokenRow } from '../types/auth.js';
import { ErrorCode, StateError, AuthenticationError } from '../errors/index.js';
import { createCustomer } from '../billing/stripe-client.js';
import { syncPlanToQuota } from '../billing/plans.js';
import { IdentityService } from './identity-service.js';

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
  constructor(
    private readonly db: IDatabase,
    private readonly config: AppConfig,
  ) {}

  async register(app: FastifyInstance, email: string, password: string): Promise<RegisterResult> {
    const existing = this.db.prepare<UserRow>('SELECT id FROM users WHERE email = ?').get(email);
    if (existing) {
      throw new StateError('该邮箱已注册', ErrorCode.AUTH_EMAIL_EXISTS);
    }

    const now = Date.now();
    const userId = `user_${randomUUID()}`;
    const passwordHash = await hash(password);
    const tenantId = `tenant_${randomUUID()}`;

    this.db.prepare<void>(
      'INSERT INTO users (id, email, password_hash, role, tenant_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(userId, email, passwordHash, 'admin', tenantId, now, now);

    let stripeCustomerId: string | null = null;
    if (this.config.stripe.enabled) {
      try {
        const customer = await createCustomer(this.config, email, tenantId);
        stripeCustomerId = customer.id;
      } catch (e) { app.log.warn(`Stripe 客户创建失败: ${e instanceof Error ? e.message : String(e)}`); }
    }

    const subId = `sub_${randomUUID()}`;
    const periodEnd = now + 365 * 24 * 60 * 60 * 1000;
    this.db.prepare<void>(
      `INSERT INTO subscriptions (id, tenant_id, stripe_customer_id, plan_id, status, current_period_start, current_period_end, created_at, updated_at)
       VALUES (?, ?, ?, 'free', 'active', ?, ?, ?, ?)`,
    ).run(subId, tenantId, stripeCustomerId, now, periodEnd, now, now);

    syncPlanToQuota(this.db, tenantId, 'free');

    const identityService = new IdentityService(this.db);
    identityService.create(userId, tenantId, email.split('@')[0]);

    const tokens = await this.generateTokenPair(app, userId, tenantId, 'admin');
    return { userId, email, tenantId, ...tokens };
  }

  async login(app: FastifyInstance, email: string, password: string): Promise<LoginResult> {
    const user = this.db.prepare<UserRow>('SELECT * FROM users WHERE email = ?').get(email);
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
    const row = this.db.prepare<RefreshTokenRow>(
      'SELECT * FROM refresh_tokens WHERE token_hash = ? AND is_revoked = 0',
    ).get(tokenHash);

    if (!row || row.expires_at < Date.now()) {
      throw new AuthenticationError('刷新令牌无效或已过期', ErrorCode.AUTH_EXPIRED);
    }

    this.db.prepare<void>('UPDATE refresh_tokens SET is_revoked = 1 WHERE id = ?').run(row.id);

    const user = this.db.prepare<UserRow>('SELECT * FROM users WHERE id = ?').get(row.user_id);
    if (!user) {
      throw new AuthenticationError('用户不存在', ErrorCode.AUTH_INVALID_TOKEN);
    }

    const tokens = await this.generateTokenPair(app, user.id, user.tenant_id, user.role);
    return { userId: user.id, email: user.email, ...tokens };
  }

  logout(refreshToken: string | undefined, jwtUser: JwtPayload | undefined): void {
    if (refreshToken) {
      const tokenHash = hashToken(refreshToken);
      this.db.prepare<void>('UPDATE refresh_tokens SET is_revoked = 1 WHERE token_hash = ?').run(tokenHash);
    }
    if (jwtUser) {
      this.db.prepare<void>('UPDATE refresh_tokens SET is_revoked = 1 WHERE user_id = ?').run(jwtUser.sub);
    }
  }

  revokeByTokenHash(tokenHash: string): void {
    this.db.prepare<void>('UPDATE refresh_tokens SET is_revoked = 1 WHERE token_hash = ?').run(tokenHash);
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
    const sub = this.db.prepare<{ plan_id: string }>(
      'SELECT plan_id FROM subscriptions WHERE tenant_id = ? AND status = \'active\' ORDER BY created_at DESC LIMIT 1',
    ).get(tenantId);
    const planId = sub?.plan_id ?? 'free';
    const signPayload = { sub: userId, tenantId, role, planId } as unknown as JwtPayload;
    const accessToken = app.jwt.sign(signPayload);

    const refreshToken = randomUUID();
    const tokenHash = hashToken(refreshToken);
    const now = Date.now();
    const expiresAt = now + this.config.jwt.refreshTtlMs;

    this.db.prepare<void>(
      'INSERT INTO refresh_tokens (id, user_id, token_hash, is_revoked, expires_at, created_at) VALUES (?, ?, ?, 0, ?, ?)',
    ).run(`rt_${randomUUID()}`, userId, tokenHash, expiresAt, now);

    return {
      accessToken,
      refreshToken,
      expiresIn: Math.floor(this.config.jwt.accessTtlMs / 1000),
    };
  }

  cleanupExpiredTokens(): number {
    return AuthService.cleanupExpired(this.db);
  }

  static cleanupExpired(db: IDatabase): number {
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    let changes = 0;
    db.transaction(() => {
      changes = db.prepare<void>(
        'DELETE FROM refresh_tokens WHERE (is_revoked = 1 AND created_at < ?) OR (expires_at < ?)',
      ).run(cutoff, cutoff).changes;
    });
    return changes;
  }
}
