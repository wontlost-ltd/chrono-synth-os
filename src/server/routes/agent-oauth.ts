/**
 * Agent OAuth 路由（用户级 Google 授权）
 *
 * 端点：
 *   POST   /api/v1/agent/oauth/google/authorize  — 生成授权 URL（需 JWT）
 *   GET    /api/v1/agent/oauth/google/callback   — Google 重定向回调（无 JWT；用 state 识别用户）
 *   GET    /api/v1/agent/oauth/google            — 列出当前用户已授权 scope
 *   DELETE /api/v1/agent/oauth/google/:id        — 撤销
 *
 * 安全：
 *   - state 仅存于 redis/memory，TTL 5min，单次使用
 *   - state 携带 tenantId + userId + scope + redirectAfter
 *   - callback 失败不写库；重试要求新生成 state
 *   - 撤销同时调用 Google revoke endpoint，删除 refresh token 持有
 */

import type { FastifyInstance } from 'fastify';
import { randomBytes } from 'node:crypto';
import type { GoogleOauthFlow } from '../../agent/oauth-google-flow.js';
import type { UserOauthTokenService } from '../../agent/user-oauth-token-service.js';
import type { AppConfig } from '../../config/schema.js';
import { ValidationError, AuthenticationError, ErrorCode } from '../../errors/index.js';
import type { JwtPayload } from '../../types/auth.js';
import {
  AgentOauthAuthorizeBodySchema,
  AgentOauthCallbackQuerySchema,
  AgentOauthScopeQuerySchema,
  AgentOauthRevokeBodySchema,
} from '../schemas/api-schemas.js';

const STATE_TTL_MS = 5 * 60_000;
const ALLOWED_SCOPES = new Set([
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/gmail.send',
]);

interface PendingState {
  readonly tenantId: string;
  readonly userId: string;
  readonly scope: string;
  readonly redirectAfter: string;
  readonly createdAt: number;
}

interface AgentOauthStateStore {
  set(state: string, data: PendingState): Promise<void>;
  getAndDelete(state: string): Promise<PendingState | null>;
}

interface RedisClient {
  set(key: string, value: string, mode: string, ttl: number): Promise<unknown>;
  get(key: string): Promise<string | null>;
  del(key: string): Promise<unknown>;
}

function createRedisStore(redis: RedisClient): AgentOauthStateStore {
  const prefix = 'agent_oauth_state:';
  return {
    async set(state, data) {
      await redis.set(`${prefix}${state}`, JSON.stringify(data), 'EX', Math.floor(STATE_TTL_MS / 1000));
    },
    async getAndDelete(state) {
      const raw = await redis.get(`${prefix}${state}`);
      if (!raw) return null;
      await redis.del(`${prefix}${state}`);
      try { return JSON.parse(raw); } catch { return null; }
    },
  };
}

function createMemoryStore(): AgentOauthStateStore {
  const MAX_PENDING = 10_000;
  const pending = new Map<string, PendingState>();
  function gc() {
    const cutoff = Date.now() - STATE_TTL_MS;
    for (const [k, v] of pending) {
      if (v.createdAt < cutoff) pending.delete(k);
    }
    if (pending.size > MAX_PENDING) {
      const iter = pending.keys();
      let toRemove = pending.size - MAX_PENDING;
      while (toRemove-- > 0) {
        const k = iter.next().value;
        if (k) pending.delete(k);
      }
    }
  }
  return {
    async set(state, data) {
      gc();
      pending.set(state, data);
    },
    async getAndDelete(state) {
      gc();
      const entry = pending.get(state);
      if (!entry) return null;
      pending.delete(state);
      return entry;
    },
  };
}


export interface RegisterAgentOauthRoutesDeps {
  readonly googleFlow: GoogleOauthFlow | null;
  readonly tokens: UserOauthTokenService;
  readonly config: AppConfig;
}

export function registerAgentOauthRoutes(app: FastifyInstance, deps: RegisterAgentOauthRoutesDeps): void {
  const { googleFlow, tokens } = deps;
  /* google_oauth 未配置时仍注册路由但返回 503，避免前端 404 */
  const stateStore: AgentOauthStateStore = app.redis
    ? createRedisStore(app.redis)
    : createMemoryStore();

  const rateLimit = {
    config: {
      rateLimit: {
        max: 30,
        timeWindow: 60_000,
        keyGenerator: (request: { ip: string }) => request.ip,
      },
    },
  };

  app.post('/api/v1/agent/oauth/google/authorize', rateLimit, async (request, reply) => {
    if (!googleFlow) {
      reply.status(503);
      return { error: 'ServiceUnavailable', code: 'OAUTH_GOOGLE_NOT_CONFIGURED', message: 'Google OAuth 未配置' };
    }
    const user = request.user as JwtPayload | undefined;
    if (!user?.sub) {
      throw new AuthenticationError('需要 JWT 认证', ErrorCode.AUTH_INVALID_TOKEN);
    }
    const body = AgentOauthAuthorizeBodySchema.parse(request.body);
    if (!ALLOWED_SCOPES.has(body.scope)) {
      throw new ValidationError(`scope 不在白名单: ${body.scope}`, ErrorCode.VALIDATION_FORMAT);
    }
    const state = randomBytes(32).toString('base64url');
    await stateStore.set(state, {
      tenantId: request.tenantId,
      userId: user.sub,
      scope: body.scope,
      redirectAfter: body.redirectAfter,
      createdAt: Date.now(),
    });
    const authorizeUrl = googleFlow.buildAuthorizeUrl({
      scope: body.scope,
      state,
    });
    return reply.send({ data: { authorizeUrl } });
  });

  app.get('/api/v1/agent/oauth/google/callback', rateLimit, async (request, reply) => {
    if (!googleFlow) {
      reply.status(503);
      return { error: 'ServiceUnavailable', code: 'OAUTH_GOOGLE_NOT_CONFIGURED', message: 'Google OAuth 未配置' };
    }
    const query = AgentOauthCallbackQuerySchema.parse(request.query);
    if (query.error) {
      reply.status(400);
      return { error: 'OauthError', code: 'OAUTH_PROVIDER_ERROR', message: query.error_description ?? query.error };
    }
    if (!query.code || !query.state) {
      throw new ValidationError('缺少 code 或 state', ErrorCode.VALIDATION_REQUIRED);
    }
    const pending = await stateStore.getAndDelete(query.state);
    if (!pending) {
      throw new AuthenticationError('state 已过期或无效', ErrorCode.AUTH_INVALID_TOKEN);
    }
    if (Date.now() - pending.createdAt > STATE_TTL_MS) {
      throw new AuthenticationError('state 已过期', ErrorCode.AUTH_INVALID_TOKEN);
    }

    const tokenResult = await googleFlow.exchangeCodeForToken(query.code);
    tokens.upsert({
      tenantId: pending.tenantId,
      userId: pending.userId,
      provider: 'google',
      scope: pending.scope,
      accessToken: tokenResult.accessToken,
      refreshToken: tokenResult.refreshToken,
      accessExpiresAt: tokenResult.accessExpiresAt,
    });

    /* 重定向回前端；使用 server.publicUrl 作为基础避免 open redirect */
    if (!deps.config.server.publicUrl) {
      reply.status(500);
      return { error: 'ConfigError', code: 'CONFIG_INVALID', message: 'server.publicUrl 未配置' };
    }
    const baseUrl = deps.config.server.publicUrl.replace(/\/+$/, '');
    const target = pending.redirectAfter.startsWith('/') ? pending.redirectAfter : '/';
    return reply.redirect(`${baseUrl}${target}?oauth=success&scope=${encodeURIComponent(pending.scope)}`);
  });

  app.get('/api/v1/agent/oauth/google', async (request, reply) => {
    const user = request.user as JwtPayload | undefined;
    if (!user?.sub) {
      throw new AuthenticationError('需要 JWT 认证', ErrorCode.AUTH_INVALID_TOKEN);
    }
    return reply.send({ data: tokens.listByUser(request.tenantId, user.sub) });
  });

  app.get<{ Querystring: { scope: string } }>('/api/v1/agent/oauth/google/scope', async (request, reply) => {
    const user = request.user as JwtPayload | undefined;
    if (!user?.sub) {
      throw new AuthenticationError('需要 JWT 认证', ErrorCode.AUTH_INVALID_TOKEN);
    }
    const q = AgentOauthScopeQuerySchema.parse(request.query);
    const token = tokens.get({
      tenantId: request.tenantId,
      userId: user.sub,
      provider: 'google',
      scope: q.scope,
    });
    if (!token) return reply.status(404).send({ error: 'NotFound', code: 'OAUTH_NOT_AUTHORIZED', message: '未授权该 scope' });
    /* 仅返回元数据 */
    const { accessToken: _accessToken, refreshToken: _refreshToken, ...meta } = token;
    return reply.send({ data: meta });
  });

  app.delete<{ Params: { id: string } }>('/api/v1/agent/oauth/google/:id', async (request, reply) => {
    const user = request.user as JwtPayload | undefined;
    if (!user?.sub) {
      throw new AuthenticationError('需要 JWT 认证', ErrorCode.AUTH_INVALID_TOKEN);
    }
    const body = AgentOauthRevokeBodySchema.parse(request.body ?? {});
    /* 验证归属：列出此用户授权后比对 id */
    const list = tokens.listByUser(request.tenantId, user.sub);
    const owned = list.find((t) => t.id === request.params.id);
    if (!owned) {
      reply.status(404);
      return { error: 'NotFound', code: 'NOT_FOUND_VALUE', message: 'token 不存在或不属于当前用户' };
    }
    /* 先尝试撤销远端（best-effort），再写库；失败也保留 reason */
    if (googleFlow) {
      const full = tokens.get({
        tenantId: request.tenantId,
        userId: user.sub,
        provider: 'google',
        scope: owned.scope,
      });
      if (full?.refreshToken) {
        await googleFlow.revokeToken(full.refreshToken).catch(() => false);
      } else if (full?.accessToken) {
        await googleFlow.revokeToken(full.accessToken).catch(() => false);
      }
    }
    const ok = tokens.revoke(request.params.id, body.reason);
    return reply.send({ data: { revoked: ok } });
  });
}
