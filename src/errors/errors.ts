/**
 * 统一错误层级：为 API 层和内部模块提供结构化错误
 * 不修改现有域模块的 throw 站点（RangeError/TypeError/Error）
 */

/** 错误码常量枚举 */
export const ErrorCode = {
  /* 验证类 (400) */
  VALIDATION_RANGE: 'VALIDATION_RANGE',
  VALIDATION_TYPE: 'VALIDATION_TYPE',
  VALIDATION_REQUIRED: 'VALIDATION_REQUIRED',
  VALIDATION_FORMAT: 'VALIDATION_FORMAT',

  /* 未找到 (404) */
  NOT_FOUND_VALUE: 'NOT_FOUND_VALUE',
  NOT_FOUND_MEMORY: 'NOT_FOUND_MEMORY',
  NOT_FOUND_PERSONA: 'NOT_FOUND_PERSONA',
  NOT_FOUND_SNAPSHOT: 'NOT_FOUND_SNAPSHOT',
  NOT_FOUND_CONFLICT: 'NOT_FOUND_CONFLICT',
  NOT_FOUND_SURVIVAL_ANCHOR: 'NOT_FOUND_SURVIVAL_ANCHOR',
  NOT_FOUND_DECISION: 'NOT_FOUND_DECISION',
  NOT_FOUND_DECISION_RUN: 'NOT_FOUND_DECISION_RUN',
  NOT_FOUND_ONBOARDING: 'NOT_FOUND_ONBOARDING',
  NOT_FOUND_EXPORT: 'NOT_FOUND_EXPORT',
  NOT_FOUND_TASK: 'NOT_FOUND_TASK',
  NOT_FOUND_PENDING_UPDATE: 'NOT_FOUND_PENDING_UPDATE',

  /* 状态冲突 (409) */
  STATE_INVALID_TRANSITION: 'STATE_INVALID_TRANSITION',
  STATE_ALREADY_EXISTS: 'STATE_ALREADY_EXISTS',
  STATE_SYSTEM_RUNNING: 'STATE_SYSTEM_RUNNING',
  STATE_SYSTEM_STOPPED: 'STATE_SYSTEM_STOPPED',

  /* 存储错误 (500) */
  STORAGE_READ: 'STORAGE_READ',
  STORAGE_WRITE: 'STORAGE_WRITE',
  STORAGE_MIGRATION: 'STORAGE_MIGRATION',

  /* 配置错误 (500) */
  CONFIG_INVALID: 'CONFIG_INVALID',
  CONFIG_MISSING: 'CONFIG_MISSING',
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

/** 基础错误类：所有 ChronoSynth 错误的根 */
export class ChronoError extends Error {
  readonly statusCode: number;
  readonly code: ErrorCodeValue;
  readonly details?: unknown;

  constructor(message: string, statusCode: number, code: ErrorCodeValue, details?: unknown) {
    super(message);
    this.name = 'ChronoError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }

  toJSON(): { error: string; code: ErrorCodeValue; message: string; details?: unknown } {
    return {
      error: this.name,
      code: this.code,
      message: this.message,
      ...(this.details !== undefined ? { details: this.details } : {}),
    };
  }
}

/** 验证错误 (400) */
export class ValidationError extends ChronoError {
  constructor(message: string, code: ErrorCodeValue = ErrorCode.VALIDATION_RANGE, details?: unknown) {
    super(message, 400, code, details);
    this.name = 'ValidationError';
  }
}

/** 资源未找到 (404) */
export class NotFoundError extends ChronoError {
  constructor(message: string, code: ErrorCodeValue = ErrorCode.NOT_FOUND_PERSONA, details?: unknown) {
    super(message, 404, code, details);
    this.name = 'NotFoundError';
  }
}

/** 状态冲突 (409) */
export class StateError extends ChronoError {
  constructor(message: string, code: ErrorCodeValue = ErrorCode.STATE_INVALID_TRANSITION, details?: unknown) {
    super(message, 409, code, details);
    this.name = 'StateError';
  }
}

/** 存储错误 (500) */
export class StorageError extends ChronoError {
  constructor(message: string, code: ErrorCodeValue = ErrorCode.STORAGE_READ, details?: unknown) {
    super(message, 500, code, details);
    this.name = 'StorageError';
  }
}

/** 配置错误 (500) */
export class ConfigError extends ChronoError {
  constructor(message: string, code: ErrorCodeValue = ErrorCode.CONFIG_INVALID, details?: unknown) {
    super(message, 500, code, details);
    this.name = 'ConfigError';
  }
}
