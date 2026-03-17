/**
 * 统一错误层级 — 薄适配器，re-export kernel 领域逻辑
 */

export {
  ErrorCode,
  ChronoError,
  ValidationError,
  NotFoundError,
  StateError,
  StorageError,
  AuthenticationError,
  AuthorizationError,
  QuotaExceededError,
  ConfigError,
} from '@chrono/kernel';
export type { ErrorCodeValue } from '@chrono/kernel';
