/**
 * API Key 认证插件
 * 对 /api/* 和 /ws 路由强制校验 X-API-Key（header 或 ?apiKey 查询参数）
 * /healthz, /readyz 运维端点豁免
 *
 * 支持两种 API Key 来源：
 * 1. 配置文件静态 Key（向后兼容，无租户绑定）
 * 2. DB 存储的 Key（绑定 tenantId + planId，支持计划感知限流）
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { AppConfig } from '../../config/schema.js';
import type { IDatabase } from '../../storage/database.js';
import { timingSafeEqual, createHash } from 'node:crypto';

/** 不需要认证的路径前缀（仅健康检查端点豁免，指标端点需认证） */
const PUBLIC_PATHS = new Set(['/healthz', '/readyz']);

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

interface ApiKeyRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly key_hash: string;
  readonly plan_id: string;
  readonly is_revoked: number;
}

/** API Key 的 SHA-256 哈希（与数据库存储格式一致） */
function hashKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

export function registerAuth(app: FastifyInstance, config: AppConfig, db?: IDatabase): void {
  if (!config.auth.enabled) return;

  const validKeys = config.auth.apiKeys;

  if (validKeys.length === 0 && !db) {
    app.log.warn('auth.enabled=true 但 apiKeys 为空且无 DB，所有需认证的端点将被拒绝访问');
  }

  app.addHook('onRequest', (request: FastifyRequest, reply: FastifyReply, done) => {
    /* 运维端点和 CORS 预检请求豁免 */
    if (isPublicPath(request.url) || request.method === 'OPTIONS') {
      return done();
    }

    /* 如果已经通过 JWT 认证（由 jwt-auth 插件设置），跳过 API Key 检查 */
    if (request.user) {
      return done();
    }

    /* 携带 Bearer token 时交给 jwt-auth 插件处理，避免误拒 JWT 请求 */
    const authHeader = request.headers.authorization;
    if (config.jwt.enabled && authHeader && authHeader.startsWith('Bearer ')) {
      return done();
    }

    /* 认证路由自身豁免 */
    const path = request.url.split('?')[0];
    if (path.startsWith('/api/v1/auth/')) {
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

    /* 优先从 DB 查找 API Key（绑定租户和计划） */
    if (db) {
      try {
        const keyHash = hashKey(apiKey);
        const row = db.prepare<ApiKeyRow>(
          'SELECT id, tenant_id, key_hash, plan_id, is_revoked FROM api_keys WHERE key_hash = ? AND is_revoked = 0',
        ).get(keyHash);
        if (row) {
          /* 注入伪 JWT user 以便下游计划感知限流和租户解析 */
          (request as unknown as { user: { sub: string; tenantId: string; role: string; planId: string } }).user = {
            sub: `apikey:${row.id}`,
            tenantId: row.tenant_id,
            role: 'member',
            planId: row.plan_id,
          };
          return done();
        }
      } catch { /* api_keys 表可能尚未创建，回退到静态 Key */ }
    }

    /* requireDbKeys 启用时禁止静态 Key 回退（生产环境强制 DB Key） */
    if (config.auth.requireDbKeys) {
      return reply.status(403).send({
        error: 'AuthorizationError',
        code: 'AUTH_INVALID_KEY',
        message: 'API Key 无效（生产模式仅接受 DB 管理的 Key）',
      });
    }

    /* 回退到配置文件静态 Key（向后兼容，无租户绑定） */
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
