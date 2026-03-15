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
import { RegisterSchema, LoginSchema, LogoutSchema } from '../schemas/api-schemas.js';
import { createCustomer } from '../../billing/stripe-client.js';
import { syncPlanToQuota } from '../../billing/plans.js';
import { IdentityService } from '../../identity/identity-service.js';

/** 对刷新令牌做 SHA-256 哈希后存储，避免明文泄露 */
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

const REFRESH_COOKIE_NAME = 'chrono_refresh';

type RefreshCookieRequest = {
  headers: {
    cookie?: string;
    origin?: string;
    host?: string;
    'x-forwarded-host'?: string | string[];
    'x-forwarded-proto'?: string | string[];
  };
};

type RefreshCookieReply = {
  header: (key: string, value: string) => void;
};

/** 从请求中提取 refreshToken：优先 cookie，回退到 body */
function extractRefreshToken(request: { headers: { cookie?: string }; body: unknown }): string | undefined {
  const cookieHeader = request.headers.cookie;
  if (cookieHeader) {
    const match = cookieHeader.split(';').map(c => c.trim()).find(c => c.startsWith(`${REFRESH_COOKIE_NAME}=`));
    if (match) {
      return match.slice(REFRESH_COOKIE_NAME.length + 1);
    }
  }
  const body = request.body as { refreshToken?: string } | undefined;
  return body?.refreshToken;
}

function parseUrl(value: string | undefined): URL | undefined {
  if (!value) return undefined;
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

function getRequestProtocol(request: RefreshCookieRequest): string {
  const forwardedProto = request.headers['x-forwarded-proto'];
  const rawProto = Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto;
  return rawProto?.split(',')[0]?.trim() || 'http';
}

function getRequestHost(request: RefreshCookieRequest): string | undefined {
  const forwardedHost = request.headers['x-forwarded-host'];
  const rawForwardedHost = Array.isArray(forwardedHost) ? forwardedHost[0] : forwardedHost;
  return rawForwardedHost?.split(',')[0]?.trim() || request.headers.host;
}

function getServerUrl(request: RefreshCookieRequest, config: AppConfig): URL | undefined {
  const host = getRequestHost(request);
  if (!host) return undefined;
  return parseUrl(`${getRequestProtocol(request)}://${host}`) ?? (config.server.publicUrl ? parseUrl(config.server.publicUrl) : undefined);
}

function isIpAddressHost(hostname: string | undefined): boolean {
  if (!hostname) return false;
  const normalized = hostname.toLowerCase();
  return normalized.includes(':') || /^(\d{1,3}\.){3}\d{1,3}$/.test(normalized);
}

const MULTI_LABEL_PUBLIC_SUFFIXES = new Set([
  'ac.nz',
  'ac.uk',
  'co.jp',
  'co.kr',
  'co.nz',
  'co.uk',
  'com.au',
  'com.br',
  'com.cn',
  'com.hk',
  'com.mx',
  'com.sg',
  'govt.nz',
  'net.au',
  'org.au',
  'org.nz',
  'org.uk',
]);

function getRegistrableSite(hostname: string | undefined): string | undefined {
  if (!hostname) return undefined;
  const normalized = hostname.toLowerCase().replace(/\.$/, '');
  if (normalized === 'localhost' || normalized.endsWith('.localhost')) {
    return 'localhost';
  }
  if (isIpAddressHost(normalized) || normalized === '::1' || normalized === '127.0.0.1' || normalized.startsWith('127.')) {
    return normalized;
  }

  const labels = normalized.split('.').filter(Boolean);
  if (labels.length <= 2) return normalized;

  const suffix = labels.slice(-2).join('.');
  if (labels.length >= 3 && MULTI_LABEL_PUBLIC_SUFFIXES.has(suffix)) {
    return labels.slice(-3).join('.');
  }
  return labels.slice(-2).join('.');
}

function getSiteKey(url: URL | undefined): string | undefined {
  if (!url) return undefined;
  const registrableSite = getRegistrableSite(url.hostname);
  if (!registrableSite) return undefined;
  return `${url.protocol}//${registrableSite}`;
}

function resolveRefreshCookiePolicy(
  request: RefreshCookieRequest,
  config: AppConfig,
): { sameSite: 'Lax' | 'None'; secure: boolean } {
  const requestOrigin = parseUrl(request.headers.origin);
  const serverUrl = getServerUrl(request, config);
  const secureTransport = serverUrl?.protocol === 'https:' || requestOrigin?.protocol === 'https:';
  const requestSite = getSiteKey(requestOrigin);
  const serverSite = getSiteKey(serverUrl);
  const isCrossSite = !!requestSite && !!serverSite && requestSite !== serverSite;

  if (!isCrossSite) {
    return {
      sameSite: 'Lax',
      secure: process.env.NODE_ENV === 'production' || secureTransport,
    };
  }

  if (!secureTransport) {
    return {
      sameSite: 'Lax',
      secure: false,
    };
  }

  return {
    sameSite: 'None',
    secure: true,
  };
}

/** 设置 HttpOnly refresh token cookie */
export function setRefreshCookie(
  request: RefreshCookieRequest,
  reply: RefreshCookieReply,
  config: AppConfig,
  token: string,
  maxAgeMs: number,
): void {
  const maxAgeSec = Math.floor(maxAgeMs / 1000);
  const policy = resolveRefreshCookiePolicy(request, config);
  reply.header(
    'Set-Cookie',
    `${REFRESH_COOKIE_NAME}=${token}; HttpOnly; Path=/api/v1/auth; SameSite=${policy.sameSite}; Max-Age=${maxAgeSec}${policy.secure ? '; Secure' : ''}`,
  );
}

/** 清除 refresh token cookie */
function clearRefreshCookie(request: RefreshCookieRequest, reply: RefreshCookieReply, config: AppConfig): void {
  const policy = resolveRefreshCookiePolicy(request, config);
  reply.header(
    'Set-Cookie',
    `${REFRESH_COOKIE_NAME}=; HttpOnly; Path=/api/v1/auth; SameSite=${policy.sameSite}; Max-Age=0${policy.secure ? '; Secure' : ''}`,
  );
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

    /* 创建身份 + 默认分身 */
    const identityService = new IdentityService(db);
    identityService.create(userId, tenantId, email.split('@')[0]);

    const tokens = await generateTokenPair(app, db, config, userId, tenantId, 'admin');
    setRefreshCookie(request, reply, config, tokens.refreshToken, config.jwt.refreshTtlMs);
    return reply.status(201).send({
      data: { userId, email, tenantId, ...tokens },
    });
  });

  /* POST /api/v1/auth/login */
  app.post('/api/v1/auth/login', authRateLimit, async (request, reply) => {
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
    setRefreshCookie(request, reply, config, tokens.refreshToken, config.jwt.refreshTtlMs);
    return { data: { userId: user.id, email: user.email, tenantId: user.tenant_id, role: user.role, ...tokens } };
  });

  /* POST /api/v1/auth/refresh */
  app.post('/api/v1/auth/refresh', authRateLimit, async (request, reply) => {
    const refreshToken = extractRefreshToken(request);
    if (!refreshToken) {
      throw new AuthenticationError('刷新令牌无效或已过期', ErrorCode.AUTH_EXPIRED);
    }

    const tokenHash = hashToken(refreshToken);
    const row = db.prepare<RefreshTokenRow>(
      'SELECT * FROM refresh_tokens WHERE token_hash = ? AND is_revoked = 0',
    ).get(tokenHash);

    if (!row || row.expires_at < Date.now()) {
      clearRefreshCookie(request, reply, config);
      throw new AuthenticationError('刷新令牌无效或已过期', ErrorCode.AUTH_EXPIRED);
    }

    /* 吊销旧令牌（令牌轮转） */
    db.prepare<void>('UPDATE refresh_tokens SET is_revoked = 1 WHERE id = ?').run(row.id);

    const user = db.prepare<UserRow>('SELECT * FROM users WHERE id = ?').get(row.user_id);
    if (!user) {
      clearRefreshCookie(request, reply, config);
      throw new AuthenticationError('用户不存在', ErrorCode.AUTH_INVALID_TOKEN);
    }

    const tokens = await generateTokenPair(app, db, config, user.id, user.tenant_id, user.role);
    setRefreshCookie(request, reply, config, tokens.refreshToken, config.jwt.refreshTtlMs);
    return { data: { userId: user.id, email: user.email, ...tokens } };
  });

  /* POST /api/v1/auth/logout */
  app.post('/api/v1/auth/logout', async (request, reply) => {
    /* 路由已在 JWT 豁免列表中，手动尝试验证以获取用户上下文 */
    const authHeader = request.headers.authorization;
    if (config.jwt.enabled && authHeader?.startsWith('Bearer ')) {
      try { await request.jwtVerify(); } catch { /* 令牌无效时仍允许 logout 继续 */ }
    }

    /* 吊销 cookie 中的令牌 */
    const cookieToken = extractRefreshToken(request);
    if (cookieToken) {
      const tokenHash = hashToken(cookieToken);
      db.prepare<void>('UPDATE refresh_tokens SET is_revoked = 1 WHERE token_hash = ?').run(tokenHash);
    }

    /* 兼容 body 中的 refreshToken */
    const { refreshToken } = LogoutSchema.parse(request.body ?? {});
    if (refreshToken && refreshToken !== cookieToken) {
      const tokenHash = hashToken(refreshToken);
      db.prepare<void>('UPDATE refresh_tokens SET is_revoked = 1 WHERE token_hash = ?').run(tokenHash);
    }

    /* 如果有 JWT 用户上下文，吊销该用户的所有刷新令牌 */
    const jwtUser = request.user as JwtPayload | undefined;
    if (jwtUser) {
      db.prepare<void>('UPDATE refresh_tokens SET is_revoked = 1 WHERE user_id = ?').run(jwtUser.sub);
    }

    clearRefreshCookie(request, reply, config);
    return reply.status(204).send();
  });
}

/** 生成 access + refresh 令牌对 */
export async function generateTokenPair(
  app: FastifyInstance,
  db: IDatabase,
  config: AppConfig,
  userId: string,
  tenantId: string,
  role: string,
): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
  /* 查询当前订阅计划（用于计划感知限流） */
  const sub = db.prepare<{ plan_id: string }>(
    'SELECT plan_id FROM subscriptions WHERE tenant_id = ? AND status = \'active\' ORDER BY created_at DESC LIMIT 1',
  ).get(tenantId);
  const planId = sub?.plan_id ?? 'free';
  const signPayload = { sub: userId, tenantId, role, planId } as unknown as JwtPayload;
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
  let changes = 0;
  db.transaction(() => {
    changes = db.prepare<void>(
      'DELETE FROM refresh_tokens WHERE (is_revoked = 1 AND created_at < ?) OR (expires_at < ?)',
    ).run(cutoff, cutoff).changes;
  });
  return changes;
}
