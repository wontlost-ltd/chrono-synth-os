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

/** Worker 的最小面（便于注入 fake 测试）。 */
export interface WorkerLike {
  postMessage(message: WorkerRequest): void;
  onmessage: ((e: MessageEvent<WorkerResponse>) => void) | null;
  terminate?(): void;
}

export class PersonaWorkerClient {
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (r: PersonaResult) => void; reject: (e: Error) => void }>();

  constructor(private readonly worker: WorkerLike) {
    this.worker.onmessage = (e: MessageEvent<WorkerResponse>): void => {
      const res = e.data;
      const p = this.pending.get(res.id);
      if (!p) return;                       /* 未知 id（已解决/陈旧）：忽略 */
      this.pending.delete(res.id);
      if (res.ok) p.resolve(res.result);
      else p.reject(new Error(res.error));
    };
  }

  /** 发一条命令到端侧人格 worker，返回结果 Promise（并发安全：id 关联）。 */
  send(cmd: PersonaCommand): Promise<PersonaResult> {
    const id = this.nextId++;
    return new Promise<PersonaResult>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, cmd });
    });
  }

  /** 终止 worker（释放线程）。 */
  close(): void {
    this.worker.terminate?.();
  }
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
