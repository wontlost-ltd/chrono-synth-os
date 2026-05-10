/**
 * 推送类型定义（SDK / Server / Provider 三方共享）
 *
 * 分层:
 *   - PushPayload   = 用户消息（标题、正文、自定义 data 等）
 *   - PushOpts      = 平台投递选项（优先级、TTL、collapse-key、APNs apns-topic 等）
 *   - PushProvider  = 单通道实现（APNs / FCM / Mock），知道如何对接一种平台
 *   - PushService   = 多通道路由（按设备 platform 派发到对应 PushProvider）
 *   - tokenInvalidated  = 平台返回 BadDeviceToken / UNREGISTERED 时回调宿主，
 *                         由宿主把 device_tokens.is_invalid_at 标位
 */

/** 推送载荷 */
export interface PushPayload {
  readonly title: string;
  readonly body: string;
  readonly data?: Record<string, string>;
  readonly badge?: number;
  readonly sound?: string;
}

/** 平台投递选项 — 与 payload 分离，避免每条消息都重复声明运维参数 */
export interface PushOpts {
  /** 'high' = APNs 10 / FCM HIGH (允许唤醒)；'normal' = APNs 5 / FCM NORMAL (节流) */
  readonly priority?: 'high' | 'normal';
  /** 服务器允许 APNs/FCM 缓存这条消息的最大秒数。0 = 立即过期。 */
  readonly ttlSeconds?: number;
  /** 同 collapse-key 的旧消息会被新消息覆盖（同一设备只显示最新一条） */
  readonly collapseKey?: string;
}

/** 推送通道 */
export type PushChannel = 'apns' | 'fcm' | 'web_push' | 'mock';

/** 推送结果 */
export interface PushResult {
  readonly deviceId: string;
  readonly success: boolean;
  readonly error?: string;
  /** 平台明确告知 token 无效（BadDeviceToken / UNREGISTERED）。宿主应该把
   *  device_tokens.is_invalid_at 标位，避免下次重试。 */
  readonly tokenInvalidated?: boolean;
}

/** Token 失效回调 — 宿主把它注入 PushDispatcher，dispatcher 在收到 invalidated
 *  结果后异步调用，与 send() 主路径解耦。回调失败不影响 send 的返回。 */
export type TokenInvalidationCallback = (deviceId: string, reason: string) => Promise<void>;

/**
 * 单通道 Provider 接口。
 *
 * 一个实现 = 一个 channel（'apns' | 'fcm' | 'mock'）。Provider 不关心路由，
 * 不查 device_tokens，只负责"把这条 payload 发到指定 token"。push token 的
 * 解析、平台判定、错误聚合都在 PushDispatcher 完成。
 */
export interface PushProvider {
  readonly channel: PushChannel;
  /**
   * @param pushToken 平台原生 token（APNs hex / FCM registration token）
   * @param payload   用户消息
   * @param opts      可选投递参数
   */
  send(pushToken: string, payload: PushPayload, opts?: PushOpts): Promise<PushResult>;
  /** 关闭长连接（apns2 维持 HTTP/2 socket，必须在进程退出前 close）。 */
  close(): Promise<void>;
}

/**
 * 多通道路由接口（兼容旧调用点）。
 *
 * 早期只有 MockPushService 直接实现这个接口；新代码应注入 PushDispatcher，
 * 由 dispatcher 内部持有多个 PushProvider 并按 device.platform 路由。
 */
export interface PushService {
  readonly channel: PushChannel;
  send(tenantId: string, deviceId: string, payload: PushPayload, opts?: PushOpts): Promise<PushResult>;
  sendBatch(tenantId: string, deviceIds: string[], payload: PushPayload, opts?: PushOpts): Promise<PushResult[]>;
}
