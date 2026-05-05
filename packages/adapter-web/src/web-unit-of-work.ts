/**
 * SyncWriteUnitOfWork implementation backed by InMemoryTables.
 *
 * This is the kernel-facing surface. Hosts bring:
 *   1. an InMemoryTables instance (loaded from WebKVStore at startup)
 *   2. a registry mapping kernel kind → handler
 *
 * The adapter intentionally does not call into IndexedDB synchronously;
 * persistence is done by the surrounding WebPersistenceController which
 * subscribes to commit events and flushes to a WebKVStore.
 */

import type {
  Command,
  ExecResult,
  Query,
  SyncWriteUnitOfWork,
} from '@chrono/kernel';
import type { InMemoryTables } from './in-memory-tables.js';

export type QueryHandler<TResult, TParams> = (
  tables: InMemoryTables,
  params: TParams,
) => TResult | null | readonly TResult[];

export type CommandHandler<TParams> = (
  tables: InMemoryTables,
  params: TParams,
) => ExecResult;

export interface ExecutorRegistry {
  registerQuery<TResult, TParams>(kind: string, handler: QueryHandler<TResult, TParams>): void;
  registerCommand<TParams>(kind: string, handler: CommandHandler<TParams>): void;
  resolveQuery<TResult, TParams>(kind: string): QueryHandler<TResult, TParams> | undefined;
  resolveCommand<TParams>(kind: string): CommandHandler<TParams> | undefined;
}

export function createExecutorRegistry(): ExecutorRegistry {
  const queries = new Map<string, QueryHandler<unknown, unknown>>();
  const commands = new Map<string, CommandHandler<unknown>>();
  return {
    registerQuery<TResult, TParams>(kind: string, handler: QueryHandler<TResult, TParams>): void {
      queries.set(kind, handler as unknown as QueryHandler<unknown, unknown>);
    },
    registerCommand<TParams>(kind: string, handler: CommandHandler<TParams>): void {
      commands.set(kind, handler as unknown as CommandHandler<unknown>);
    },
    resolveQuery<TResult, TParams>(kind: string): QueryHandler<TResult, TParams> | undefined {
      return queries.get(kind) as QueryHandler<TResult, TParams> | undefined;
    },
    resolveCommand<TParams>(kind: string): CommandHandler<TParams> | undefined {
      return commands.get(kind) as CommandHandler<TParams> | undefined;
    },
  };
}

export interface CommitListener {
  (tables: InMemoryTables): void | Promise<void>;
}

export class WebUnitOfWork implements SyncWriteUnitOfWork {
  private readonly listeners = new Set<CommitListener>();
  private depth = 0;
  private rollbackSnapshot: InMemoryTables | null = null;

  constructor(
    private readonly tables: InMemoryTables,
    private readonly registry: ExecutorRegistry,
  ) {}

  onCommit(listener: CommitListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  queryOne<TResult, TParams = unknown>(q: Query<TResult, TParams>): TResult | null {
    const handler = this.registry.resolveQuery<TResult, TParams>(q.kind);
    if (!handler) throw new Error(`no executor registered for query kind: ${q.kind}`);
    const result = handler(this.tables, q.params);
    if (result === null || result === undefined) return null;
    if (Array.isArray(result)) return (result[0] as TResult | undefined) ?? null;
    return result as TResult;
  }

  queryMany<TResult, TParams = unknown>(q: Query<TResult, TParams>): readonly TResult[] {
    const handler = this.registry.resolveQuery<TResult, TParams>(q.kind);
    if (!handler) throw new Error(`no executor registered for query kind: ${q.kind}`);
    const result = handler(this.tables, q.params);
    if (result === null || result === undefined) return [];
    if (Array.isArray(result)) return result as readonly TResult[];
    return [result as TResult];
  }

  execute<TParams>(cmd: Command<TParams>): ExecResult {
    const handler = this.registry.resolveCommand<TParams>(cmd.kind);
    if (!handler) throw new Error(`no executor registered for command kind: ${cmd.kind}`);
    return handler(this.tables, cmd.params);
  }

  transaction<T>(fn: () => T): T {
    const isOuter = this.depth === 0;
    if (isOuter) {
      this.rollbackSnapshot = this.tables.cloneState();
    }
    this.depth += 1;
    try {
      const result = fn();
      this.depth -= 1;
      if (this.depth === 0) {
        this.rollbackSnapshot = null;
        this.notifyCommit();
      }
      return result;
    } catch (err) {
      this.depth -= 1;
      if (this.depth === 0 && this.rollbackSnapshot) {
        this.tables.replaceWith(this.rollbackSnapshot);
        this.rollbackSnapshot = null;
      }
      throw err;
    }
  }

  private notifyCommit(): void {
    if (this.listeners.size === 0) return;
    const snapshot = this.tables;
    for (const listener of this.listeners) {
      try {
        const r = listener(snapshot);
        if (r instanceof Promise) {
          /* fire-and-forget; persistence failures are surfaced via the listener */
          r.catch(() => undefined);
        }
      } catch {
        /* listeners must not break commits */
      }
    }
  }
}
