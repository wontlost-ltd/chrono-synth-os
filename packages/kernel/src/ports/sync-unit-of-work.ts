/**
 * 同步工作单元接口 — 用于同步数据库桥接（过渡期）
 * 与 async UnitOfWork 方法签名一致，仅返回类型为同步
 */

import type { Query, Command, ExecResult } from './query.js';

/** 同步只读工作单元 */
export interface SyncReadUnitOfWork {
  queryOne<TResult, TParams = unknown>(q: Query<TResult, TParams>): TResult | null;
  queryMany<TResult, TParams = unknown>(q: Query<TResult, TParams>): readonly TResult[];
}

/** 同步可写工作单元 */
export interface SyncWriteUnitOfWork extends SyncReadUnitOfWork {
  execute<TParams>(cmd: Command<TParams>): ExecResult;
}
