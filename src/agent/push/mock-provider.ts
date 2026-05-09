/**
 * Mock PushProvider — 单通道、无副作用、内存可断言。
 *
 * 测试代码注入 MockProvider 来观察 send 调用，避免依赖真实 APNs/FCM。
 * 与 src/server/services/push-service.ts 的 MockPushService 区别:
 *   - MockPushService 是"多通道"路由层接口（旧），直接吞 deviceId
 *   - MockProvider 是"单通道"provider 接口（EP-3.1 后），吞 pushToken
 */

import type {
  PushChannel,
  PushOpts,
  PushPayload,
  PushProvider,
  PushResult,
} from '../../types/push.js';

export interface MockProviderRecord {
  readonly pushToken: string;
  readonly payload: PushPayload;
  readonly opts?: PushOpts;
  readonly invokedAt: number;
}

export interface MockProviderOptions {
  /** 用 'apns' / 'fcm' 让 dispatcher 路由测试也能跑；默认 'mock' */
  readonly channel?: PushChannel;
  /** 把指定的 token 强制视为已失效 — 用来测试 tokenInvalidated 回调 */
  readonly invalidTokens?: readonly string[];
  /** 把指定的 token 强制返回 send 失败（非 token-invalid） — 测试错误聚合 */
  readonly failingTokens?: readonly string[];
}

export class MockProvider implements PushProvider {
  readonly channel: PushChannel;
  readonly sent: MockProviderRecord[] = [];
  readonly closed = { value: false };

  private readonly invalidTokens: ReadonlySet<string>;
  private readonly failingTokens: ReadonlySet<string>;

  constructor(opts: MockProviderOptions = {}) {
    this.channel = opts.channel ?? 'mock';
    this.invalidTokens = new Set(opts.invalidTokens ?? []);
    this.failingTokens = new Set(opts.failingTokens ?? []);
  }

  async send(pushToken: string, payload: PushPayload, opts?: PushOpts): Promise<PushResult> {
    this.sent.push({
      pushToken,
      payload,
      ...(opts ? { opts } : {}),
      invokedAt: Date.now(),
    });

    if (this.invalidTokens.has(pushToken)) {
      return {
        deviceId: pushToken,
        success: false,
        error: 'mock: token marked as invalid',
        tokenInvalidated: true,
      };
    }
    if (this.failingTokens.has(pushToken)) {
      return {
        deviceId: pushToken,
        success: false,
        error: 'mock: provider unavailable',
      };
    }
    return { deviceId: pushToken, success: true };
  }

  async close(): Promise<void> {
    this.closed.value = true;
  }
}
