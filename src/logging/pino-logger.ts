/**
 * Pino 日志适配器：实现现有 Logger 接口，输出 JSON 结构化日志
 */

import pino from 'pino';
import type { Logger, LogLevel } from '../utils/logger.js';

const PINO_LEVEL_MAP: Record<LogLevel, string> = {
  debug: 'debug',
  info: 'info',
  warn: 'warn',
  error: 'error',
};

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
