/**
 * 过渡桥接 — 将同步 IDatabase 包装为同步 UnitOfWork
 * 仅 Node Runtime 使用，Phase 1 结束后移除
 *
 * 注意：此桥接不实现 kernel 的 async UnitOfWorkFactory 接口，
 * 因为同步 IDatabase.transaction() 无法安全承载异步回调。
 * 消费方应直接使用 LegacySyncBridge 的同步 API。
 */

import type {
  DomainEvent,
  TenantScope,
  EventPublisher,
  Query,
  Command,
  ExecResult,
} from '@chrono/kernel';
import type { IDatabase } from './database.js';

/**
 * SQL 查询执行器 — 将 Query.kind 映射到具体的数据库操作
 */
export type QueryExecutor<TResult = unknown, TParams = unknown> = (
  db: IDatabase,
  params: TParams,
) => TResult;

export type CommandExecutor<TParams = unknown> = (
  db: IDatabase,
  params: TParams,
) => { rowsAffected: number };

/** 编译期阻止 async 回调 */
type NonPromise<T> = T extends PromiseLike<unknown> ? never : T;

/** 同步只读工作单元 */
export interface LegacyReadUnitOfWork {
  readonly scope: TenantScope;
  queryOne<TResult, TParams = unknown>(q: Query<TResult, TParams>): TResult | null;
  queryMany<TResult, TParams = unknown>(q: Query<TResult, TParams>): readonly TResult[];
}

/** 同步可写工作单元 */
export interface LegacyWriteUnitOfWork extends LegacyReadUnitOfWork {
  execute<TParams>(cmd: Command<TParams>): ExecResult;
  afterCommit(event: DomainEvent): void;
}

/** 同步工作单元工厂 — 管理事务生命周期，返回 Promise 以便将来迁移 */
export interface LegacySyncUnitOfWorkFactory {
  read<T>(scope: TenantScope, fn: (tx: LegacyReadUnitOfWork) => NonPromise<T>): Promise<NonPromise<T>>;
  write<T>(scope: TenantScope, fn: (tx: LegacyWriteUnitOfWork) => NonPromise<T>): Promise<NonPromise<T>>;
}

const queryRegistry = new Map<string, QueryExecutor>();
const commandRegistry = new Map<string, CommandExecutor>();

export function registerQuery<TResult, TParams = unknown>(
  kind: string,
  executor: QueryExecutor<TResult, TParams>,
): void {
  if (queryRegistry.has(kind)) {
    throw new Error(`查询 '${kind}' 已注册，禁止重复注册`);
  }
  queryRegistry.set(kind, executor as QueryExecutor);
}

export function registerCommand<TParams = unknown>(
  kind: string,
  executor: CommandExecutor<TParams>,
): void {
  if (commandRegistry.has(kind)) {
    throw new Error(`命令 '${kind}' 已注册，禁止重复注册`);
  }
  commandRegistry.set(kind, executor as CommandExecutor);
}

/** 清除所有注册（仅测试用途） */
export function clearRegistries(): void {
  queryRegistry.clear();
  commandRegistry.clear();
}

/** 查找已注册的查询执行器 */
export function resolveQueryExecutor(kind: string): QueryExecutor | undefined {
  return queryRegistry.get(kind);
}

/** 查找已注册的命令执行器 */
export function resolveCommandExecutor(kind: string): CommandExecutor | undefined {
  return commandRegistry.get(kind);
}

/** 事务已提交但事件发布失败的专用错误 — 消费方据此判断不应重试写入 */
export class WriteCommittedPublishError extends Error {
  readonly committed = true as const;
  constructor(cause: unknown) {
    super('数据库事务已提交，但事件发布失败。请勿重试写入操作。');
    this.name = 'WriteCommittedPublishError';
    this.cause = cause;
  }
}

function assertNotPromise(value: unknown, context: string): void {
  if (value !== null && value !== undefined && typeof (value as PromiseLike<unknown>).then === 'function') {
    throw new Error(
      `${context} 回调返回了 Promise。LegacySyncBridge 仅支持同步回调，请勿使用 async 函数。`,
    );
  }
}

class SyncReadUnitOfWork implements LegacyReadUnitOfWork {
  readonly scope: TenantScope;
  private closed = false;

  constructor(
    protected readonly db: IDatabase,
    scope: TenantScope,
  ) {
    this.scope = scope;
  }

  close(): void {
    this.closed = true;
  }

  protected assertOpen(method: string): void {
    if (this.closed) {
      throw new Error(
        `工作单元已关闭，${method} 不能在回调返回后调用。`,
      );
    }
  }

  queryOne<TResult, TParams = unknown>(q: Query<TResult, TParams>): TResult | null {
    this.assertOpen('queryOne()');
    const executor = queryRegistry.get(q.kind);
    if (!executor) throw new Error(`未注册的查询: ${q.kind}`);
    const result = executor(this.db, q.params);
    return (result as TResult) ?? null;
  }

  queryMany<TResult, TParams = unknown>(q: Query<TResult, TParams>): readonly TResult[] {
    this.assertOpen('queryMany()');
    const executor = queryRegistry.get(q.kind);
    if (!executor) throw new Error(`未注册的查询: ${q.kind}`);
    const result = executor(this.db, q.params);
    return result as readonly TResult[];
  }
}

class SyncWriteUnitOfWork extends SyncReadUnitOfWork implements LegacyWriteUnitOfWork {
  private readonly pendingEvents: DomainEvent[] = [];

  execute<TParams>(cmd: Command<TParams>): ExecResult {
    this.assertOpen('execute()');
    const executor = commandRegistry.get(cmd.kind);
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

export class LegacySyncBridge implements LegacySyncUnitOfWorkFactory {
  constructor(
    private readonly db: IDatabase,
    private readonly eventPublisher: EventPublisher,
  ) {}

  async read<T>(scope: TenantScope, fn: (tx: LegacyReadUnitOfWork) => NonPromise<T>): Promise<NonPromise<T>> {
    const uow = new SyncReadUnitOfWork(this.db, scope);
    try {
      const result = fn(uow);
      assertNotPromise(result, 'read()');
      return result;
    } finally {
      uow.close();
    }
  }

  async write<T>(scope: TenantScope, fn: (tx: LegacyWriteUnitOfWork) => NonPromise<T>): Promise<NonPromise<T>> {
    const uow = new SyncWriteUnitOfWork(this.db, scope);
    let result: NonPromise<T>;

    this.db.transaction(() => {
      try {
        result = fn(uow);
        assertNotPromise(result, 'write()');
      } finally {
        uow.close();
      }
    });

    try {
      await this.eventPublisher.publish(uow.committedEvents);
    } catch (error) {
      throw new WriteCommittedPublishError(error);
    }
    return result!;
  }
}
