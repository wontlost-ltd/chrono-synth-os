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

/**
 * 受平台运营密钥保护的路径。**认证层只在这些路径上认平台密钥**——
 * 否则该密钥会变成一把「以 default 租户身份访问任意端点」的万能钥匙
 * （交叉审查发现：`/api/v1/audit` 等端点没有角色守卫，只看 `request.tenantId`）。
 *
 * 与各路由自己挂的 `requirePlatformOperator` 是**双重**判定：
 * 这里决定「认证层认不认」，那里决定「这个端点放不放」。
 */
/**
 * ⚠️ **必须逐路由精确列举，不能用前缀**（独立审查发现的 Critical）。
 *
 * 前一版把 `/api/v1/billing/add-ons` 当前缀匹配，而该前缀下还挂着
 * `POST /api/v1/billing/add-ons/:id/purchase` —— 一个**面向租户、没有任何
 * 守卫**的端点。于是认证层放行了它，`requirePlatformOperator` 又不在它上面，
 * 结果：平台密钥 + 任意 `X-Tenant-Id` → 给**别的租户**写 entitlement，
 * 实测返回 `200 {"purchased":true}`（无凭据同请求是 401，证明正是平台密钥
 * 在放行）。这正是本分支想关掉的「万能钥匙」类缺陷换了个入口。
 *
 * 根因：**用路径前缀做认证判定，却不保证该前缀下每条路由都挂了授权守卫**。
 * 故改为「方法 + 精确路径」白名单，并由 `platform-operator-guard-parity`
 * 用例锁死「白名单里的每一条都真的挂了 requirePlatformOperator」。
 */
interface PlatformRoute { readonly method: string; readonly path: string }

const PLATFORM_OPERATOR_ROUTES: readonly PlatformRoute[] = [
  /* 全局 JWT 信任根 */
  { method: 'POST', path: '/api/v1/auth/keys/rotate' },
  { method: 'POST', path: '/api/v1/auth/keys/deny-jti' },
  { method: 'GET', path: '/api/v1/auth/keys' },
  /* 全局 config_items */
  { method: 'GET', path: '/api/v1/admin/config' },
  { method: 'PATCH', path: '/api/v1/admin/config' },
  { method: 'GET', path: '/api/v1/admin/config/audit' },
  /* 全局商品目录 —— 注意**不含** /:id/purchase（那是租户端点） */
  { method: 'POST', path: '/api/v1/billing/add-ons' },
  { method: 'PATCH', path: '/api/v1/billing/add-ons/:id' },
  { method: 'DELETE', path: '/api/v1/billing/add-ons/:id' },
  /* 平台 Stripe 账户退款 */
  { method: 'POST', path: '/api/v1/admin/billing/refund' },
];

/** 供测试断言「白名单 ↔ 实际守卫」一致性。 */
export const PLATFORM_OPERATOR_ROUTE_LIST = PLATFORM_OPERATOR_ROUTES;

/** 把 `/api/v1/billing/add-ons/addon_123` 归一成 `/api/v1/billing/add-ons/:id`。 */
function normalizeParams(path: string, pattern: string): string {
  const ps = path.split('/');
  const qs = pattern.split('/');
  if (ps.length !== qs.length) return path;
  return qs.map((seg, i) => (seg.startsWith(':') ? seg : ps[i])).join('/');
}

/**
 * 该请求是否命中平台运营端点。**方法 + 精确路径**双重匹配，
 * 不做前缀匹配 —— 前缀会把未加守卫的子路由一并放行。
 */
export function isPlatformOperatorRoute(method: string, url: string): boolean {
  const raw = (url.split('?')[0] ?? '').replace(/\/+$/, '') || '/';
  const m = method.toUpperCase();
  return PLATFORM_OPERATOR_ROUTES.some((r) => {
    if (r.method !== m) return false;
    if (!r.path.includes(':')) return raw === r.path;
    return normalizeParams(raw, r.path) === r.path;
  });
}

/** 请求上的平台运营者能力标记（不是租户身份，故不写 `request.user`）。 */
const PLATFORM_FLAG = '_platformOperator';

type MaybeMarked = FastifyRequest & { [PLATFORM_FLAG]?: boolean };

/** 认证层确认平台密钥有效后打标。 */
export function markPlatformOperator(request: FastifyRequest): void {
  (request as MaybeMarked)[PLATFORM_FLAG] = true;
}

/** 该请求是否已被认证层确认为平台运营者。 */
function isMarkedPlatformOperator(request: FastifyRequest): boolean {
  return (request as MaybeMarked)[PLATFORM_FLAG] === true;
}

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
  /* 与 requirePlatformOperator 同样滤掉空串：否则出示空 key 会意外匹配。 */
  const usable = keys.map((k) => k.trim()).filter((k) => k.length > 0);
  if (usable.length === 0) return false;
  const presented = presentedKey(request);
  return typeof presented === 'string' && presented.length > 0
    && usable.some((k) => safeCompare(presented, k));
}

/**
 * 构造 preHandler：仅放行持有平台运营密钥的请求。
 *
 * 判定顺序刻意如此：
 *  1. **未配置 → 503**（fail-closed）。不能退回「租户 admin 也行」，那正是漏洞。
 *  2. 未出示 / 不匹配 → 403，且**不区分**两者的错误文案，避免探测出「密钥是否已配置」。
 */
export function requirePlatformOperator(config: AppConfig) {
  /* 过滤空串：`platformOperatorKeys: ['']` 这类配置若原样使用，会让
   * 「出示空 key」意外匹配成功（交叉审查发现）。env 解析本就会滤空，
   * 这里对程序化/配置文件传入的值补上同样的收敛。 */
  const keys = config.auth.platformOperatorKeys.map((k) => k.trim()).filter((k) => k.length > 0);

  return async function guard(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    /* 认证层已确认过平台密钥（且路径在白名单内）→ 直接放行。 */
    if (isMarkedPlatformOperator(request)) return;

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
