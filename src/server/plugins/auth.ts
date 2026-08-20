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
import { apikeyQueryByHash } from '@chrono/kernel';
import type { AppConfig } from '../../config/schema.js';
import type { TenantDbResolver } from '../../storage/tenant-db-resolver.js';
import { TenantIdentityDirectory } from '../../identity/tenant-identity-directory.js';
import { registerCoreSelfExecutors } from '../../storage/executors/index.js';
import { timingSafeEqual, createHash } from 'node:crypto';
import { isPlatformOperatorPath, matchesPlatformKey, markPlatformOperator } from './platform-operator.js';

/** 不需要认证的路径前缀（仅健康检查 + JWKS 端点豁免，指标端点需认证）。
 *  ⚠️ 必须与 jwt-auth.ts 的 PUBLIC_PATHS 保持一致 — 一个豁免另一个不豁免
 *  会导致中间件链上一个放行、下一个拦截，公共端点 (例如 JWKS) 会被
 *  API Key 拦截器以 AUTH_MISSING_KEY 拒掉。 */
const PUBLIC_PATHS = new Set([
  '/healthz',
  '/readyz',
  '/api/v1/mcp/capabilities',
  '/.well-known/jwks.json',
]);

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

function isMetricsPath(path: string): boolean {
  return path === '/metrics' || path === '/metrics/prometheus';
}

/** API Key 的 SHA-256 哈希（与数据库存储格式一致） */
function hashKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

/**
 * /metrics 平台凭据门 —— **独立于 `auth.enabled` 注册**。
 *
 * /metrics 暴露的是跨租户聚合（逐租户用量、租户 ID、人群多样性 rollup），
 * 不该被单个租户的 key/JWT 看到，更不该在 auth 关闭时裸奔。
 * 接受两类平台凭据：专用 scrape key（metricsApiKeys）或平台运营密钥
 * （platformOperatorKeys）；**两者都没配 → 403 fail-closed**。
 */
function registerMetricsGate(app: FastifyInstance, config: AppConfig): void {
  const metricsKeys = config.auth.metricsApiKeys;
  app.addHook('onRequest', (request: FastifyRequest, reply: FastifyReply, done) => {
    const path = request.url.split('?')[0];
    if (!isMetricsPath(path)) return done();
    const headerKey = request.headers['x-api-key'];
    const queryKey = (request.query as Record<string, string>)?.apiKey;
    const authz = request.headers.authorization;
    const bearer = typeof authz === 'string' && authz.startsWith('Bearer ')
      ? authz.slice('Bearer '.length).trim() : undefined;
    const presented = typeof headerKey === 'string' ? headerKey
      : typeof queryKey === 'string' ? queryKey
      : bearer;
    /* 滤空串：配置成 [''] 时不得让「出示空 key」匹配成功。 */
    const accepted = [...metricsKeys, ...config.auth.platformOperatorKeys]
      .map((k) => k.trim()).filter((k) => k.length > 0);
    const ok = typeof presented === 'string' && presented.length > 0
      && accepted.some((k) => safeCompare(presented, k));
    if (!ok) {
      return reply.status(403).send({
        error: 'AuthorizationError',
        code: 'AUTH_INVALID_KEY',
        message: accepted.length === 0
          ? '平台指标已 fail-closed：需先配置 metricsApiKeys 或 platformOperatorKeys'
          : '平台指标仅接受平台凭据（metricsApiKeys / platformOperatorKeys）',
      });
    }
    /* 平台凭据校验通过：绑定平台运营者身份（非任一租户），放行。 */
    request.user = {
      sub: 'metrics:scrape', tenantId: 'default', role: 'member', planId: 'free', iat: 0, exp: 0,
    };
    return done();
  });
}

/**
 * API Key 认证插件（分片 Plan 1c Task 7）。
 *
 * 收 `resolver`（TenantDbResolver）而非裸 db：DB Key 校验走 **api_key_hash→tenant 目录定位**（协调库）
 * → `dbForTenant` 取该 tenant 所在 shard → 查 api_keys 行（shard is_revoked=权威）。目录=定位器：
 * 目录多余/过期项只导致「定位到 shard 后被拒」（安全），绝不越权。未命中目录时回退 coordinatorDb() 单库直查
 * （单库下 coordinator === shard；多库老 key 无目录项时的过渡查询，仍受 shard is_revoked 权威约束）。
 */
export function registerAuth(app: FastifyInstance, config: AppConfig, resolver?: TenantDbResolver): void {
  /* ⚠️ 审计 P0（交叉审查补）：/metrics 的平台凭据门**不能**挂在
   * `auth.enabled` 这个总开关下面。auth 关闭时整个 hook 不注册，
   * 跨租户聚合指标（逐租户用量 + 租户 ID）就**裸奔**——实测无任何凭据返回 200。
   * 故先单独注册 metrics 门，再按 auth.enabled 决定要不要注册通用 API-Key 认证。 */
  registerMetricsGate(app, config);

  if (!config.auth.enabled) return;

  const validKeys = config.auth.apiKeys;
  const metricsKeys = config.auth.metricsApiKeys;

  if (validKeys.length === 0 && !resolver) {
    app.log.warn('auth.enabled=true 但 apiKeys 为空且无 DB，所有需认证的端点将被拒绝访问');
  }

  if (resolver) registerCoreSelfExecutors();
  /* 目录门面按 resolver 定位 tenant；单库下 coordinator===shard，行为等价现状。 */
  const directory = resolver ? new TenantIdentityDirectory(resolver) : null;

  app.addHook('onRequest', (request: FastifyRequest, reply: FastifyReply, done) => {
    /* 运维端点和 CORS 预检请求豁免 */
    if (isPublicPath(request.url) || request.method === 'OPTIONS') {
      return done();
    }

    const path = request.url.split('?')[0];
    const metricsRoute = isMetricsPath(path);

    /* 平台运营密钥（审计 P0 · 交叉审查补）：本 hook 注册在 jwt-auth **之前**，
     * 若不在此识别，平台请求会先被「缺少 X-API-Key」401 掉，根本走不到
     * jwt-auth 与路由守卫（auth.enabled=true 的生产组合下必现）。
     * 仅对平台端点放行，且只打能力标记、不伪造租户身份。 */
    if (isPlatformOperatorPath(path)
      && config.auth.platformOperatorKeys.length > 0
      && matchesPlatformKey(request, config.auth.platformOperatorKeys)) {
      markPlatformOperator(request);
      return done();
    }



    /* 如果已经通过 JWT 认证（由 jwt-auth 插件设置），跳过 API Key 检查 */
    if (request.user) {
      return done();
    }

    const authHeader = request.headers.authorization;
    if (path.startsWith('/api/v1/auth/')) {
      return done();
    }
    if (path.startsWith('/scim/')) {
      return done();
    }

    const bearerToken = typeof authHeader === 'string' && authHeader.startsWith('Bearer ')
      ? authHeader.slice('Bearer '.length).trim()
      : undefined;

    /* 支持 header、query，以及 metrics 路由上的 Bearer scrape token */
    const rawKey = request.headers['x-api-key']
      ?? (request.query as Record<string, string>)?.apiKey
      ?? (metricsRoute ? bearerToken : undefined);
    /* 拒绝多值 header（数组）或非字符串值，避免 createHash.update 抛异常导致 500 */
    const apiKey = typeof rawKey === 'string' ? rawKey : undefined;

    /* 非 metrics 路由上的 Bearer token 交给 jwt-auth 插件处理，避免误拒 JWT 请求 */
    if (!apiKey && config.jwt.enabled && bearerToken) {
      return done();
    }

    if (!apiKey) {
      return reply.status(401).send({
        error: 'AuthenticationError',
        code: 'AUTH_MISSING_KEY',
        message: '缺少 X-API-Key（header 或 ?apiKey= 查询参数）',
      });
    }

    /* 优先从 DB 查找 API Key（绑定租户和计划）。分片 Plan 1c Task 7：目录=定位器 → dbForTenant → shard 权威。 */
    if (directory && resolver) {
      try {
        const keyHash = hashKey(apiKey);
        /* ① api_key_hash→tenant 目录反查（仅定位，不判有效性）。命中→该 tenant 所在 shard；
         *    未命中→回退 coordinatorDb() 单库直查（单库下等价现状；多库老 key 无目录项时的过渡）。 */
        const entry = directory.resolveByApiKeyHash(keyHash);
        const tx = entry ? resolver.dbForTenant(entry.tenantId) : resolver.coordinatorDb();
        /* ② shard 权威校验：apikeyQueryByHash 的 SQL 已含 `AND is_revoked = 0`（shard 权威过滤），
         *    另显式再验 row.is_revoked 作纵深防御——目录多余/过期项只导致此处被 shard 拒，不越权。 */
        const row = tx.queryOne(apikeyQueryByHash(keyHash));
        if (row && !row.is_revoked) {
          /* 注入伪 JWT user 以便下游计划感知限流和租户解析.
           * iat/exp 不适用于 API key,但 JwtPayload 类型要求它们;
           * 用 0 占位且 cast 缩窄. */
          request.user = {
            sub: `apikey:${row.id}`,
            tenantId: row.tenant_id,
            role: 'member',
            planId: row.plan_id,
            iat: 0,
            exp: 0,
          };
          return done();
        }
      } catch { /* api_keys 表可能尚未创建 / 目录查询失败，静默回退到静态 Key（认证失败不 500） */ }
    }

    const staticKeys = metricsRoute ? [...metricsKeys, ...validKeys] : validKeys;

    /* requireDbKeys 启用时禁止静态 Key 回退（生产环境强制 DB Key） */
    if (config.auth.requireDbKeys && !(metricsRoute && metricsKeys.length > 0)) {
      return reply.status(403).send({
        error: 'AuthorizationError',
        code: 'AUTH_INVALID_KEY',
        message: 'API Key 无效（生产模式仅接受 DB 管理的 Key）',
      });
    }

    /* 回退到配置文件静态 Key（向后兼容，固定绑定 default 租户） */
    const authorized = staticKeys.some(k => safeCompare(apiKey, k));
    if (!authorized) {
      if (metricsRoute && config.jwt.enabled && bearerToken) {
        return done();
      }
      return reply.status(403).send({
        error: 'AuthorizationError',
        code: 'AUTH_INVALID_KEY',
        message: 'API Key 无效',
      });
    }

    /* 静态 Key 强制绑定 default 租户，防止 X-Tenant-Id 头伪造 */
    request.user = {
      sub: 'apikey:static',
      tenantId: 'default',
      role: 'member',
      planId: 'free',
      iat: 0,
      exp: 0,
    };

    done();
  });
}
