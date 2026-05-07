/**
 * 请求日志上下文注入
 * onRequest：注入 requestId + tenantId（JWT 认证前可用）
 * preHandler：补充 userId（JWT 认证后可用）
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';

export function registerRequestLogContext(app: FastifyInstance): void {
  app.addHook('onRequest', (request: FastifyRequest, reply: FastifyReply, done) => {
    const requestId = (reply.getHeader('X-Request-Id') as string) || 'unknown';
    request.log = request.log.child({ requestId });
    done();
  });

  /* preHandler 在 onRequest（JWT + tenant 解析）之后执行，tenantId 已确定 */
  app.addHook('preHandler', (request: FastifyRequest, _reply: FastifyReply, done) => {
    const tenantId = request.tenantId ?? 'default';
    const userId = request.user?.sub;
    request.log = userId
      ? request.log.child({ tenantId, userId })
      : request.log.child({ tenantId });
    done();
  });
}
