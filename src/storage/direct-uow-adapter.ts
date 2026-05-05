/**
 * 直接 UoW 适配器 — 将 IDatabase 包装为 SyncWriteUnitOfWork
 * 用于过渡期：现有 Store 类无需重构调用方即可使用内核领域服务
 * 每次方法调用直接路由到注册表中的执行器
 */

import type { SyncWriteUnitOfWork } from '@chrono/kernel';
import type { Query, Command, ExecResult } from '@chrono/kernel';
import type { IDatabase } from './database.js';
import { resolveQueryExecutor, resolveCommandExecutor } from './legacy-sync-bridge.js';

export function directUnitOfWork(db: IDatabase): SyncWriteUnitOfWork {
  return {
    queryOne<TResult, TParams>(q: Query<TResult, TParams>): TResult | null {
      const executor = resolveQueryExecutor(q.kind);
      if (!executor) throw new Error(`未注册的查询: ${q.kind}`);
      const result = executor(db, q.params);
      return (result as TResult) ?? null;
    },
    queryMany<TResult, TParams>(q: Query<TResult, TParams>): readonly TResult[] {
      const executor = resolveQueryExecutor(q.kind);
      if (!executor) throw new Error(`未注册的查询: ${q.kind}`);
      return executor(db, q.params) as readonly TResult[];
    },
    execute<TParams>(cmd: Command<TParams>): ExecResult {
      const executor = resolveCommandExecutor(cmd.kind);
      if (!executor) throw new Error(`未注册的命令: ${cmd.kind}`);
      return executor(db, cmd.params);
    },
    transaction<T>(fn: () => T): T {
      return db.transaction(fn);
    },
  };
}
