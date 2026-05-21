/**
 * Pino 日志适配器：生产路径的 JSON 结构化日志。
 *
 * trace 关联：每条 log 自动注入当前 OTel active span 的 `trace_id` 和
 * `span_id`（W3C Trace Context 格式）。这样 Grafana/Loki 操作员可以从
 * 一条日志一键跳到对应的分布式 trace。auto-instrumentation 已经在 HTTP
 * 入口、PG/Redis 客户端等位置维护 AsyncLocalStorage 中的 span；此模块
 * 被动读取即可，无需调用方传 traceId。
 */

import pino from 'pino';
import { trace } from '@opentelemetry/api';
import type { Logger, LogLevel } from '../utils/logger.js';

const PINO_LEVEL_MAP: Record<LogLevel, string> = {
  debug: 'debug',
  info: 'info',
  warn: 'warn',
  error: 'error',
};

function currentTraceContext(): { trace_id?: string; span_id?: string } {
  const span = trace.getActiveSpan();
  if (!span) return {};
  const ctx = span.spanContext();
  /* OTel 在没有有效 trace 时返回全 0 的 traceId；过滤掉以免产生
   * 误导性的 "trace_id=000…" 日志行。 */
  if (!ctx.traceId || ctx.traceId === '00000000000000000000000000000000') return {};
  return { trace_id: ctx.traceId, span_id: ctx.spanId };
}

export class PinoLogger implements Logger {
  private readonly instance: pino.Logger;

  constructor(level: LogLevel = 'info', json = false, service = 'chrono-synth-os') {
    const transport = json
      ? undefined
      : { target: 'pino/file', options: { destination: 1 } };

    this.instance = pino({
      level: PINO_LEVEL_MAP[level],
      ...(transport ? { transport } : {}),
      base: { service },
      formatters: {
        level(label) {
          return { level: label };
        },
      },
      /* mixin runs per log call → captures the current OTel span at the
       * moment of emission, not at logger construction. This is what makes
       * trace correlation actually work across async boundaries. */
      mixin() {
        return currentTraceContext();
      },
    });
  }

  /** 获取底层 pino 实例（供 Fastify 复用） */
  get pino(): pino.Logger {
    return this.instance;
  }

  /** 创建子日志器（附加上下文，如 correlation ID） */
  child(context: Record<string, unknown>): PinoLogger {
    const childLogger = new PinoLogger();
    Object.defineProperty(childLogger, 'instance', {
      value: this.instance.child(context),
      writable: false,
    });
    return childLogger;
  }

  debug(layer: string, message: string, data?: unknown): void {
    this.instance.debug({ layer, data }, message);
  }

  info(layer: string, message: string, data?: unknown): void {
    this.instance.info({ layer, data }, message);
  }

  warn(layer: string, message: string, data?: unknown): void {
    this.instance.warn({ layer, data }, message);
  }

  error(layer: string, message: string, data?: unknown): void {
    this.instance.error({ layer, data }, message);
  }
}
