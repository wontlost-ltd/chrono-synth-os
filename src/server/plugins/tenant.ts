/**
 * 租户识别插件
 * 从请求中提取租户标识并注入 request.tenantId
 *
 * 当 JWT 认证可用时，tenantId 强制从 JWT payload 获取（不可伪造）；
 * 仅当无 JWT user 时才回退到 X-Tenant-Id header（非认证场景 / 公共端点）。
 *
 * 注意：decorateRequest 在此注册，但 hook 通过 registerTenantHook 延迟注册，
 * 确保在 JWT 认证钩子之后执行。
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { normalizeTenantId, DEFAULT_TENANT_ID } from '../../multi-tenant/tenant-context.js';
import { AuthenticationError, ErrorCode } from '../../errors/index.js';

declare module 'fastify' {
  interface FastifyRequest {
    tenantId: string;
  }
}

/** 仅注册 request 装饰器（同步，在 JWT 之前调用） */
export function registerTenantDecorator(app: FastifyInstance): void {
  app.decorateRequest('tenantId', DEFAULT_TENANT_ID);
}

/** 注册租户解析钩子（必须在 JWT 认证钩子之后调用） */
export function registerTenantHook(app: FastifyInstance): void {
  app.addHook('onRequest', (request: FastifyRequest, _reply: FastifyReply, done) => {
    const jwtUser = (request as unknown as { user?: { tenantId?: string } }).user;
    if (jwtUser?.tenantId) {
      /* JWT 认证成功：tenantId 来自令牌，不可被 header 覆盖 */
      try {
        request.tenantId = normalizeTenantId(jwtUser.tenantId);
      } catch {
        /* JWT 中的 tenantId 格式非法 — 拒绝请求 */
        return done(new AuthenticationError('JWT 中的租户 ID 无效', ErrorCode.AUTH_INVALID_TOKEN));
      }
    } else {
      /* 未认证 / 公共端点：回退到 header */
      const raw = request.headers['x-tenant-id'] as string | undefined;
      try {
        request.tenantId = normalizeTenantId(raw);
      } catch {
        request.tenantId = DEFAULT_TENANT_ID;
      }
    }
    done();
  });
}

/**
 * @deprecated 使用 registerTenantDecorator + registerTenantHook 替代
 * 保留用于向后兼容测试
 */
export function registerTenant(app: FastifyInstance): void {
  registerTenantDecorator(app);
  registerTenantHook(app);
}
