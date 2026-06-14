/**
 * 端侧人格 worker 客户端（主线程侧）— 把 postMessage/onmessage 封装成 Promise API。
 *
 * 主线程通过本客户端与端侧人格 worker 通信（发命令、收结果），不阻塞 UI。每条请求带单调 id
 * 关联响应，支持并发请求乱序到达。worker 持有人格状态——主线程只发命令。
 *
 * `WorkerLike` 抽象 Worker 的最小面（postMessage + onmessage），使客户端逻辑可在 Node 用 fake
 * worker 单测（不依赖真浏览器 Worker 全局）。
 */

import type { PersonaCommand, PersonaResult } from './persona-runtime.js';
import type { WorkerRequest, WorkerResponse } from './worker-protocol.js';

/** Worker 的最小面（便于注入 fake 测试）。onerror/onmessageerror 可选——真 Worker 有。 */
export interface WorkerLike {
  postMessage(message: WorkerRequest): void;
  onmessage: ((e: MessageEvent<WorkerResponse>) => void) | null;
  onerror?: ((e: unknown) => void) | null;
  onmessageerror?: ((e: unknown) => void) | null;
  terminate?(): void;
}

/** 单条请求超时（毫秒）——worker 永不回（崩溃/挂死）时不让 Promise 永挂。 */
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

interface PendingEntry { resolve: (r: PersonaResult) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }

export class PersonaWorkerClient {
  private nextId = 1;
  private readonly pending = new Map<number, PendingEntry>();
  private closed = false;

  constructor(private readonly worker: WorkerLike, private readonly timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) {
    this.worker.onmessage = (e: MessageEvent<WorkerResponse>): void => {
      const res = e.data;
      const p = this.pending.get(res.id);
      if (!p) return;                       /* 未知 id（已解决/超时/陈旧）：忽略 */
      this.settle(res.id, p, res.ok ? { value: res.result } : { error: new Error(res.error) });
    };
    /* worker 崩溃 / 消息反序列化失败 → reject 所有 pending（否则永挂，badge 卡死，Codex 复审）。 */
    if ('onerror' in this.worker) this.worker.onerror = (e) => this.rejectAll(workerError(e, 'worker 错误'));
    if ('onmessageerror' in this.worker) this.worker.onmessageerror = (e) => this.rejectAll(workerError(e, 'worker 消息反序列化失败'));
  }

  /** 发一条命令到端侧人格 worker，返回结果 Promise（并发安全：id 关联；超时/postMessage 抛错都 reject）。 */
  send(cmd: PersonaCommand): Promise<PersonaResult> {
    const id = this.nextId++;
    return new Promise<PersonaResult>((resolve, reject) => {
      if (this.closed) { reject(new Error('worker 已关闭')); return; }
      const timer = setTimeout(() => {
        const p = this.pending.get(id);
        if (p) this.settle(id, p, { error: new Error('worker 请求超时') });
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.worker.postMessage({ id, cmd });
      } catch (err) {
        /* postMessage 同步抛错（worker 已死/不可序列化）→ 立即 reject 该请求（否则永挂）。 */
        const p = this.pending.get(id);
        if (p) this.settle(id, p, { error: err instanceof Error ? err : new Error(String(err)) });
      }
    });
  }

  /** 终止 worker（释放线程）+ reject 所有 pending（不让挂起请求永久泄漏）。 */
  close(): void {
    this.closed = true;
    this.rejectAll(new Error('worker 已关闭'));
    this.worker.terminate?.();
  }

  private settle(id: number, p: PendingEntry, outcome: { value: PersonaResult } | { error: Error }): void {
    clearTimeout(p.timer);
    this.pending.delete(id);
    if ('value' in outcome) p.resolve(outcome.value);
    else p.reject(outcome.error);
  }

  private rejectAll(err: Error): void {
    for (const [id, p] of [...this.pending]) this.settle(id, p, { error: err });
  }
}

function workerError(e: unknown, fallback: string): Error {
  const msg = (e as { message?: unknown })?.message;
  return new Error(typeof msg === 'string' ? msg : fallback);
}

/**
 * 生产工厂：spawn 真浏览器 Web Worker（vite 用 `new Worker(new URL(...), { type: 'module' })`）。
 * 仅在浏览器环境调用（Node 测试用 PersonaWorkerClient + fake worker）。
 */
export function spawnPersonaWorker(): PersonaWorkerClient {
  const worker = new Worker(new URL('./persona-worker.js', import.meta.url), { type: 'module' });
  return new PersonaWorkerClient(worker as unknown as WorkerLike);
}

export type { PersonaCommand, PersonaResult };
