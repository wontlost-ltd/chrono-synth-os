/**
 * Node.js 异步 UnitOfWorkFactory 适配器
 * 将同步 IDatabase 包装为 kernel 的异步 UnitOfWorkFactory 接口
 * P0-1 过渡桥接：新代码使用此接口，旧代码继续使用 IDatabase
 *
 * 实现说明：
 * - 底层 IDatabase（SQLite）为同步 API，query/execute 返回 Promise.resolve() 包裹的同步结果
 * - write() 使用手动 BEGIN/COMMIT/ROLLBACK（而非 transaction()）以支持 async 回调
 * - 若事务内包含真正的异步 I/O（如网络请求），这些操作可能在 COMMIT 之外执行，需由调用方负责
 */

import type {
  DomainEvent,
  EventPublisher,
  ReadUnitOfWork,
  TenantScope,
  UnitOfWorkFactory,
  WriteUnitOfWork,
} from '@chrono/kernel';
import type { Command, ExecResult, Query } from '@chrono/kernel';
import type { IDatabase } from './database.js';
import { resolveQueryExecutor, resolveCommandExecutor } from './legacy-sync-bridge.js';


class AsyncReadUnitOfWork implements ReadUnitOfWork {
  private open = true;

  constructor(
    protected readonly db: IDatabase,
    readonly scope: TenantScope,
  ) {}

  protected assertOpen(method: string): void {
    if (!this.open) throw new Error(`工作单元已关闭，${method} 不能在回调返回后调用。`);
  }

  close(): void { this.open = false; }

  async queryOne<TResult, TParams = unknown>(q: Query<TResult, TParams>): Promise<TResult | null> {
    this.assertOpen('queryOne()');
    const executor = resolveQueryExecutor(q.kind);
    if (!executor) throw new Error(`未注册的查询: ${q.kind}`);
    const result = executor(this.db, q.params);
    return (result as TResult) ?? null;
  }

  async queryMany<TResult, TParams = unknown>(q: Query<TResult, TParams>): Promise<readonly TResult[]> {
    this.assertOpen('queryMany()');
    const executor = resolveQueryExecutor(q.kind);
    if (!executor) throw new Error(`未注册的查询: ${q.kind}`);
    return executor(this.db, q.params) as readonly TResult[];
  }
}

class AsyncWriteUnitOfWork extends AsyncReadUnitOfWork implements WriteUnitOfWork {
  private readonly pendingEvents: DomainEvent[] = [];

  async execute<TParams>(cmd: Command<TParams>): Promise<ExecResult> {
    this.assertOpen('execute()');
    const executor = resolveCommandExecutor(cmd.kind);
    if (!executor) throw new Error(`未注册的命令: ${cmd.kind}`);
    return executor(this.db, cmd.params);
  }

  afterCommit(event: DomainEvent): void {
    this.assertOpen('afterCommit()');
    this.pendingEvents.push(event);
  }

  get committedEvents(): readonly DomainEvent[] {
    return this.pendingEvents;
  }
}

export class NodeUnitOfWorkFactory implements UnitOfWorkFactory {
  constructor(
    private readonly db: IDatabase,
    private readonly eventPublisher: EventPublisher,
  ) {}

  async read<T>(scope: TenantScope, fn: (tx: ReadUnitOfWork) => Promise<T>): Promise<T> {
    const uow = new AsyncReadUnitOfWork(this.db, scope);
    try {
      return await fn(uow);
    } finally {
      uow.close();
    }
  }

  /**
   * 在 SQLite 事务内执行写回调（手动 BEGIN/COMMIT/ROLLBACK）。
   * 使用 exec() 直接发出 SQL 控制语句以支持 async 回调。
   * 底层 query/execute 仍为同步 SQLite 操作，但整体接口为 async。
   */
  async write<T>(scope: TenantScope, fn: (tx: WriteUnitOfWork) => Promise<T>): Promise<T> {
    const uow = new AsyncWriteUnitOfWork(this.db, scope);
    this.db.exec('BEGIN');
    let result: T;
    try {
      result = await fn(uow);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    } finally {
      uow.close();
    }
    await this.eventPublisher.publish(uow.committedEvents);
    return result!;
  }
}
