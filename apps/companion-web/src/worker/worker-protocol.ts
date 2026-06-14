/**
 * 端侧人格 worker 消息协议（主线程 ↔ worker 共用类型）。
 */

import type { PersonaCommand, PersonaResult } from './persona-runtime.js';

/** 主线程 → worker：带 id 关联请求/响应。 */
export interface WorkerRequest {
  readonly id: number;
  readonly cmd: PersonaCommand;
}

/** worker → 主线程：ok 时带 result，否则带 error。 */
export type WorkerResponse =
  | { readonly id: number; readonly ok: true; readonly result: PersonaResult }
  | { readonly id: number; readonly ok: false; readonly error: string };
