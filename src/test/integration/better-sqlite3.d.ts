declare module 'better-sqlite3' {
  export interface RunResult {
    readonly changes: number;
    readonly lastInsertRowid: number | bigint;
  }

  export interface Statement<T = unknown> {
    run(...params: unknown[]): RunResult;
    get(...params: unknown[]): T | undefined;
    all(...params: unknown[]): T[];
  }

  export interface Database {
    exec(sql: string): this;
    prepare<T = unknown>(sql: string): Statement<T>;
    transaction<T>(fn: () => T): () => T;
    close(): void;
  }

  export interface DatabaseConstructor {
    new(path: string): Database;
  }

  const Database: DatabaseConstructor;
  export default Database;
}
