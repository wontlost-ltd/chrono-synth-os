/**
 * 租户识别插件
 * 从请求中提取租户标识并注入 request.tenantId
 * 优先级：JWT user.tenantId > X-Tenant-Id header > 默认值
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { normalizeTenantId, DEFAULT_TENANT_ID } from '../../multi-tenant/tenant-context.js';

declare module 'fastify' {
  interface FastifyRequest {
    tenantId: string;
  }
}

export function registerTenant(app: FastifyInstance): void {
  app.decorateRequest('tenantId', DEFAULT_TENANT_ID);

  app.addHook('onRequest', (request: FastifyRequest, _reply: FastifyReply, done) => {
    /* JWT 认证后 user 中的 tenantId 最可信 */
    const jwtUser = (request as unknown as { user?: { tenantId?: string } }).user;
    const raw = jwtUser?.tenantId ?? (request.headers['x-tenant-id'] as string | undefined);
    try {
      request.tenantId = normalizeTenantId(raw);
    } catch {
      request.tenantId = DEFAULT_TENANT_ID;
    }
    done();
  });
}
