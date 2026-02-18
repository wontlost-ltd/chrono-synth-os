/**
 * JWT 认证插件
 * 对 /api/* 路由验证 Bearer 令牌，解码后注入 request.user
 * 与 API Key 认证共存：优先检查 Bearer token，无 token 时回退到 API Key
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import type { AppConfig } from '../../config/schema.js';
import type { JwtPayload } from '../../types/auth.js';

/** 扩展 @fastify/jwt 类型以使用自定义载荷 */
declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: JwtPayload;
    user: JwtPayload;
  }
}

/** 不需要认证的路径前缀（运维端点豁免） */
const PUBLIC_PATHS = new Set(['/healthz', '/readyz', '/metrics']);

/** 认证路由自身豁免（注册/登录无需 token） */
const AUTH_PATHS = new Set([
  '/api/v1/auth/login',
  '/api/v1/auth/register',
  '/api/v1/auth/refresh',
  '/api/v1/auth/logout',
  '/api/v1/auth/sso/authorize',
  '/api/v1/auth/sso/callback',
  '/api/v1/billing/plans',
]);

function isPublicPath(url: string): boolean {
  const path = url.split('?')[0];
  if (PUBLIC_PATHS.has(path)) return true;
  if (AUTH_PATHS.has(path)) return true;
  /* Stripe webhook 豁免（由 Stripe 签名验证保护） */
  if (path === '/api/v1/billing/webhook') return true;
  return false;
}

declare module 'fastify' {
  interface FastifyInstance {
    jwtEnabled: boolean;
  }
}

export async function registerJwtAuth(app: FastifyInstance, config: AppConfig): Promise<void> {
  app.decorate('jwtEnabled', config.jwt.enabled);
  if (!config.jwt.enabled) return;

  await app.register(fastifyJwt, {
    secret: config.jwt.secret,
    sign: {
      iss: config.jwt.issuer,
      expiresIn: Math.floor(config.jwt.accessTtlMs / 1000),
    },
    verify: {
      allowedIss: config.jwt.issuer,
    },
  });

  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    if (isPublicPath(request.url) || request.method === 'OPTIONS') return;

    const authHeader = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      /* 无 Bearer token — 回退到 API Key 认证（由 auth.ts 插件处理） */
      /* 若 API Key 认证也未启用，则需要 JWT，拒绝无认证请求 */
      if (!config.auth.enabled) {
        return reply.status(401).send({
          error: 'AuthenticationError',
          code: 'AUTH_REQUIRED',
          message: '需要 Bearer 令牌',
        });
      }
      return;
    }

    try {
      await request.jwtVerify();
    } catch {
      return reply.status(401).send({
        error: 'AuthenticationError',
        code: 'AUTH_INVALID_TOKEN',
        message: '令牌无效或已过期',
      });
    }
  });
}
