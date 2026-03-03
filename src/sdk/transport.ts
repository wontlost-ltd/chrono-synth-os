/**
 * SDK 传输抽象层接口
 * Web/App 用 WS，CLI 用 SSE，IoT 用 Poll
 */

import type {
  AvatarSessionPlatform,
  AvatarSessionTransport,
  AvatarSessionStateChange,
  EventEnvelope,
} from '../types/avatar-session.js';

/** 传输连接选项 */
export interface TransportOptions {
  readonly url: string;
  readonly authToken: string;
  readonly tenantId: string;
  readonly heartbeatMs?: number;
  readonly events?: readonly string[];
}

/** 传输层接口 */
export interface Transport {
  readonly name: AvatarSessionTransport;
  connect(opts: TransportOptions): Promise<void>;
  subscribe(cursor?: { sinceSeq?: number; events?: readonly string[] }): Promise<void>;
  unsubscribe(): Promise<void>;
  close(): Promise<void>;
  onEvent(cb: (evt: EventEnvelope) => void): () => void;
  onError(cb: (err: Error) => void): () => void;
  onStateChange(cb: (change: AvatarSessionStateChange) => void): () => void;
}

/** 传输工厂 */
export interface TransportFactory {
  create(name: AvatarSessionTransport): Transport;
  pickAuto(ctx: {
    platform: AvatarSessionPlatform;
    supportsWs: boolean;
    supportsSse: boolean;
  }): Transport;
}
