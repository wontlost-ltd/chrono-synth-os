/**
 * Avatar Session 协议类型定义
 * 跨平台统一会话协议：WebSocket / SSE / Polling 三种传输共用
 */

/** 会话连接平台 */
export type AvatarSessionPlatform = 'web' | 'mobile' | 'cli' | 'iot';

/** 会话传输方式 */
export type AvatarSessionTransport = 'ws' | 'sse' | 'poll';

/** 会话状态机 */
export type AvatarSessionState =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'subscribed'
  | 'receiving'
  | 'offline'
  | 'reconnecting'
  | 'closed';

/** 会话初始化参数 */
export interface AvatarSessionInit {
  readonly avatarId: string;
  readonly deviceId?: string;
  readonly tenantId: string;
  readonly platform: AvatarSessionPlatform;
  readonly transport?: AvatarSessionTransport | 'auto';
  readonly clientVersion?: string;
  readonly replay?: { readonly sinceSeq?: number };
  readonly reconnect?: {
    readonly enabled: boolean;
    readonly maxRetries: number;
    readonly baseDelayMs: number;
    readonly maxDelayMs: number;
  };
}

/** 会话状态变更事件 */
export interface AvatarSessionStateChange {
  readonly prev: AvatarSessionState;
  readonly next: AvatarSessionState;
  readonly reason?: string;
  readonly timestamp: number;
}

/** 标准化事件信封（WS / SSE / Poll 统一格式） */
export interface EventEnvelope {
  readonly seq: number;
  readonly event: string;
  readonly data: unknown;
  readonly tenantId?: string;
  readonly timestamp: number;
}

/** Avatar 快照（跨设备 handoff 使用） */
export interface AvatarSnapshot {
  readonly avatarId: string;
  readonly seq: number;
  readonly projection: {
    readonly L0: unknown;
    readonly L1: Record<string, unknown>;
    readonly L2: Record<string, unknown>;
    readonly L3: Record<string, unknown>;
    readonly L4: { readonly narrative: string; readonly memoryCount: number };
  };
  readonly autorun: {
    readonly enabled: boolean;
    readonly intervalMinutes: number;
    readonly lastRunAt: number | null;
  };
  readonly drift: {
    readonly pendingReview: boolean;
    readonly lastScore: number;
    readonly lastCheckAt: number | null;
  };
  readonly installedDevices: readonly string[];
}

/** Handoff Token（跨设备切换凭证） */
export interface HandoffToken {
  readonly token: string;
  readonly avatarId: string;
  readonly fromDeviceId: string;
  readonly lastSeq: number;
  readonly expiresAt: number;
}
