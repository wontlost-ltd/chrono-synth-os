/**
 * 全局错误处理插件
 * 将域层错误统一映射为 HTTP 响应，并记录到请求级结构化日志
 */

import type { FastifyInstance, FastifyError, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { ChronoError } from '../../errors/index.js';

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error: FastifyError | Error, request: FastifyRequest, reply) => {
    /* ChronoError 层级：直接使用预定义的 statusCode */
    if (error instanceof ChronoError) {
      if (error.statusCode >= 500) {
        request.log.error({ err: error, code: error.code }, error.message);
      }
      return reply.status(error.statusCode).send(error.toJSON());
    }

    /* Zod 校验错误 → 400 */
    if (error instanceof ZodError) {
      return reply.status(400).send({
        error: 'ValidationError',
        code: 'VALIDATION_FORMAT',
        message: error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; '),
        details: error.issues,
      });
    }

    /* 域层抛出的 RangeError → 400 */
    if (error instanceof RangeError) {
      return reply.status(400).send({
        error: 'ValidationError',
        code: 'VALIDATION_RANGE',
        message: error.message,
      });
    }

    /* 域层抛出的 TypeError → 400 */
    if (error instanceof TypeError) {
      return reply.status(400).send({
        error: 'ValidationError',
        code: 'VALIDATION_TYPE',
        message: error.message,
      });
    }

    /* Fastify 内置校验错误（如 JSON parse 失败） */
    if ('validation' in error && error.validation) {
      return reply.status(400).send({
        error: 'ValidationError',
        code: 'VALIDATION_FORMAT',
        message: error.message,
      });
    }

    /* 限流插件抛出的 RateLimitError（@fastify/rate-limit 触顶时 throw）。
     * rate-limit.ts 的 errorResponseBuilder 已经把 retryAfter 等字段挂在
     * Error 上；这里负责按既定 statusCode 透传，避免落入 500 catch-all。 */
    const rateErr = error as Error & { statusCode?: number; code?: string; retryAfter?: number };
    if (rateErr.code === 'RATE_LIMIT_EXCEEDED' && typeof rateErr.statusCode === 'number') {
      return reply.status(rateErr.statusCode).send({
        error: 'RateLimitError',
        code: 'RATE_LIMIT_EXCEEDED',
        message: rateErr.message,
        retryAfter: rateErr.retryAfter,
      });
    }

    /* 其他未知错误 → 500（记录完整堆栈） */
    request.log.error({ err: error }, 'unhandled error');
    return reply.status(500).send({
      error: 'InternalError',
      code: 'INTERNAL',
      message: 'internal server error',
    });
  });
}
