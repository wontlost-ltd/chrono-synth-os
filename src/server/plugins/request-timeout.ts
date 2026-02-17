/**
 * 请求超时插件
 * 对所有请求设置全局超时，防止长尾请求占用连接
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { AppConfig } from '../../config/schema.js';

export function registerRequestTimeout(app: FastifyInstance, config: AppConfig): void {
  const timeoutMs = config.request.timeoutMs;
  if (timeoutMs <= 0) return;

  app.addHook('onRequest', (request: FastifyRequest, reply: FastifyReply, done) => {
    const timer = setTimeout(() => {
      if (!reply.sent) {
        reply.status(504).send({
          error: 'GatewayTimeout',
          code: 'REQUEST_TIMEOUT',
          message: `请求处理超时 (${timeoutMs}ms)`,
        });
      }
    }, timeoutMs);

    /* 将 timer 绑定到请求，以便 onResponse 中清除 */
    (request as unknown as Record<string, unknown>).__timeoutTimer = timer;

    /* 连接异常关闭时也清除 */
    reply.raw.on('close', () => clearTimeout(timer));
    done();
  });

  /* 正常响应完成后立即清除超时定时器（避免 keep-alive 下的定时器累积） */
  app.addHook('onResponse', (request: FastifyRequest, _reply: FastifyReply, done) => {
    const timer = (request as unknown as Record<string, unknown>).__timeoutTimer as ReturnType<typeof setTimeout> | undefined;
    if (timer) clearTimeout(timer);
    done();
  });
}
