/**
 * 数据库抽象接口与 node:sqlite 实现
 *
 * IDatabase 同时实现 SyncWriteUnitOfWork 端口：
 *  - schema migrations / raw storage 使用 prepare()/exec()
 *  - service 层使用 queryOne()/queryMany()/execute()/transaction() (kernel 端口)
 *
 * 因此 IDatabase 既是 SQLite-style 数据访问接口，也是 kernel UoW 端口的具体实现，
 * 中间没有任何"adapter / wrapper"对象。
 */

import { DatabaseSync } from 'node:sqlite';
import type {
  SyncWriteUnitOfWork, Query, Command, ExecResult,
} from '@chrono/kernel';
import { resolveQueryExecutor, resolveCommandExecutor } from './legacy-sync-bridge.js';

/** SQL 参数值类型 */
export type SqlValue = null | number | bigint | string;

/**
 * 数据库抽象接口。
 * 继承 SyncWriteUnitOfWork：service 层只需依赖 SyncWriteUnitOfWork，
 * 既能拿到 query/execute/transaction 端口，也能在 storage / migrations 场景
 * 通过 prepare()/exec() 直接走 SQL。
 */
export interface IDatabase extends SyncWriteUnitOfWork {
  /** Underlying SQL dialect. Lets dialect-sensitive code (advisory locks,
   * partial indexes, regex syntax) branch without importing the concrete
   * Sqlite/Postgres classes (which would form a cycle). */
  readonly dialect: 'sqlite' | 'postgres';
  exec(sql: string): void;
  prepare<T = unknown>(sql: string): IPreparedStatement<T>;
  /**
   * 在一个**总是回滚**的事务里运行 fn，返回其结果（ADR-0057 L4 影子内核验收）。fn 内的**所有写入随事务回滚、
   * 零持久副作用**——这是跨后端的硬保证。复用 transaction() 的 client 绑定（SQLite 同连接 / PG 按 txId 绑定），
   * 比 raw `exec('BEGIN')` 安全（Codex L4 复审：raw BEGIN 不绑定 PG client）。
   *
   * 嵌套语义（Codex L4 复审：跨后端诚实声明）：与 transaction() 同。SQLite 平坦 BEGIN 不可嵌套——外层事务内
   * 调用会因内层 BEGIN 冲突抛错（调用方按失败处理）；PG 嵌套会开一个**独立的内层事务**（仍总是回滚，故
   * fn 写入照样不持久）。两后端下「fn 写入永不落库」都成立；但**不要**依赖「外层未提交状态对 fn 可见」或
   * 跨后端一致的嵌套报错——影子验收按设计在无外层事务的同步上下文调用。
   */
  transactionRollback<T>(fn: () => T): T;
  close(): void;
}

/** transactionRollback 的内部哨兵：fn 成功后抛它强制 ROLLBACK，外层捕获后返回原结果（不污染真错误）。 */
class RollbackSignal<T> {
  constructor(readonly value: T) {}
}

/**
 * 用 transaction()（已有正确的 client 绑定 + 出错回滚）实现「总是回滚」：fn 成功 → 抛 RollbackSignal 触发
 * transaction 的 catch→ROLLBACK；外层解包 signal 返回结果。fn 真抛错则照常回滚 + 抛出。供两后端复用。
 */
export function runTransactionRollback<T>(db: { transaction<R>(fn: () => R): R }, fn: () => T): T {
  try {
    db.transaction((): never => {
      throw new RollbackSignal(fn());
    });
    /* transaction 必然因 RollbackSignal 抛出，不会走到这里。 */
    throw new Error('transactionRollback: 未预期地正常提交');
  } catch (err) {
    if (err instanceof RollbackSignal) return err.value as T;
    throw err; /* fn 的真错误（已回滚）。 */
  }
}

export interface IPreparedStatement<T = unknown> {
  run(...params: SqlValue[]): { changes: number; lastInsertRowid: number | bigint };
  get(...params: SqlValue[]): T | undefined;
  all(...params: SqlValue[]): T[];
}

/** ON CONFLICT ... DO UPDATE 所需的最低 SQLite 版本 */
const MIN_SQLITE_VERSION = '3.24.0';

/** node:sqlite 实现 */
export class SqliteDatabase implements IDatabase {
  readonly dialect = 'sqlite' as const;
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);

    /* 验证 SQLite 版本（ON CONFLICT ... DO UPDATE 需要 >= 3.24.0） */
    const row = this.db.prepare('SELECT sqlite_version() AS v').get() as { v: string } | undefined;
    if (row) {
      const current = row.v.split('.').map(Number);
      const required = MIN_SQLITE_VERSION.split('.').map(Number);
      const tooOld = current[0] < required[0]
        || (current[0] === required[0] && current[1] < required[1])
        || (current[0] === required[0] && current[1] === required[1] && current[2] < required[2]);
      if (tooOld) {
        throw new Error(
          `SQLite 版本 ${row.v} 不满足最低要求 ${MIN_SQLITE_VERSION}（ON CONFLICT ... DO UPDATE 语法）`,
        );
      }
    }

    this.db.exec('PRAGMA journal_mode=WAL');
    this.db.exec('PRAGMA foreign_keys=ON');
    this.db.exec('PRAGMA busy_timeout=5000');
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN');
    try {
      const result = fn();
      /* 防御：同步事务接口不支持异步回调 */
      if (result instanceof Promise) {
        throw new Error('transaction() 回调不可返回 Promise，同步接口不支持异步事务');
      }
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  transactionRollback<T>(fn: () => T): T {
    return runTransactionRollback(this, fn);
  }

  prepare<T = unknown>(sql: string): IPreparedStatement<T> {
    const stmt = this.db.prepare(sql);
    return {
      run(...params: SqlValue[]) {
        return stmt.run(...params) as { changes: number; lastInsertRowid: number | bigint };
      },
      get(...params: SqlValue[]) {
        return stmt.get(...params) as T | undefined;
      },
      all(...params: SqlValue[]) {
        return stmt.all(...params) as T[];
      },
    };
  }

  close(): void {
    this.db.close();
  }

  /* ── SyncWriteUnitOfWork 端口 ────────────────────────────────────────── */

  queryOne<TResult, TParams = unknown>(q: Query<TResult, TParams>): TResult | null {
    const executor = resolveQueryExecutor(q.kind);
    if (!executor) throw new Error(`未注册的查询: ${q.kind}`);
    const result = executor(this, q.params);
    return (result as TResult) ?? null;
  }

  queryMany<TResult, TParams = unknown>(q: Query<TResult, TParams>): readonly TResult[] {
    const executor = resolveQueryExecutor(q.kind);
    if (!executor) throw new Error(`未注册的查询: ${q.kind}`);
    return executor(this, q.params) as readonly TResult[];
  }

  execute<TParams>(cmd: Command<TParams>): ExecResult {
    const executor = resolveCommandExecutor(cmd.kind);
    if (!executor) throw new Error(`未注册的命令: ${cmd.kind}`);
    return executor(this, cmd.params);
  }
}

/** 创建内存数据库（测试用） */
export function createMemoryDatabase(): IDatabase {
  return new SqliteDatabase(':memory:');
}
