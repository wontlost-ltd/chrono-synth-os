/**
 * 请求 ID 中间件
 * 生成或透传 X-Request-Id / X-Correlation-Id / X-Trace-Id
 * X-Trace-Id 用于分布式追踪，格式：{requestId}-{timestamp}
 */

import type { FastifyInstance } from 'fastify';
import { generateId } from '../../utils/id-generator.js';

export function registerRequestId(app: FastifyInstance): void {
  app.addHook('onRequest', (request, reply, done) => {
    const requestId = (request.headers['x-request-id'] as string) || generateId();
    const correlationId = (request.headers['x-correlation-id'] as string) || requestId;
    const traceId = (request.headers['x-trace-id'] as string) || `${requestId}-${Date.now()}`;

    reply.header('X-Request-Id', requestId);
    reply.header('X-Correlation-Id', correlationId);
    reply.header('X-Trace-Id', traceId);
    done();
  });
}
