/**
 * SSO 路由
 * GET  /api/v1/auth/sso/authorize — 重定向到 Auth0 授权页
 * GET  /api/v1/auth/sso/callback  — 处理 Auth0 回调
 */

import type { FastifyInstance } from 'fastify';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import type { IDatabase } from '../../storage/database.js';
import type { AppConfig } from '../../config/schema.js';
import { buildAuthorizeUrl, exchangeCode, fetchUserInfo } from '../plugins/auth0.js';
import type { JwtPayload, UserRole } from '../../types/auth.js';
import { syncPlanToQuota } from '../../billing/plans.js';
import { ConfigError, ValidationError, AuthenticationError, ErrorCode } from '../../errors/index.js';

/** SSO 状态参数临时存储（生产环境应使用 Redis） */
const MAX_PENDING_STATES = 10_000;
const STATE_TTL_MS = 300_000;
const pendingStates = new Map<string, { redirectUri: string; createdAt: number }>();

function cleanExpiredStates(): void {
  const fiveMinutesAgo = Date.now() - STATE_TTL_MS;
  for (const [key, val] of pendingStates) {
    if (val.createdAt < fiveMinutesAgo) pendingStates.delete(key);
  }
  /* 防止 Map 无限增长：超过上限时移除最旧的条目 */
  if (pendingStates.size > MAX_PENDING_STATES) {
    const iter = pendingStates.keys();
    let toRemove = pendingStates.size - MAX_PENDING_STATES;
    while (toRemove-- > 0) {
      const key = iter.next().value;
      if (key) pendingStates.delete(key);
    }
  }
}

export function registerSsoRoutes(app: FastifyInstance, db: IDatabase, config: AppConfig): void {
  if (!config.sso?.enabled) return;

  const ssoConfig = {
    enabled: config.sso.enabled,
    domain: config.sso.domain,
    clientId: config.sso.clientId,
    clientSecret: config.sso.clientSecret,
    audience: config.sso.audience,
  };

  const baseUrl = config.server.publicUrl;

  /* GET /api/v1/auth/sso/authorize */
  app.get('/api/v1/auth/sso/authorize', async (request, reply) => {
    cleanExpiredStates();

    if (!baseUrl) {
      throw new ConfigError('SSO 启用但 server.publicUrl 未配置', ErrorCode.CONFIG_INVALID);
    }

    const { redirect_uri } = request.query as { redirect_uri?: string };

    const redirectPath = (redirect_uri && redirect_uri.startsWith('/') && !redirect_uri.startsWith('//'))
      ? redirect_uri
      : '/';

    const callbackUri = `${baseUrl}/api/v1/auth/sso/callback`;
    const state = randomBytes(32).toString('hex');

    pendingStates.set(state, {
      redirectUri: redirectPath,
      createdAt: Date.now(),
    });

    const authorizeUrl = buildAuthorizeUrl(ssoConfig, callbackUri, state);
    return reply.redirect(authorizeUrl);
  });

  /* GET /api/v1/auth/sso/callback */
  app.get('/api/v1/auth/sso/callback', async (request, reply) => {
    const { code, state, error: authError } = request.query as {
      code?: string;
      state?: string;
      error?: string;
    };

    if (authError) {
      throw new AuthenticationError(`Auth0 错误: ${authError}`, ErrorCode.AUTH_SSO_FAILED);
    }

    if (!code || !state) {
      throw new ValidationError('缺少 code 或 state 参数', ErrorCode.VALIDATION_REQUIRED);
    }

    const pending = pendingStates.get(state);
    if (!pending || Date.now() - pending.createdAt > STATE_TTL_MS) {
      if (pending) pendingStates.delete(state);
      throw new AuthenticationError('state 参数无效或已过期', ErrorCode.AUTH_SSO_FAILED);
    }
    pendingStates.delete(state);

    if (!baseUrl) {
      throw new ConfigError('SSO 未配置回调地址', ErrorCode.CONFIG_INVALID);
    }
    const callbackUri = `${baseUrl}/api/v1/auth/sso/callback`;

    try {
      const tokens = await exchangeCode(ssoConfig, code, callbackUri);
      const userInfo = await fetchUserInfo(ssoConfig.domain, tokens.access_token);

      const emailVerified = (userInfo as { email_verified?: boolean }).email_verified;
      if (userInfo.email && emailVerified !== true) {
        throw new AuthenticationError('邮箱未验证', ErrorCode.AUTH_SSO_FAILED);
      }

      const email = userInfo.email ?? userInfo.sub;

      // 查找或创建用户
      const existingUser = db.prepare<{ id: string; tenant_id: string; role: string }>(
        'SELECT id, tenant_id, role FROM users WHERE email = ?',
      ).get(email);

      let userId: string;
      let tenantId: string;
      let role: UserRole;

      if (existingUser) {
        userId = existingUser.id;
        tenantId = existingUser.tenant_id;
        role = existingUser.role as UserRole;
      } else {
        userId = randomUUID();
        tenantId = `tenant_${randomUUID()}`;
        role = 'admin';
        const now = Date.now();
        db.prepare(
          'INSERT INTO users (id, email, password_hash, role, tenant_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        ).run(userId, email, 'sso-managed', role, tenantId, now, now);

        /* 初始化 free 订阅与配额 */
        const subId = `sub_${randomUUID()}`;
        const periodEnd = now + 365 * 24 * 60 * 60 * 1000;
        db.prepare(
          `INSERT INTO subscriptions (id, tenant_id, stripe_customer_id, plan_id, status, current_period_start, current_period_end, created_at, updated_at)
           VALUES (?, ?, NULL, 'free', 'active', ?, ?, ?, ?)`,
        ).run(subId, tenantId, now, periodEnd, now, now);
        syncPlanToQuota(db, tenantId, 'free');
      }

      // 签发自有 JWT
      const signPayload = { sub: userId, tenantId, role } as unknown as JwtPayload;
      const accessToken = app.jwt.sign(signPayload);
      const refreshToken = randomUUID();

      // 存储刷新令牌
      const tokenHash = createHash('sha256').update(refreshToken).digest('hex');
      db.prepare(
        'INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)',
      ).run(randomUUID(), userId, tokenHash, Date.now() + config.jwt.refreshTtlMs, Date.now());

      // 重定向到前端并携带 token（通过 URL fragment 避免服务端日志泄露）
      const redirectUrl = new URL(pending.redirectUri, baseUrl);
      redirectUrl.hash = `access_token=${accessToken}&refresh_token=${refreshToken}`;

      return reply.redirect(redirectUrl.toString());
    } catch (err) {
      app.log.error({ err }, 'SSO callback 处理失败');
      throw err;
    }
  });
}
