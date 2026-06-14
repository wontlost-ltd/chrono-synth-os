/// <reference lib="webworker" />
/**
 * 端侧人格 Web Worker 入口（ADR-0052 Local Persona Autonomy 第一步）。
 *
 * 在浏览器 worker 线程加载 PersonaRuntime（真实 kernel value-service + 浏览器 host adapter），
 * 经 postMessage 与主线程通信。**kernel 真在非 Node 端侧 runtime 运行**——zero-LLM 论点的设备侧
 * 落地证明。worker 持有人格状态（端侧自治：断网无云仍可跑）。
 *
 * 消息协议：主线程发 { id, cmd: PersonaCommand } → worker 回 { id, ok, result?|error? }。
 * 纯逻辑在 persona-runtime.ts（可 Node 单测）；本文件只做 worker 边界绑定。
 */

import { PersonaRuntime, type PersonaCommand } from './persona-runtime.js';
import type { WorkerRequest, WorkerResponse } from './worker-protocol.js';

const runtime = new PersonaRuntime();

self.onmessage = (e: MessageEvent<WorkerRequest>): void => {
  const { id, cmd } = e.data;
  let response: WorkerResponse;
  try {
    const result = runtime.handle(cmd as PersonaCommand);
    response = { id, ok: true, result };
  } catch (err) {
    response = { id, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  (self as DedicatedWorkerGlobalScope).postMessage(response);
};
