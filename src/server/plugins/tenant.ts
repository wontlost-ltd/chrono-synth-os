/**
 * 租户识别插件
 * 从请求中提取租户标识并注入 request.tenantId
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
    /* 租户来源优先级：X-Tenant-Id header > 默认值 */
    const raw = request.headers['x-tenant-id'] as string | undefined;
    try {
      request.tenantId = normalizeTenantId(raw);
    } catch {
      request.tenantId = DEFAULT_TENANT_ID;
    }
    done();
  });
}
