/**
 * 平台运营者身份守卫（P0 审计修复）。
 *
 * ## 问题
 *
 * 一批**影响全平台**的端点此前只校验 `role === 'admin'`，而 `admin` 是**租户内**角色：
 * `sso-user-service.ts` 的策略是「首用户 admin、后续 member」，即**任何人注册一个新租户
 * 即自动成为 admin**。于是租户 A 的管理员可以：
 *
 *   - 轮换**全局 JWT 签名密钥**（信任根）→ 伪造任意租户的 admin 令牌 → 完整认证绕过
 *   - 改**全局运行时配置**（如 rateLimit）→ 影响所有租户
 *   - 改**全局 add-on 商品目录** → 影响所有租户计费
 *
 * 根因是**缺少「平台运营者」与「租户管理员」的边界**，而非某个端点写错。
 *
 * ## 做法
 *
 * 复用仓库已有的平台凭据范式（`auth.ts` 的 `metricsApiKeys` 平台 scrape key）：
 * 平台身份由**带外配置的密钥**证明，而不是由租户内 JWT 角色证明——租户永远拿不到它。
 *
 * ⚠️ 与 metrics 的关键差异：**未配置时 fail-closed**。metrics 未配置 scrape key 时保持
 * 向后兼容放行（泄漏的只是聚合指标）；而这里守的是信任根与全局配置，「没配置就人人可用」
 * 恰恰是当前漏洞本身，故未配置一律 503 拒绝，只能走带外运维通道。
 */

import type { FastifyRequest, FastifyReply } from 'fastify';
import { timingSafeEqual, createHash } from 'node:crypto';
import type { AppConfig } from '../../config/schema.js';

/** 定长比较，避免按字节提前返回泄漏前缀信息。先 SHA-256 归一化长度。 */
function safeCompare(a: string, b: string): boolean {
  const hashA = createHash('sha256').update(a).digest();
  const hashB = createHash('sha256').update(b).digest();
  return timingSafeEqual(hashA, hashB);
}

/** 从请求里取出出示的平台密钥（header 优先，其次 Bearer）。 */
function presentedKey(request: FastifyRequest): string | undefined {
  const headerKey = request.headers['x-platform-key'];
  if (typeof headerKey === 'string' && headerKey.length > 0) return headerKey;
  const authz = request.headers.authorization;
  if (typeof authz === 'string' && authz.startsWith('Bearer ')) {
    const bearer = authz.slice('Bearer '.length).trim();
    return bearer.length > 0 ? bearer : undefined;
  }
  return undefined;
}

/**
 * 请求是否出示了有效的平台运营密钥。
 *
 * 供**认证层**（jwt-auth 的 onRequest）先行识别平台身份用：平台运营者不属于任何
 * 租户、没有 JWT，若不在此处放行会被「需要 Bearer 令牌」挡在路由守卫之前。
 * 认证与授权仍分离——此函数只回答「是不是平台运营者」，
 * 「能不能调这个端点」由 `requirePlatformOperator` 判定。
 */
export function matchesPlatformKey(request: FastifyRequest, keys: readonly string[]): boolean {
  if (keys.length === 0) return false;
  const presented = presentedKey(request);
  return typeof presented === 'string' && keys.some((k) => safeCompare(presented, k));
}

/**
 * 构造 preHandler：仅放行持有平台运营密钥的请求。
 *
 * 判定顺序刻意如此：
 *  1. **未配置 → 503**（fail-closed）。不能退回「租户 admin 也行」，那正是漏洞。
 *  2. 未出示 / 不匹配 → 403，且**不区分**两者的错误文案，避免探测出「密钥是否已配置」。
 */
export function requirePlatformOperator(config: AppConfig) {
  const keys = config.auth.platformOperatorKeys;

  return async function guard(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    if (keys.length === 0) {
      return reply.status(503).send({
        error: 'ConfigurationError',
        code: 'PLATFORM_OPERATOR_NOT_CONFIGURED',
        message: '该端点影响全平台，需先配置 CHRONO_AUTH_PLATFORM_OPERATOR_KEYS 才能使用；'
          + '租户管理员无权调用。',
      });
    }

    const presented = presentedKey(request);
    const ok = typeof presented === 'string' && keys.some((k) => safeCompare(presented, k));
    if (!ok) {
      return reply.status(403).send({
        error: 'AuthorizationError',
        code: 'AUTH_PLATFORM_OPERATOR_REQUIRED',
        message: '该操作影响全平台，仅接受平台运营密钥（X-Platform-Key）。',
      });
    }
  };
}
