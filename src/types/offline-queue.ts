/**
 * 离线指令队列类型定义
 * 仅白名单内的安全、幂等指令可在断网时排队
 */

/** 允许离线排队的指令类型（仅 REST API 级，不含连接级指令） */
export type OfflineCommandType =
  | 'drift_review'
  | 'install_avatar'
  | 'trigger_autorun'
  | 'update_push_token';

/** 离线指令白名单 */
export const OFFLINE_COMMAND_WHITELIST: ReadonlySet<OfflineCommandType> = new Set([
  'drift_review',
  'install_avatar',
  'trigger_autorun',
  'update_push_token',
]);

/** 离线指令信封 */
export interface OfflineCommandEnvelope {
  readonly id: string;
  readonly type: OfflineCommandType;
  readonly createdAt: number;
  readonly payload: Record<string, unknown>;
  readonly retries: number;
}

/** 离线队列配置 */
export interface OfflineQueueConfig {
  readonly maxItems: number;
  readonly maxAgeMs: number;
  readonly flushOnReconnect: boolean;
}

/** 离线指令冲突信息 */
export interface OfflineConflict {
  readonly commandId: string;
  readonly type: OfflineCommandType;
  readonly reason: string;
  readonly serverState: unknown;
}
