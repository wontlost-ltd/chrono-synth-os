/**
 * 推送类型定义（SDK/Server 共享）
 */

/** 推送载荷 */
export interface PushPayload {
  readonly title: string;
  readonly body: string;
  readonly data?: Record<string, string>;
  readonly badge?: number;
  readonly sound?: string;
}

/** 推送通道 */
export type PushChannel = 'apns' | 'fcm' | 'web_push' | 'mock';

/** 推送结果 */
export interface PushResult {
  readonly deviceId: string;
  readonly success: boolean;
  readonly error?: string;
}

/** 推送服务接口 */
export interface PushService {
  readonly channel: PushChannel;
  send(tenantId: string, deviceId: string, payload: PushPayload): Promise<PushResult>;
  sendBatch(tenantId: string, deviceIds: string[], payload: PushPayload): Promise<PushResult[]>;
}
