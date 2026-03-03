/**
 * RBAC（基于角色的访问控制）中间件
 * 通过 preHandler 钩子验证 JWT 用户角色，拒绝无权限请求
 *
 * 行为：
 * - 生产环境：强制 RBAC，JWT 未启用时拒绝所有写操作
 * - 开发/测试环境 + JWT 未启用：透传（方便开发调试）
 * - JWT 已启用 + request.user 存在：检查角色
 * - JWT 已启用 + request.user 不存在：拒绝（API Key 用户无法访问 admin 端点）
 */

import type { FastifyRequest, FastifyReply, preHandlerHookHandler } from 'fastify';
import type { UserRole, JwtPayload } from '../../types/auth.js';
import { AuthorizationError, ErrorCode } from '../../errors/index.js';

const IS_PRODUCTION = process.env.NODE_ENV === 'production';

/**
 * 创建角色守卫 preHandler
 * @param allowedRoles 允许访问的角色列表
 */
export function requireRole(...allowedRoles: UserRole[]): preHandlerHookHandler {
  const allowed = new Set<string>(allowedRoles);
  return (request: FastifyRequest, _reply: FastifyReply, done) => {
    const jwtEnabled = (request.server as unknown as { jwtEnabled?: boolean }).jwtEnabled;
    if (!jwtEnabled) {
      if (IS_PRODUCTION) {
        /* 生产环境强制认证 — JWT 未启用时拒绝受保护端点 */
        done(new AuthorizationError(
          '生产环境必须启用 JWT 认证',
          ErrorCode.AUTH_INSUFFICIENT_ROLE,
        ));
        return;
      }
      /* 开发/测试环境 — RBAC 透传 */
      done();
      return;
    }
    const user = request.user as JwtPayload | undefined;
    if (!user) {
      /* JWT 已启用但无 JWT 用户（API Key 等）— 拒绝访问 admin 端点 */
      done(new AuthorizationError(
        '此端点需要 JWT 认证且具有角色: ' + allowedRoles.join(', '),
        ErrorCode.AUTH_INSUFFICIENT_ROLE,
      ));
      return;
    }
    if (!allowed.has(user.role)) {
      done(new AuthorizationError(
        '权限不足，需要角色: ' + allowedRoles.join(', '),
        ErrorCode.AUTH_INSUFFICIENT_ROLE,
      ));
      return;
    }
    done();
  };
}
