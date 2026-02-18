/**
 * 认证路由
 * POST /api/v1/auth/register — 注册
 * POST /api/v1/auth/login    — 登录
 * POST /api/v1/auth/refresh  — 刷新令牌
 * POST /api/v1/auth/logout   — 登出（吊销刷新令牌）
 */

import type { FastifyInstance } from 'fastify';
import { createHash, randomUUID } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';
import type { IDatabase } from '../../storage/database.js';
import type { AppConfig } from '../../config/schema.js';
import type { JwtPayload, UserRow, RefreshTokenRow } from '../../types/auth.js';
import { ErrorCode, StateError, AuthenticationError } from '../../errors/index.js';
import { RegisterSchema, LoginSchema, RefreshTokenSchema, LogoutSchema } from '../schemas/api-schemas.js';
import { createCustomer } from '../../billing/stripe-client.js';
import { syncPlanToQuota } from '../../billing/plans.js';

/** 对刷新令牌做 SHA-256 哈希后存储，避免明文泄露 */
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** 认证端点专用限流：按 IP，5 次/分钟 */
const authRateLimit = {
  config: {
    rateLimit: {
      max: 5,
      timeWindow: 60_000,
      keyGenerator: (request: { ip: string }) => request.ip,
    },
  },
};

export function registerAuthRoutes(app: FastifyInstance, db: IDatabase, config: AppConfig): void {
  if (!config.jwt.enabled) return;

  /* POST /api/v1/auth/register */
  app.post('/api/v1/auth/register', authRateLimit, async (request, reply) => {
    const { email, password } = RegisterSchema.parse(request.body);

    const existing = db.prepare<UserRow>('SELECT id FROM users WHERE email = ?').get(email);
    if (existing) {
      throw new StateError('该邮箱已注册', ErrorCode.AUTH_EMAIL_EXISTS);
    }

    const now = Date.now();
    const userId = `user_${randomUUID()}`;
    const passwordHash = await hash(password);
    const tenantId = `tenant_${randomUUID()}`;

    db.prepare<void>(
      'INSERT INTO users (id, email, password_hash, role, tenant_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(userId, email, passwordHash, 'admin', tenantId, now, now);

    /* 创建 Stripe 客户（异步，不阻塞注册） */
    let stripeCustomerId: string | null = null;
    if (config.stripe.enabled) {
      try {
        const customer = await createCustomer(config, email, tenantId);
        stripeCustomerId = customer.id;
      } catch (e) { app.log.warn(`Stripe 客户创建失败: ${e instanceof Error ? e.message : String(e)}`); }
    }

    /* 初始化 free 订阅 */
    const subId = `sub_${randomUUID()}`;
    const periodEnd = now + 365 * 24 * 60 * 60 * 1000;
    db.prepare<void>(
      `INSERT INTO subscriptions (id, tenant_id, stripe_customer_id, plan_id, status, current_period_start, current_period_end, created_at, updated_at)
       VALUES (?, ?, ?, 'free', 'active', ?, ?, ?, ?)`,
    ).run(subId, tenantId, stripeCustomerId, now, periodEnd, now, now);

    /* 同步计划配额到 QuotaManager */
    syncPlanToQuota(db, tenantId, 'free');

    const tokens = await generateTokenPair(app, db, config, userId, tenantId, 'admin');
    return reply.status(201).send({
      data: { userId, email, tenantId, ...tokens },
    });
  });

  /* POST /api/v1/auth/login */
  app.post('/api/v1/auth/login', authRateLimit, async (request) => {
    const { email, password } = LoginSchema.parse(request.body);

    const user = db.prepare<UserRow>('SELECT * FROM users WHERE email = ?').get(email);
    if (!user) {
      throw new AuthenticationError('邮箱或密码错误', ErrorCode.AUTH_INVALID_CREDENTIALS);
    }

    const valid = await verify(user.password_hash, password);
    if (!valid) {
      throw new AuthenticationError('邮箱或密码错误', ErrorCode.AUTH_INVALID_CREDENTIALS);
    }

    const tokens = await generateTokenPair(app, db, config, user.id, user.tenant_id, user.role);
    return { data: { userId: user.id, email: user.email, tenantId: user.tenant_id, role: user.role, ...tokens } };
  });

  /* POST /api/v1/auth/refresh */
  app.post('/api/v1/auth/refresh', authRateLimit, async (request) => {
    const { refreshToken } = RefreshTokenSchema.parse(request.body);

    const tokenHash = hashToken(refreshToken);
    const row = db.prepare<RefreshTokenRow>(
      'SELECT * FROM refresh_tokens WHERE token_hash = ? AND is_revoked = 0',
    ).get(tokenHash);

    if (!row || row.expires_at < Date.now()) {
      throw new AuthenticationError('刷新令牌无效或已过期', ErrorCode.AUTH_EXPIRED);
    }

    /* 吊销旧令牌（令牌轮转） */
    db.prepare<void>('UPDATE refresh_tokens SET is_revoked = 1 WHERE id = ?').run(row.id);

    const user = db.prepare<UserRow>('SELECT * FROM users WHERE id = ?').get(row.user_id);
    if (!user) {
      throw new AuthenticationError('用户不存在', ErrorCode.AUTH_INVALID_TOKEN);
    }

    const tokens = await generateTokenPair(app, db, config, user.id, user.tenant_id, user.role);
    return { data: { userId: user.id, email: user.email, ...tokens } };
  });

  /* POST /api/v1/auth/logout */
  app.post('/api/v1/auth/logout', async (request, reply) => {
    const { refreshToken } = LogoutSchema.parse(request.body ?? {});
    if (refreshToken) {
      const tokenHash = hashToken(refreshToken);
      db.prepare<void>('UPDATE refresh_tokens SET is_revoked = 1 WHERE token_hash = ?').run(tokenHash);
    }

    /* 如果有 JWT 用户上下文，吊销该用户的所有刷新令牌 */
    const jwtUser = request.user as JwtPayload | undefined;
    if (jwtUser) {
      db.prepare<void>('UPDATE refresh_tokens SET is_revoked = 1 WHERE user_id = ?').run(jwtUser.sub);
    }

    return reply.status(204).send();
  });
}

/** 生成 access + refresh 令牌对 */
async function generateTokenPair(
  app: FastifyInstance,
  db: IDatabase,
  config: AppConfig,
  userId: string,
  tenantId: string,
  role: string,
): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
  const signPayload = { sub: userId, tenantId, role } as unknown as JwtPayload;
  const accessToken = app.jwt.sign(signPayload);

  const refreshToken = randomUUID();
  const tokenHash = hashToken(refreshToken);
  const now = Date.now();
  const expiresAt = now + config.jwt.refreshTtlMs;

  db.prepare<void>(
    'INSERT INTO refresh_tokens (id, user_id, token_hash, is_revoked, expires_at, created_at) VALUES (?, ?, ?, 0, ?, ?)',
  ).run(`rt_${randomUUID()}`, userId, tokenHash, expiresAt, now);

  return {
    accessToken,
    refreshToken,
    expiresIn: Math.floor(config.jwt.accessTtlMs / 1000),
  };
}

/** 清理过期和已吊销的刷新令牌（30 天保留窗口） */
export function cleanupExpiredTokens(db: IDatabase): number {
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  return db.prepare<void>(
    'DELETE FROM refresh_tokens WHERE (is_revoked = 1 AND created_at < ?) OR (expires_at < ?)',
  ).run(cutoff, cutoff).changes;
}
