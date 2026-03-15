import { randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { IDatabase } from '../../storage/database.js';
import type { AppConfig } from '../../config/schema.js';
import type { UserRole } from '../../types/auth.js';
import { AuthenticationError, ConfigError, ErrorCode, ValidationError } from '../../errors/index.js';
import { syncPlanToQuota } from '../../billing/plans.js';
import { IdentityService } from '../../identity/identity-service.js';
import { OidcAuthorizeQuerySchema, OidcCallbackQuerySchema } from '../schemas/api-schemas.js';
import { buildOidcAuthorizeUrl, exchangeOidcCode, fetchOidcUserInfo } from '../plugins/oidc.js';
import { generateTokenPair, setRefreshCookie } from './auth.js';
import { TenantEnterpriseProfileService } from '../../enterprise/tenant-enterprise-profile-service.js';

interface OidcStateStore {
  set(state: string, data: { redirectUri: string; tenantId: string }): Promise<void>;
  getAndDelete(state: string): Promise<{ redirectUri: string; tenantId: string } | null>;
}

interface RedisClient {
  set(key: string, value: string, mode: string, ttl: number): Promise<unknown>;
  get(key: string): Promise<string | null>;
  del(key: string): Promise<unknown>;
}

const STATE_TTL_SECONDS = 300;

function createRedisStateStore(redis: RedisClient): OidcStateStore {
  const prefix = 'oidc_state:';
  return {
    async set(state, data) {
      await redis.set(`${prefix}${state}`, JSON.stringify(data), 'EX', STATE_TTL_SECONDS);
    },
    async getAndDelete(state) {
      const raw = await redis.get(`${prefix}${state}`);
      if (!raw) return null;
      await redis.del(`${prefix}${state}`);
      try {
        return JSON.parse(raw) as { redirectUri: string; tenantId: string };
      } catch {
        return null;
      }
    },
  };
}

function createMemoryStateStore(): OidcStateStore {
  const pending = new Map<string, { redirectUri: string; tenantId: string; createdAt: number }>();
  const ttlMs = STATE_TTL_SECONDS * 1000;

  function clean(): void {
    const cutoff = Date.now() - ttlMs;
    for (const [state, entry] of pending) {
      if (entry.createdAt < cutoff) pending.delete(state);
    }
  }

  return {
    async set(state, data) {
      clean();
      pending.set(state, { ...data, createdAt: Date.now() });
    },
    async getAndDelete(state) {
      const entry = pending.get(state);
      if (!entry || Date.now() - entry.createdAt > ttlMs) {
        if (entry) pending.delete(state);
        return null;
      }
      pending.delete(state);
      return {
        redirectUri: entry.redirectUri,
        tenantId: entry.tenantId,
      };
    },
  };
}

async function ensureTenantBootstrap(
  db: IDatabase,
  tenantId: string,
  userId: string,
  email: string,
): Promise<void> {
  const sub = db.prepare<{ id: string }>(
    'SELECT id FROM subscriptions WHERE tenant_id = ? LIMIT 1',
  ).get(tenantId);
  if (!sub) {
    const now = Date.now();
    db.prepare<void>(
      `INSERT INTO subscriptions (
        id, tenant_id, stripe_customer_id, plan_id, status, current_period_start, current_period_end, created_at, updated_at
      ) VALUES (?, ?, NULL, 'free', 'active', ?, ?, ?, ?)`,
    ).run(`sub_${randomUUID()}`, tenantId, now, now + 365 * 24 * 60 * 60 * 1000, now, now);
    syncPlanToQuota(db, tenantId, 'free');
  }

  const identityService = new IdentityService(db);
  identityService.ensureForUser(userId, tenantId, email.split('@')[0]);
}

export function registerOidcRoutes(app: FastifyInstance, db: IDatabase, config: AppConfig): void {
  if (!config.jwt.enabled) return;

  const baseUrl = config.server.publicUrl;
  const profileService = new TenantEnterpriseProfileService(db, config);
  const stateStore: OidcStateStore = app.redis
    ? createRedisStateStore(app.redis as unknown as RedisClient)
    : createMemoryStateStore();

  const oidcRateLimit = {
    config: {
      rateLimit: {
        max: 5,
        timeWindow: 60_000,
        keyGenerator: (request: { ip: string }) => request.ip,
      },
    },
  };

  app.get('/api/v1/auth/oidc/login', oidcRateLimit, async (request, reply) => {
    if (!baseUrl) {
      throw new ConfigError('OIDC 启用但 server.publicUrl 未配置', ErrorCode.CONFIG_INVALID);
    }

    const { redirect_uri, tenant_id } = OidcAuthorizeQuerySchema.parse(request.query);
    const tenantId = tenant_id?.trim() || request.tenantId;
    const oidc = profileService.getEffectiveOidcConfig(tenantId);
    if (!oidc) {
      throw new ConfigError(`tenant ${tenantId} 未配置 OIDC`, ErrorCode.CONFIG_INVALID);
    }

    const redirectPath = (redirect_uri && redirect_uri.startsWith('/') && !redirect_uri.startsWith('//'))
      ? redirect_uri
      : '/';
    const callbackUri = `${baseUrl}/api/v1/auth/oidc/callback`;
    const state = randomBytes(32).toString('hex');

    await stateStore.set(state, { redirectUri: redirectPath, tenantId });

    const authorizeUrl = await buildOidcAuthorizeUrl({
      issuerUrl: oidc.issuerUrl,
      clientId: oidc.clientId,
      clientSecret: oidc.clientSecret,
      audience: oidc.audience,
      scope: oidc.scope,
    }, callbackUri, state);
    return reply.redirect(authorizeUrl);
  });

  app.get('/api/v1/auth/oidc/callback', oidcRateLimit, async (request, reply) => {
    const { code, state, error } = OidcCallbackQuerySchema.parse(request.query);
    if (error) {
      throw new AuthenticationError(`OIDC 错误: ${error}`, ErrorCode.AUTH_SSO_FAILED);
    }
    if (!code || !state) {
      throw new ValidationError('缺少 code 或 state 参数', ErrorCode.VALIDATION_REQUIRED);
    }

    const pending = await stateStore.getAndDelete(state);
    if (!pending) {
      throw new AuthenticationError('state 参数无效或已过期', ErrorCode.AUTH_SSO_FAILED);
    }
    if (!baseUrl) {
      throw new ConfigError('OIDC 未配置回调地址', ErrorCode.CONFIG_INVALID);
    }

    const oidc = profileService.getEffectiveOidcConfig(pending.tenantId);
    if (!oidc) {
      throw new ConfigError(`tenant ${pending.tenantId} 未配置 OIDC`, ErrorCode.CONFIG_INVALID);
    }

    const callbackUri = `${baseUrl}/api/v1/auth/oidc/callback`;
    const tokens = await exchangeOidcCode({
      issuerUrl: oidc.issuerUrl,
      clientId: oidc.clientId,
      clientSecret: oidc.clientSecret,
      audience: oidc.audience,
      scope: oidc.scope,
    }, code, callbackUri);
    const userInfo = await fetchOidcUserInfo({
      issuerUrl: oidc.issuerUrl,
      clientId: oidc.clientId,
      clientSecret: oidc.clientSecret,
      audience: oidc.audience,
      scope: oidc.scope,
    }, tokens.access_token);

    const rawEmail = userInfo[oidc.emailClaim];
    const rawName = userInfo[oidc.nameClaim];
    const email = typeof rawEmail === 'string' ? rawEmail : undefined;
    if (!email) {
      throw new AuthenticationError('OIDC userinfo 未返回邮箱字段', ErrorCode.AUTH_SSO_FAILED);
    }

    const existingUser = db.prepare<{ id: string; tenant_id: string; role: UserRole }>(
      'SELECT id, tenant_id, role FROM users WHERE email = ? LIMIT 1',
    ).get(email);

    let userId: string;
    let role: UserRole;

    if (existingUser) {
      if (existingUser.tenant_id !== pending.tenantId) {
        throw new AuthenticationError('该邮箱已绑定其他 tenant，无法通过当前 OIDC 租户登录', ErrorCode.AUTH_SSO_FAILED);
      }
      userId = existingUser.id;
      role = existingUser.role;
    } else {
      userId = `user_${randomUUID()}`;
      const now = Date.now();
      const userCount = db.prepare<{ count: number }>(
        'SELECT COUNT(*) AS count FROM users WHERE tenant_id = ?',
      ).get(pending.tenantId)?.count ?? 0;
      role = userCount === 0 ? 'admin' : 'member';
      db.prepare<void>(
        `INSERT INTO users (id, email, password_hash, role, tenant_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(userId, email, 'oidc-managed', role, pending.tenantId, now, now);
      await ensureTenantBootstrap(db, pending.tenantId, userId, email);
      if (typeof rawName === 'string' && rawName.trim()) {
        db.prepare<void>('UPDATE identities SET display_name = ?, updated_at = ? WHERE user_id = ?')
          .run(rawName.trim(), now, userId);
      }
    }

    await ensureTenantBootstrap(db, pending.tenantId, userId, email);
    const issued = await generateTokenPair(app, db, config, userId, pending.tenantId, role);
    setRefreshCookie(request, reply, config, issued.refreshToken, config.jwt.refreshTtlMs);

    const redirectUrl = new URL(pending.redirectUri, baseUrl);
    redirectUrl.hash = `access_token=${issued.accessToken}&refresh_token=${issued.refreshToken}`;
    return reply.redirect(redirectUrl.toString());
  });
}
