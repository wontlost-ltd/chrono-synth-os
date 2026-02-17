/**
 * 结构化日志工具
 * 按层级和严重程度分类输出
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  readonly level: LogLevel;
  readonly layer: string;
  readonly message: string;
  readonly timestamp: number;
  readonly data?: unknown;
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

export class ConsoleLogger implements Logger {
  private readonly minLevel: LogLevel;

  constructor(minLevel: LogLevel = 'info') {
    this.minLevel = minLevel;
  }

  debug(layer: string, message: string, data?: unknown): void {
    this.log('debug', layer, message, data);
  }

  info(layer: string, message: string, data?: unknown): void {
    this.log('info', layer, message, data);
  }

  warn(layer: string, message: string, data?: unknown): void {
    this.log('warn', layer, message, data);
  }

  error(layer: string, message: string, data?: unknown): void {
    this.log('error', layer, message, data);
  }

  private log(level: LogLevel, layer: string, message: string, data?: unknown): void {
    if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[this.minLevel]) return;

    const entry: LogEntry = {
      level,
      layer,
      message,
      timestamp: Date.now(),
      ...(data !== undefined ? { data } : {}),
    };

    const prefix = `[${entry.level.toUpperCase().padEnd(5)}] [${layer}]`;
    const line = `${prefix} ${message}`;

    switch (level) {
      case 'debug': console.debug(line, data ?? ''); break;
      case 'info':  console.info(line, data ?? '');  break;
      case 'warn':  console.warn(line, data ?? '');  break;
      case 'error': console.error(line, data ?? ''); break;
    }

    return void entry;
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
