/**
 * PostgreSQL 数据库适配器
 * 实现 IDatabase 同步接口，使用 worker_threads 桥接 pg 异步 API
 *
 * 原理：主线程通过 SharedArrayBuffer 向 Worker 发送 SQL 命令，
 * Worker 内部运行独立事件循环执行 pg 异步操作，完成后通过 Atomics.notify 唤醒主线程。
 * 这样主线程的 Atomics.wait 不会阻塞 Worker 的事件循环。
 *
 * 事务支持：transaction() 在 Worker 中获取专用 client，
 * 后续 prepare() 调用通过 transactionClientId 绑定到同一 client。
 */

import { Worker, isMainThread, parentPort, workerData, MessageChannel, receiveMessageOnPort } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import type { IDatabase, IPreparedStatement, SqlValue } from './database.js';
import type { Query, Command, ExecResult } from '@chrono/kernel';
import { resolveQueryExecutor, resolveCommandExecutor } from './legacy-sync-bridge.js';

export interface PostgresPoolOptions {
  readonly max: number;
  readonly idleTimeoutMs: number;
}

const DEFAULT_POOL: PostgresPoolOptions = {
  max: 10,
  idleTimeoutMs: 30_000,
};

/** 命令缓冲区布局：[0]=状态标志, [1..]=预留 */
const STATUS_WAITING = 0;
const STATUS_DONE = 1;

/** 占位符转换相关常量 */
const enum TokenState {
  Normal,
  SingleQuote,
  /** PostgreSQL E'...' 反斜杠转义字符串（E'\'' 为合法单引号） */
  EscapedQuote,
  DoubleQuote,
  DollarQuote,
  LineComment,
  BlockComment,
}

/**
 * 将 `?` 占位符转换为 `$1, $2, ...` 格式（PostgreSQL 参数化查询）
 *
 * 完整 SQL tokenizer：正确跳过字符串字面量、标识符、注释和美元引号中的 `?`
 * 不替换 JSONB 运算符 `?|` 和 `?&`
 */
export function convertPlaceholders(sql: string): string {
  let idx = 0;
  let state: TokenState = TokenState.Normal;
  let dollarTag = '';          /* 美元引号的标签（如 $tag$） */
  let result = '';
  const len = sql.length;

  for (let i = 0; i < len; i++) {
    const ch = sql[i];
    const next = i + 1 < len ? sql[i + 1] : '';

    switch (state) {
      case TokenState.Normal: {
        if (ch === "'") {
          state = TokenState.SingleQuote;
          result += ch;
        } else if (
          (ch === 'E' || ch === 'e') && next === "'" &&
          /* 确认 E 不是标识符的一部分（前一个字符不能是字母/数字/下划线） */
          (i === 0 || !/[A-Za-z0-9_]/.test(sql[i - 1]))
        ) {
          /* PostgreSQL E'...' 反斜杠转义字符串 */
          state = TokenState.EscapedQuote;
          result += ch + next;
          i++;
        } else if (ch === '"') {
          state = TokenState.DoubleQuote;
          result += ch;
        } else if (ch === '$') {
          /* 检测美元引号：$tag$ 或 $$ */
          const dollarMatch = sql.slice(i).match(/^\$([A-Za-z0-9_]*)\$/);
          if (dollarMatch) {
            dollarTag = dollarMatch[0];
            state = TokenState.DollarQuote;
            result += dollarTag;
            i += dollarTag.length - 1;
          } else {
            result += ch;
          }
        } else if (ch === '-' && next === '-') {
          state = TokenState.LineComment;
          result += ch;
        } else if (ch === '/' && next === '*') {
          state = TokenState.BlockComment;
          result += ch;
        } else if (ch === '?') {
          /* 检查是否为 JSONB 运算符 ?| 或 ?& */
          if (next === '|' || next === '&') {
            result += ch;
          } else {
            idx++;
            result += `$${idx}`;
          }
        } else {
          result += ch;
        }
        break;
      }

      case TokenState.SingleQuote: {
        result += ch;
        if (ch === "'") {
          /* 标准 SQL 转义：'' 表示字面量单引号 */
          if (next === "'") {
            result += next;
            i++;
          } else {
            state = TokenState.Normal;
          }
        }
        break;
      }

      case TokenState.EscapedQuote: {
        result += ch;
        if (ch === '\\') {
          /* 反斜杠转义：跳过下一个字符（如 \' 或 \\） */
          if (i + 1 < len) {
            result += sql[i + 1];
            i++;
          }
        } else if (ch === "'") {
          state = TokenState.Normal;
        }
        break;
      }

      case TokenState.DoubleQuote: {
        result += ch;
        if (ch === '"') {
          if (next === '"') {
            result += next;
            i++;
          } else {
            state = TokenState.Normal;
          }
        }
        break;
      }

      case TokenState.DollarQuote: {
        /* 查找结束的美元引号标签 */
        if (ch === '$' && sql.slice(i, i + dollarTag.length) === dollarTag) {
          result += dollarTag;
          i += dollarTag.length - 1;
          state = TokenState.Normal;
        } else {
          result += ch;
        }
        break;
      }

      case TokenState.LineComment: {
        result += ch;
        if (ch === '\n') {
          state = TokenState.Normal;
        }
        break;
      }

      case TokenState.BlockComment: {
        result += ch;
        if (ch === '*' && next === '/') {
          result += next;
          i++;
          state = TokenState.Normal;
        }
        break;
      }
    }
  }

  return result;
}

/**
 * Worker 端代码：在独立线程中运行 pg 操作
 * 当此文件被 Worker 加载时（isMainThread === false），启动 Worker 事件循环
 */
if (!isMainThread && parentPort) {
  const port = parentPort;
  const config = workerData as { connectionString: string; max: number; idleTimeoutMillis: number };

  /* 延迟导入 pg（仅在 Worker 线程中） */
  const pgModule = await import('pg');
  const Pool = pgModule.default.Pool;

  const pool = new Pool({
    connectionString: config.connectionString,
    max: config.max,
    idleTimeoutMillis: config.idleTimeoutMillis,
  });

  /** pool.connect() 返回的 client 具有 query + release 方法 */
  type PgClient = { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number | null }>; release: () => void };

  /** 事务中持有的专用 client（按 txId 索引） */
  const txClients = new Map<number, PgClient>();
  let nextTxId = 1;

  port.on('message', async (msg: WorkerMessage) => {
    const { id, statusBuf, replyPort } = msg;
    const status = new Int32Array(statusBuf);
    let response: WorkerResponse;

    try {
      switch (msg.type) {
        case 'query': {
          const target = msg.txId && txClients.has(msg.txId)
            ? txClients.get(msg.txId)!
            : pool;
          const result = await target.query(msg.sql, msg.params);
          response = {
            id,
            ok: true,
            rows: result.rows as Record<string, unknown>[],
            rowCount: result.rowCount ?? 0,
          };
          break;
        }

        case 'exec': {
          const target = msg.txId && txClients.has(msg.txId)
            ? txClients.get(msg.txId)!
            : pool;
          await target.query(msg.sql);
          response = { id, ok: true, rows: [], rowCount: 0 };
          break;
        }

        case 'begin-tx': {
          const client = await pool.connect() as unknown as PgClient;
          const txId = nextTxId++;
          txClients.set(txId, client);
          await client.query('BEGIN');
          response = { id, ok: true, rows: [], rowCount: 0, txId };
          break;
        }

        case 'commit-tx': {
          const client = txClients.get(msg.txId!);
          if (!client) throw new Error(`事务 ${msg.txId} 不存在`);
          await client.query('COMMIT');
          client.release();
          txClients.delete(msg.txId!);
          response = { id, ok: true, rows: [], rowCount: 0 };
          break;
        }

        case 'rollback-tx': {
          const client = txClients.get(msg.txId!);
          if (!client) throw new Error(`事务 ${msg.txId} 不存在`);
          await client.query('ROLLBACK');
          client.release();
          txClients.delete(msg.txId!);
          response = { id, ok: true, rows: [], rowCount: 0 };
          break;
        }

        case 'close': {
          /* 释放所有事务 client */
          for (const [, client] of txClients) {
            try {
              await client.query('ROLLBACK');
              client.release();
            } catch { /* 忽略 */ }
          }
          txClients.clear();
          await pool.end();
          response = { id, ok: true, rows: [], rowCount: 0 };
          break;
        }

        default:
          response = { id, ok: false, error: `未知消息类型: ${(msg as WorkerMessage).type}` };
      }
    } catch (err) {
      response = {
        id,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }

    /* 通过专用回复端口发送响应，然后唤醒主线程 */
    replyPort.postMessage(response);
    replyPort.close();
    Atomics.store(status, 0, STATUS_DONE);
    Atomics.notify(status, 0);
  });
}

/** 主线程 → Worker 的消息类型 */
interface WorkerMessage {
  id: number;
  type: 'query' | 'exec' | 'begin-tx' | 'commit-tx' | 'rollback-tx' | 'close';
  sql: string;
  params: SqlValue[];
  txId?: number;
  statusBuf: SharedArrayBuffer;
  /** 专用回复端口（通过 transfer 传递，Worker 用此端口回复响应） */
  replyPort: import('node:worker_threads').MessagePort;
}

/** Worker → 主线程的响应 */
interface WorkerResponse {
  id: number;
  ok: boolean;
  rows?: Record<string, unknown>[];
  rowCount?: number;
  txId?: number;
  error?: string;
}

const TIMEOUT_MS = 30_000;

/**
 * PostgreSQL 同步适配器
 * 通过 worker_threads 在独立线程中执行异步 pg 操作，
 * 主线程使用 Atomics.wait 等待结果（不阻塞 Worker 事件循环）
 */
export class PostgresDatabase implements IDatabase {
  private readonly worker: Worker;
  private _closed = false;
  private nextMsgId = 1;
  /** 当前活跃事务 ID（仅在 transaction() 回调内部有效） */
  private currentTxId: number | undefined;

  constructor(connectionString: string, opts?: Partial<PostgresPoolOptions>) {
    const poolOpts = { ...DEFAULT_POOL, ...opts };
    this.worker = new Worker(fileURLToPath(import.meta.url), {
      workerData: {
        connectionString,
        max: poolOpts.max,
        idleTimeoutMillis: poolOpts.idleTimeoutMs,
      },
    });
  }

  exec(sql: string): void {
    this.sendSync({ type: 'exec', sql, params: [], txId: this.currentTxId });
  }

  prepare<T = unknown>(sql: string): IPreparedStatement<T> {
    const pgSql = convertPlaceholders(sql);
    const db = this;

    return {
      run(...params: SqlValue[]): { changes: number; lastInsertRowid: number | bigint } {
        const resp = db.sendSync({ type: 'query', sql: pgSql, params, txId: db.currentTxId });
        return {
          changes: resp.rowCount ?? 0,
          /**
           * PostgreSQL 不支持 SQLite 的 lastInsertRowid 语义。
           * 当前项目所有 ID 均由调用方通过 generatePrefixedId() 预生成，
           * 无任何代码路径依赖此返回值。返回 0 作为兼容占位。
           * 若未来需要自增 ID，应在 SQL 中追加 RETURNING id 子句。
           */
          lastInsertRowid: 0,
        };
      },
      get(...params: SqlValue[]): T | undefined {
        const resp = db.sendSync({ type: 'query', sql: pgSql, params, txId: db.currentTxId });
        return (resp.rows?.[0] as T) ?? undefined;
      },
      all(...params: SqlValue[]): T[] {
        const resp = db.sendSync({ type: 'query', sql: pgSql, params, txId: db.currentTxId });
        return (resp.rows ?? []) as T[];
      },
    };
  }

  transaction<T>(fn: () => T): T {
    /* 开始事务，获取 txId */
    const beginResp = this.sendSync({ type: 'begin-tx', sql: '', params: [] });
    const txId = beginResp.txId!;

    /* 绑定 txId 到当前上下文，确保 fn() 内部的 prepare()/exec() 走同一 client */
    const previousTxId = this.currentTxId;
    this.currentTxId = txId;

    try {
      const result = fn();
      /* 防御：如果回调意外返回 Promise，commit 会在异步操作完成前执行，导致数据不一致 */
      if (result !== null && result !== undefined && typeof (result as unknown as Promise<unknown>).then === 'function') {
        throw new Error('transaction() 回调不可返回 Promise，同步接口不支持异步事务');
      }
      this.sendSync({ type: 'commit-tx', sql: '', params: [], txId });
      return result;
    } catch (err) {
      this.sendSync({ type: 'rollback-tx', sql: '', params: [], txId });
      throw err;
    } finally {
      this.currentTxId = previousTxId;
    }
  }

  close(): void {
    if (this._closed) return;
    this._closed = true;
    try {
      this.sendSync({ type: 'close', sql: '', params: [] });
    } catch { /* Worker 可能已终止 */ }
    this.worker.terminate();
  }

  /** 异步关闭（优雅停机用） */
  async closeAsync(): Promise<void> {
    if (this._closed) return;
    this._closed = true;
    try {
      this.sendSync({ type: 'close', sql: '', params: [] });
    } catch { /* Worker 可能已终止 */ }
    await this.worker.terminate();
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

  /**
   * 向 Worker 发送消息并同步等待结果
   *
   * 使用 MessageChannel + receiveMessageOnPort 避免竞态：
   * 1. 创建 MessageChannel，将 port2 随消息传给 Worker（transferable）
   * 2. Worker 通过 port2.postMessage 回复，然后 Atomics.notify 唤醒主线程
   * 3. 主线程 Atomics.wait 返回后，用 receiveMessageOnPort(port1) 同步取出响应
   *
   * 这确保了 Atomics.wait 返回时消息已在 port1 中可读，无需依赖异步 message 事件。
   */
  private sendSync(msg: Omit<WorkerMessage, 'id' | 'statusBuf' | 'replyPort'>): WorkerResponse {
    const id = this.nextMsgId++;
    const statusBuf = new SharedArrayBuffer(4);
    const status = new Int32Array(statusBuf);
    Atomics.store(status, 0, STATUS_WAITING);

    const { port1, port2 } = new MessageChannel();

    this.worker.postMessage(
      { ...msg, id, statusBuf, replyPort: port2 } as WorkerMessage,
      [port2],       /* transfer port2 给 Worker */
    );

    /* 等待 Worker 完成（最多 30 秒） */
    const waitResult = Atomics.wait(status, 0, STATUS_WAITING, TIMEOUT_MS);
    if (waitResult === 'timed-out') {
      port1.close();
      throw new Error(`PostgreSQL 操作超时（${TIMEOUT_MS}ms）: ${msg.type} ${msg.sql.slice(0, 80)}`);
    }

    /* 同步读取 Worker 通过 port2 发来的响应 */
    const received = receiveMessageOnPort(port1);
    port1.close();

    if (!received) {
      throw new Error(`PostgreSQL Worker 未返回响应: ${msg.type}`);
    }

    const resp = received.message as WorkerResponse;

    if (!resp.ok) {
      throw new Error(resp.error ?? 'PostgreSQL 操作失败');
    }

    return resp;
  }
}
