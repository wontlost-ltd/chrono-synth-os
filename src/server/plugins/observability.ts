/**
 * Fastify 可观测性插件
 * 在每个请求上记录 span 属性和自定义指标
 */

import { trace, SpanStatusCode } from '@opentelemetry/api';
import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '../../config/schema.js';
import { requestsTotal } from '../../observability/metrics.js';

export function registerObservability(app: FastifyInstance, config: AppConfig): void {
  if (!config.observability.enabled) return;

  const tracer = trace.getTracer('chrono-synth-os');

  app.addHook('onRequest', (request, _reply, done) => {
    const span = trace.getActiveSpan();
    if (span) {
      const route = request.routeOptions?.url ?? request.url.split('?')[0];
      span.setAttribute('http.route', route);
      const user = (request as unknown as { user?: { sub: string; tenantId?: string } }).user;
      span.setAttribute('chrono.tenant_id', user?.tenantId ?? 'unknown');
      if (user) {
        span.setAttribute('chrono.user_id', user.sub);
      }
    }
    done();
  });

  app.addHook('onResponse', (request, reply, done) => {
    const route = request.routeOptions?.url ?? request.url.split('?')[0];
    requestsTotal.add(1, {
      method: request.method,
      route,
      status_code: String(reply.statusCode),
    });

    const span = trace.getActiveSpan();
    if (span && reply.statusCode >= 500) {
      span.setStatus({ code: SpanStatusCode.ERROR });
    }

    done();
  });

  /* 用于手动创建 span 的 tracer 装饰 */
  app.decorate('tracer', tracer);
}
