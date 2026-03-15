/**
 * 内核级异步事务接口
 * 解决同步事务断裂问题（C1），支持跨运行时的事务语义
 */

import type { DomainEvent, TenantScope } from '../index.js';
import type { Command, ExecResult, Query } from './query.js';

/** 只读工作单元 — 仅允许查询操作 */
export interface ReadUnitOfWork {
  readonly scope: TenantScope;
  queryOne<TResult, TParams = unknown>(q: Query<TResult, TParams>): Promise<TResult | null>;
  queryMany<TResult, TParams = unknown>(q: Query<TResult, TParams>): Promise<readonly TResult[]>;
}

/** 可写工作单元 — 扩展只读单元，增加命令执行与事件注册 */
export interface WriteUnitOfWork extends ReadUnitOfWork {
  execute<TParams>(cmd: Command<TParams>): Promise<ExecResult>;
  /** 注册事务提交后发布的领域事件 */
  afterCommit(event: DomainEvent): void;
}

/** 工作单元工厂 — 管理事务生命周期 */
export interface UnitOfWorkFactory {
  read<T>(scope: TenantScope, fn: (tx: ReadUnitOfWork) => Promise<T>): Promise<T>;
  write<T>(scope: TenantScope, fn: (tx: WriteUnitOfWork) => Promise<T>): Promise<T>;
}
