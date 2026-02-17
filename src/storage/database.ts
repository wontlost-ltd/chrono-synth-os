/**
 * 数据库抽象接口与 node:sqlite 实现
 */

import { DatabaseSync } from 'node:sqlite';

/** SQL 参数值类型 */
export type SqlValue = null | number | bigint | string;

/** 数据库抽象接口 */
export interface IDatabase {
  exec(sql: string): void;
  prepare<T = unknown>(sql: string): IPreparedStatement<T>;
  close(): void;
  /** 在事务中执行函数，异常时自动回滚 */
  transaction<T>(fn: () => T): T;
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
      if (result !== null && result !== undefined && typeof (result as unknown as Promise<unknown>).then === 'function') {
        throw new Error('transaction() 回调不可返回 Promise，同步接口不支持异步事务');
      }
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
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
}

/** 创建内存数据库（测试用） */
export function createMemoryDatabase(): IDatabase {
  return new SqliteDatabase(':memory:');
}
