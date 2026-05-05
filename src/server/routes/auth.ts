/**
 * 认证路由
 * POST /api/v1/auth/register — 注册
 * POST /api/v1/auth/login    — 登录
 * POST /api/v1/auth/refresh  — 刷新令牌
 * POST /api/v1/auth/logout   — 登出（吊销刷新令牌）
 */

import type { FastifyInstance } from 'fastify';
import type { IDatabase } from '../../storage/database.js';
import type { AppConfig } from '../../config/schema.js';
import type { JwtPayload } from '../../types/auth.js';
import { AuthenticationError, ErrorCode } from '../../errors/index.js';
import { RegisterSchema, LoginSchema, LogoutSchema } from '../schemas/api-schemas.js';
import { AuthService } from '../../identity/auth-service.js';

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
  'ac.nz', 'ac.uk', 'co.jp', 'co.kr', 'co.nz', 'co.uk',
  'com.au', 'com.br', 'com.cn', 'com.hk', 'com.mx', 'com.sg',
  'govt.nz', 'net.au', 'org.au', 'org.nz', 'org.uk',
]);

function getRegistrableSite(hostname: string | undefined): string | undefined {
  if (!hostname) return undefined;
  const normalized = hostname.toLowerCase().replace(/\.$/, '');
  if (normalized === 'localhost' || normalized.endsWith('.localhost')) return 'localhost';
  if (isIpAddressHost(normalized) || normalized === '::1' || normalized === '127.0.0.1' || normalized.startsWith('127.')) return normalized;
  const labels = normalized.split('.').filter(Boolean);
  if (labels.length <= 2) return normalized;
  const suffix = labels.slice(-2).join('.');
  if (labels.length >= 3 && MULTI_LABEL_PUBLIC_SUFFIXES.has(suffix)) return labels.slice(-3).join('.');
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
    return { sameSite: 'Lax', secure: process.env.NODE_ENV === 'production' || secureTransport };
  }
  if (!secureTransport) {
    return { sameSite: 'Lax', secure: false };
  }
  return { sameSite: 'None', secure: true };
}

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

function clearRefreshCookie(request: RefreshCookieRequest, reply: RefreshCookieReply, config: AppConfig): void {
  const policy = resolveRefreshCookiePolicy(request, config);
  reply.header(
    'Set-Cookie',
    `${REFRESH_COOKIE_NAME}=; HttpOnly; Path=/api/v1/auth; SameSite=${policy.sameSite}; Max-Age=0${policy.secure ? '; Secure' : ''}`,
  );
}

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

  const authService = new AuthService(db, config);

  app.post('/api/v1/auth/register', authRateLimit, async (request, reply) => {
    const { email, password } = RegisterSchema.parse(request.body);
    const result = await authService.register(app, email, password);
    setRefreshCookie(request, reply, config, result.refreshToken, config.jwt.refreshTtlMs);
    return reply.status(201).send({ data: result });
  });

  app.post('/api/v1/auth/login', authRateLimit, async (request, reply) => {
    const { email, password } = LoginSchema.parse(request.body);
    const result = await authService.login(app, email, password);
    setRefreshCookie(request, reply, config, result.refreshToken, config.jwt.refreshTtlMs);
    return { data: result };
  });

  app.post('/api/v1/auth/refresh', authRateLimit, async (request, reply) => {
    const refreshToken = extractRefreshToken(request);
    if (!refreshToken || typeof refreshToken !== 'string') {
      throw new AuthenticationError('刷新令牌无效或已过期', ErrorCode.AUTH_EXPIRED);
    }

    try {
      const result = await authService.refresh(app, refreshToken);
      setRefreshCookie(request, reply, config, result.refreshToken, config.jwt.refreshTtlMs);
      return { data: result };
    } catch (err) {
      clearRefreshCookie(request, reply, config);
      throw err;
    }
  });

  app.post('/api/v1/auth/logout', async (request, reply) => {
    const authHeader = request.headers.authorization;
    if (config.jwt.enabled && authHeader?.startsWith('Bearer ')) {
      try { await request.jwtVerify(); } catch { /* 令牌无效时仍允许 logout 继续 */ }
    }

    /* 先吊销 cookie 中的令牌，确保即使 body 解析失败也能吊销 */
    const cookieToken = extractRefreshToken(request);
    if (cookieToken) {
      authService.revokeByRawToken(cookieToken);
    }

    const { refreshToken } = LogoutSchema.parse(request.body ?? {});
    if (refreshToken && refreshToken !== cookieToken) {
      authService.revokeByRawToken(refreshToken);
    }

    const jwtUser = request.user as JwtPayload | undefined;
    authService.logout(undefined, jwtUser);

    clearRefreshCookie(request, reply, config);
    return reply.status(204).send();
  });
}

/** 生成 access + refresh 令牌对（保留导出以兼容外部调用） */
export async function generateTokenPair(
  app: FastifyInstance,
  db: IDatabase,
  config: AppConfig,
  userId: string,
  tenantId: string,
  role: string,
): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
  const authService = new AuthService(db, config);
  return authService.generateTokenPair(app, userId, tenantId, role);
}

/** 清理过期和已吊销的刷新令牌 */
export function cleanupExpiredTokens(db: IDatabase): number {
  return AuthService.cleanupExpired(db);
}
