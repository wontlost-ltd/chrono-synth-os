/**
 * 全局错误处理插件
 *
 * 将域层错误统一映射为 HTTP 响应。每个响应体含三个稳定字段：
 *   - error      string类（"ValidationError", "InternalError" 等）
 *   - code       机器可读、跨 i18n 稳定的错误码（"VALIDATION_FORMAT" 等）
 *   - message    人类可读、根据 Accept-Language 本地化
 *
 * messageId 是新增的可选字段，指向 src/i18n/message-catalog.ts 里的 key。
 * 当 messageId 存在时，message 由服务端按 client 的 locale 翻译；当不存在
 * （遗留 Error 抛出点）时，回退到原始 error.message。这样 contract test
 * snapshot 不会因为引入 i18n 而集体破坏，而新 throw 站点可以渐进地
 * 提供 messageId。
 */

import type { FastifyInstance, FastifyError, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { ChronoError } from '../../errors/index.js';
import { resolveLocale } from '../../i18n/locale-resolver.js';
import { t, type MessageKey } from '../../i18n/message-catalog.js';

function localiseMessage(
  request: FastifyRequest,
  fallback: string,
  messageId?: MessageKey,
  params: Record<string, string | number> = {},
): { message: string; messageId?: MessageKey } {
  if (!messageId) return { message: fallback };
  const locale = resolveLocale(request.headers['accept-language'] as string | undefined);
  return { message: t(locale, messageId, params), messageId };
}

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error: FastifyError | Error, request: FastifyRequest, reply) => {
    /* ChronoError 层级：直接使用预定义的 statusCode + code。messageId
     * is opt-in on individual ChronoError subclasses; when absent we
     * preserve the original message verbatim. */
    if (error instanceof ChronoError) {
      if (error.statusCode >= 500) {
        request.log.error({ err: error, code: error.code }, error.message);
      }
      const json = error.toJSON();
      const messageId = (error as ChronoError & { messageId?: MessageKey }).messageId;
      const localised = localiseMessage(request, json.message, messageId);
      return reply.status(error.statusCode).send({ ...json, ...localised });
    }

    /* Zod 校验错误 → 400 */
    if (error instanceof ZodError) {
      const fallback = error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ');
      const localised = localiseMessage(request, fallback, 'validation.type_mismatch', { field: 'request body', expected: 'valid schema' });
      return reply.status(400).send({
        error: 'ValidationError',
        code: 'VALIDATION_FORMAT',
        ...localised,
        details: error.issues,
      });
    }

    /* 域层抛出的 RangeError → 400 */
    if (error instanceof RangeError) {
      return reply.status(400).send({
        error: 'ValidationError',
        code: 'VALIDATION_RANGE',
        ...localiseMessage(request, error.message),
      });
    }

    /* 域层抛出的 TypeError → 400 */
    if (error instanceof TypeError) {
      return reply.status(400).send({
        error: 'ValidationError',
        code: 'VALIDATION_TYPE',
        ...localiseMessage(request, error.message),
      });
    }

    /* Fastify 内置校验错误（如 JSON parse 失败） */
    if ('validation' in error && error.validation) {
      return reply.status(400).send({
        error: 'ValidationError',
        code: 'VALIDATION_FORMAT',
        ...localiseMessage(request, error.message),
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
        ...localiseMessage(request, rateErr.message, 'quota.exceeded', { resource: 'requests' }),
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
