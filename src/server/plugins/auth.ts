/**
 * API Key 认证插件
 * 对 /api/* 和 /ws 路由强制校验 X-API-Key（header 或 ?apiKey 查询参数）
 * /healthz, /readyz, /metrics 运维端点豁免
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { AppConfig } from '../../config/schema.js';
import { timingSafeEqual, createHash } from 'node:crypto';

/** 不需要认证的路径前缀（运维端点豁免） */
const PUBLIC_PATHS = new Set(['/healthz', '/readyz', '/metrics']);

function isPublicPath(url: string): boolean {
  for (const p of PUBLIC_PATHS) {
    if (url === p || url.startsWith(p + '/') || url.startsWith(p + '?')) return true;
  }
  return false;
}

/** 常量时间字符串比较，防止时序攻击（先哈希确保等长，避免长度泄露） */
function safeCompare(a: string, b: string): boolean {
  const hashA = createHash('sha256').update(a).digest();
  const hashB = createHash('sha256').update(b).digest();
  return timingSafeEqual(hashA, hashB);
}

export function registerAuth(app: FastifyInstance, config: AppConfig): void {
  if (!config.auth.enabled) return;
  if (config.auth.apiKeys.length === 0) {
    app.log.warn('auth.enabled=true 但 apiKeys 为空，所有需认证的端点将被拒绝访问');
  }

  const validKeys = config.auth.apiKeys;

  app.addHook('onRequest', (request: FastifyRequest, reply: FastifyReply, done) => {
    /* 运维端点和 CORS 预检请求豁免 */
    if (isPublicPath(request.url) || request.method === 'OPTIONS') {
      return done();
    }

    /* 支持 header 和 query 两种传递方式（WebSocket 客户端可能无法设置自定义 header） */
    const rawKey = request.headers['x-api-key']
      ?? (request.query as Record<string, string>)?.apiKey;
    /* 拒绝多值 header（数组）或非字符串值，避免 createHash.update 抛异常导致 500 */
    const apiKey = typeof rawKey === 'string' ? rawKey : undefined;
    if (!apiKey) {
      return reply.status(401).send({
        error: 'AuthenticationError',
        code: 'AUTH_MISSING_KEY',
        message: '缺少 X-API-Key（header 或 ?apiKey= 查询参数）',
      });
    }

    const authorized = validKeys.some(k => safeCompare(apiKey, k));
    if (!authorized) {
      return reply.status(403).send({
        error: 'AuthorizationError',
        code: 'AUTH_INVALID_KEY',
        message: 'API Key 无效',
      });
    }

    done();
  });
}
