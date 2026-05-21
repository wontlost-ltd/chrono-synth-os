/**
 * 结构化日志工具
 *
 * 输出格式由环境变量 `LOG_FORMAT` 决定（默认 text，可选 json）：
 *  - text  人类可读，开发期使用
 *  - json  单行 JSON，便于 Loki / ELK / Datadog 等聚合器索引
 *
 * JSON 模式额外附加 OTel trace context（trace_id / span_id），方便从一条
 * log 跳到对应的分布式 trace。P1-B 已开启 OTel auto-instrumentation，HTTP
 * 入站请求会在 AsyncLocalStorage 中维护 active span — 这里被动读取。
 *
 * 注意：日志体写入前不做 PII 脱敏，调用方应在传入 data 之前调用 redactPii()
 * （参见 src/conversation/pii-redactor.ts）。这是有意为之的边界划分：logger
 * 不假设业务语义，避免把"何为 PII"塞进基础设施层。
 */

import { trace } from '@opentelemetry/api';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogFormat = 'text' | 'json';

export interface LogEntry {
  readonly level: LogLevel;
  readonly layer: string;
  readonly message: string;
  readonly timestamp: number;
  readonly data?: unknown;
  readonly trace_id?: string;
  readonly span_id?: string;
}

export interface Logger {
  debug(layer: string, message: string, data?: unknown): void;
  info(layer: string, message: string, data?: unknown): void;
  warn(layer: string, message: string, data?: unknown): void;
  error(layer: string, message: string, data?: unknown): void;
}

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

function resolveFormatFromEnv(): LogFormat {
  const raw = process.env.LOG_FORMAT?.toLowerCase();
  return raw === 'json' ? 'json' : 'text';
}

function currentTraceContext(): { trace_id?: string; span_id?: string } {
  const span = trace.getActiveSpan();
  if (!span) return {};
  const ctx = span.spanContext();
  if (!ctx.traceId || ctx.traceId === '00000000000000000000000000000000') return {};
  return { trace_id: ctx.traceId, span_id: ctx.spanId };
}

export class ConsoleLogger implements Logger {
  private readonly minLevel: LogLevel;
  private readonly format: LogFormat;

  constructor(minLevel: LogLevel = 'info', format: LogFormat = resolveFormatFromEnv()) {
    this.minLevel = minLevel;
    this.format = format;
  }

  debug(layer: string, message: string, data?: unknown): void { this.log('debug', layer, message, data); }
  info(layer: string, message: string, data?: unknown): void { this.log('info', layer, message, data); }
  warn(layer: string, message: string, data?: unknown): void { this.log('warn', layer, message, data); }
  error(layer: string, message: string, data?: unknown): void { this.log('error', layer, message, data); }

  private log(level: LogLevel, layer: string, message: string, data?: unknown): void {
    if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[this.minLevel]) return;

    const traceCtx = currentTraceContext();
    const entry: LogEntry = {
      level,
      layer,
      message,
      timestamp: Date.now(),
      ...(data !== undefined ? { data } : {}),
      ...traceCtx,
    };

    if (this.format === 'json') {
      const sink = level === 'error' ? console.error
        : level === 'warn' ? console.warn
        : level === 'debug' ? console.debug
        : console.info;
      sink(JSON.stringify(entry));
      return;
    }

    const prefix = `[${entry.level.toUpperCase().padEnd(5)}] [${layer}]`;
    const line = `${prefix} ${message}`;
    switch (level) {
      case 'debug': console.debug(line, data ?? ''); break;
      case 'info':  console.info(line, data ?? '');  break;
      case 'warn':  console.warn(line, data ?? '');  break;
      case 'error': console.error(line, data ?? ''); break;
    }
  }
}

/** 静默日志：用于测试 */
export class SilentLogger implements Logger {
  readonly entries: LogEntry[] = [];

  debug(layer: string, message: string, data?: unknown): void {
    this.record('debug', layer, message, data);
  }
  info(layer: string, message: string, data?: unknown): void {
    this.record('info', layer, message, data);
  }
  warn(layer: string, message: string, data?: unknown): void {
    this.record('warn', layer, message, data);
  }
  error(layer: string, message: string, data?: unknown): void {
    this.record('error', layer, message, data);
  }

  private record(level: LogLevel, layer: string, message: string, data?: unknown): void {
    this.entries.push({ level, layer, message, timestamp: Date.now(), data });
  }
}
