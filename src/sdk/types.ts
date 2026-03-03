/**
 * SDK 核心层类型导出
 * 聚合所有供外部客户端使用的类型定义
 */

/* Avatar Session 协议 */
export type {
  AvatarSessionPlatform,
  AvatarSessionTransport,
  AvatarSessionState,
  AvatarSessionInit,
  AvatarSessionStateChange,
  EventEnvelope,
  AvatarSnapshot,
  HandoffToken,
} from '../types/avatar-session.js';

/* 离线指令队列 */
export type {
  OfflineCommandType,
  OfflineCommandEnvelope,
  OfflineQueueConfig,
  OfflineConflict,
} from '../types/offline-queue.js';
export { OFFLINE_COMMAND_WHITELIST } from '../types/offline-queue.js';

/* 推送服务 */
export type { PushPayload, PushChannel, PushService } from '../types/push.js';

/* 系统事件 */
export type { SystemEventName, SystemEventMap } from '../types/events.js';
