/**
 * 请求日志上下文注入
 * onRequest：注入 requestId + tenantId（JWT 认证前可用）
 * preHandler：补充 userId（JWT 认证后可用）
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';

export function registerRequestLogContext(app: FastifyInstance): void {
  app.addHook('onRequest', (request: FastifyRequest, reply: FastifyReply, done) => {
    const requestId = (reply.getHeader('X-Request-Id') as string) || 'unknown';
    const tenantId = request.tenantId ?? 'default';
    request.log = request.log.child({ requestId, tenantId });
    done();
  });

  app.addHook('preHandler', (request: FastifyRequest, _reply: FastifyReply, done) => {
    const userId = (request as unknown as { user?: { sub?: string } }).user?.sub;
    if (userId) {
      request.log = request.log.child({ userId });
    }
    done();
  });
}
