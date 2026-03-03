/**
 * 推送服务抽象层
 * 提供统一的推送接口，具体实现可替换（APNs/FCM/Web Push）
 */

import type { Logger } from '../../utils/logger.js';
import type { PushPayload, PushChannel, PushResult, PushService } from '../../types/push.js';

export type { PushPayload, PushChannel, PushResult, PushService };

/** Mock 推送服务（开发/测试用） */
export class MockPushService implements PushService {
  readonly channel = 'mock' as const;
  readonly sent: Array<{ tenantId: string; deviceId: string; payload: PushPayload }> = [];

  constructor(private readonly logger?: Logger) {}

  async send(tenantId: string, deviceId: string, payload: PushPayload): Promise<PushResult> {
    this.sent.push({ tenantId, deviceId, payload });
    this.logger?.info('MockPush', `[${tenantId}] → ${deviceId}: ${payload.title}`);
    return { deviceId, success: true };
  }

  async sendBatch(tenantId: string, deviceIds: string[], payload: PushPayload): Promise<PushResult[]> {
    const results: PushResult[] = [];
    for (const deviceId of deviceIds) {
      results.push(await this.send(tenantId, deviceId, payload));
    }
    return results;
  }
}
