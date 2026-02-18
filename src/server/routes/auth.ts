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
import { ErrorCode } from '../../errors/index.js';
import { createCustomer } from '../../billing/stripe-client.js';
import { syncPlanToQuota } from '../../billing/plans.js';

/** 对刷新令牌做 SHA-256 哈希后存储，避免明文泄露 */
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function registerAuthRoutes(app: FastifyInstance, db: IDatabase, config: AppConfig): void {
  if (!config.jwt.enabled) return;

  /* POST /api/v1/auth/register */
  app.post('/api/v1/auth/register', async (request, reply) => {
    const { email, password } = request.body as { email?: string; password?: string };
    if (!email || !password) {
      return reply.status(400).send({
        error: 'ValidationError',
        code: ErrorCode.VALIDATION_REQUIRED,
        message: '邮箱和密码不能为空',
      });
    }
    if (password.length < 8) {
      return reply.status(400).send({
        error: 'ValidationError',
        code: ErrorCode.VALIDATION_FORMAT,
        message: '密码至少 8 个字符',
      });
    }

    const existing = db.prepare<UserRow>('SELECT id FROM users WHERE email = ?').get(email);
    if (existing) {
      return reply.status(409).send({
        error: 'StateError',
        code: ErrorCode.AUTH_EMAIL_EXISTS,
        message: '该邮箱已注册',
      });
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
  app.post('/api/v1/auth/login', async (request, reply) => {
    const { email, password } = request.body as { email?: string; password?: string };
    if (!email || !password) {
      return reply.status(400).send({
        error: 'ValidationError',
        code: ErrorCode.VALIDATION_REQUIRED,
        message: '邮箱和密码不能为空',
      });
    }

    const user = db.prepare<UserRow>('SELECT * FROM users WHERE email = ?').get(email);
    if (!user) {
      return reply.status(401).send({
        error: 'AuthenticationError',
        code: ErrorCode.AUTH_INVALID_CREDENTIALS,
        message: '邮箱或密码错误',
      });
    }

    const valid = await verify(user.password_hash, password);
    if (!valid) {
      return reply.status(401).send({
        error: 'AuthenticationError',
        code: ErrorCode.AUTH_INVALID_CREDENTIALS,
        message: '邮箱或密码错误',
      });
    }

    const tokens = await generateTokenPair(app, db, config, user.id, user.tenant_id, user.role);
    return { data: { userId: user.id, email: user.email, tenantId: user.tenant_id, role: user.role, ...tokens } };
  });

  /* POST /api/v1/auth/refresh */
  app.post('/api/v1/auth/refresh', async (request, reply) => {
    const { refreshToken } = request.body as { refreshToken?: string };
    if (!refreshToken) {
      return reply.status(400).send({
        error: 'ValidationError',
        code: ErrorCode.VALIDATION_REQUIRED,
        message: '刷新令牌不能为空',
      });
    }

    const tokenHash = hashToken(refreshToken);
    const row = db.prepare<RefreshTokenRow>(
      'SELECT * FROM refresh_tokens WHERE token_hash = ? AND is_revoked = 0',
    ).get(tokenHash);

    if (!row || row.expires_at < Date.now()) {
      return reply.status(401).send({
        error: 'AuthenticationError',
        code: ErrorCode.AUTH_EXPIRED,
        message: '刷新令牌无效或已过期',
      });
    }

    /* 吊销旧令牌（令牌轮转） */
    db.prepare<void>('UPDATE refresh_tokens SET is_revoked = 1 WHERE id = ?').run(row.id);

    const user = db.prepare<UserRow>('SELECT * FROM users WHERE id = ?').get(row.user_id);
    if (!user) {
      return reply.status(401).send({
        error: 'AuthenticationError',
        code: ErrorCode.AUTH_INVALID_TOKEN,
        message: '用户不存在',
      });
    }

    const tokens = await generateTokenPair(app, db, config, user.id, user.tenant_id, user.role);
    return { data: { userId: user.id, email: user.email, ...tokens } };
  });

  /* POST /api/v1/auth/logout */
  app.post('/api/v1/auth/logout', async (request, reply) => {
    const { refreshToken } = request.body as { refreshToken?: string };
    if (refreshToken) {
      const tokenHash = hashToken(refreshToken);
      db.prepare<void>('UPDATE refresh_tokens SET is_revoked = 1 WHERE token_hash = ?').run(tokenHash);
    }

    /* 如果有 JWT 用户上下文，吊销该用户的所有刷新令牌 */
    const jwtUser = request.user as import('../../types/auth.js').JwtPayload | undefined;
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
