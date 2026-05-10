/**
 * 推送服务抽象层
 * 提供统一的推送接口，具体实现可替换（APNs/FCM/Web Push）。
 *
 * EP-3.1 起，新代码应优先使用 PushDispatcher（在 src/agent/push/dispatcher.ts），
 * 它根据 device.platform 路由到对应的 PushProvider。MockPushService 仍然保留为
 * 早期调用点的兜底（如 mobile-device-facade 的 sendPushTest）。
 */

import type { Logger } from '../../utils/logger.js';
import type { PushPayload, PushChannel, PushOpts, PushResult, PushService } from '../../types/push.js';

export type { PushPayload, PushChannel, PushOpts, PushResult, PushService };

/** Mock 推送服务（开发/测试用） */
export class MockPushService implements PushService {
  readonly channel = 'mock' as const;
  readonly sent: Array<{ tenantId: string; deviceId: string; payload: PushPayload; opts?: PushOpts }> = [];

  constructor(private readonly logger?: Logger) {}

  async send(tenantId: string, deviceId: string, payload: PushPayload, opts?: PushOpts): Promise<PushResult> {
    this.sent.push({ tenantId, deviceId, payload, ...(opts ? { opts } : {}) });
    this.logger?.info('MockPush', `[${tenantId}] → ${deviceId}: ${payload.title}`);
    return { deviceId, success: true };
  }

  async sendBatch(tenantId: string, deviceIds: string[], payload: PushPayload, opts?: PushOpts): Promise<PushResult[]> {
    const results: PushResult[] = [];
    for (const deviceId of deviceIds) {
      results.push(await this.send(tenantId, deviceId, payload, opts));
    }
    return results;
  }
}
