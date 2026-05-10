/**
 * PushDispatcher — 多通道路由（EP-3.4）。
 *
 * 职责:
 *   1. 根据 device.platform 选择对应的 PushProvider（apns / fcm / mock）
 *   2. 把 deviceId 解析成 pushToken（通过宿主注入的 lookup 函数）
 *   3. 在 provider 返回 tokenInvalidated 时异步回调宿主，让宿主把
 *      device_tokens.is_invalid_at 标位
 *   4. 进程关闭时调用每个 provider 的 close()，释放 HTTP/2 长连接
 *
 * 设计取舍:
 *   - dispatcher 不直接读 device_tokens 表，避免把 SyncWriteUnitOfWork 拽进
 *     这个文件；宿主用闭包注入 deviceLookup，实测更易于测试。
 *   - tokenInvalidated 回调是 fire-and-forget — send 的返回路径不等它，
 *     避免把推送主链路阻塞在 DB 写入上。失败只 log，不重试。
 *   - 没有平台 provider 注册时（如 deployment 只有 iOS 设备），FCM 设备
 *     调用会立即返回 success:false，error:'no provider for platform fcm'，
 *     而不是抛异常。让上层观测层（drift / autorun）能统计失败率。
 */

import type {
  PushOpts,
  PushPayload,
  PushProvider,
  PushResult,
  PushService,
  TokenInvalidationCallback,
} from '../../types/push.js';
import type { Logger } from '../../utils/logger.js';

/** 宿主提供的设备查找接口；返回 null 表示设备不存在或已删除。 */
export interface DeviceLookup {
  (deviceId: string): Promise<DeviceLookupResult | null>;
}

export interface DeviceLookupResult {
  readonly platform: 'ios' | 'android' | 'web' | 'desktop' | 'mock' | string;
  readonly pushToken: string | null;
  /** 已失效设备直接跳过（避免 hammer 已下线 token） */
  readonly tokenInvalid?: boolean;
}

export interface PushDispatcherOptions {
  /** 平台 → provider 映射。未注册的平台会得到 success:false 而不是抛异常。 */
  readonly providers: ReadonlyMap<string, PushProvider>;
  readonly deviceLookup: DeviceLookup;
  readonly onTokenInvalidated?: TokenInvalidationCallback;
  readonly logger?: Logger;
}

const PLATFORM_TO_CHANNEL: ReadonlyMap<string, string> = new Map([
  ['ios', 'apns'],
  ['android', 'fcm'],
  ['web', 'web_push'],
  ['mock', 'mock'],
]);

export class PushDispatcher implements PushService {
  /** PushService 接口要求一个 channel 字段；dispatcher 是路由层，统称 'mock'
   *  以避免和具体平台冲突。调用方应该看 PushResult 里实际命中的 provider。 */
  readonly channel = 'mock' as const;

  private readonly providers: ReadonlyMap<string, PushProvider>;
  private readonly deviceLookup: DeviceLookup;
  private readonly onTokenInvalidated?: TokenInvalidationCallback;
  private readonly logger?: Logger;

  constructor(opts: PushDispatcherOptions) {
    this.providers = opts.providers;
    this.deviceLookup = opts.deviceLookup;
    if (opts.onTokenInvalidated !== undefined) {
      this.onTokenInvalidated = opts.onTokenInvalidated;
    }
    if (opts.logger !== undefined) {
      this.logger = opts.logger;
    }
  }

  async send(
    _tenantId: string,
    deviceId: string,
    payload: PushPayload,
    opts?: PushOpts,
  ): Promise<PushResult> {
    const device = await this.deviceLookup(deviceId);
    if (!device) {
      return { deviceId, success: false, error: 'device not found' };
    }
    if (device.tokenInvalid) {
      return { deviceId, success: false, error: 'device token previously invalidated' };
    }
    if (!device.pushToken) {
      return { deviceId, success: false, error: 'device has no push token' };
    }

    const channel = PLATFORM_TO_CHANNEL.get(device.platform) ?? device.platform;
    const provider = this.providers.get(channel);
    if (!provider) {
      return {
        deviceId,
        success: false,
        error: `no provider for platform ${device.platform} (channel=${channel})`,
      };
    }

    const providerResult = await provider.send(device.pushToken, payload, opts);

    if (providerResult.tokenInvalidated && this.onTokenInvalidated) {
      this.fireAndForgetInvalidation(deviceId, providerResult.error ?? 'token invalidated');
    }

    /* 把 provider 的 deviceId（实际是 pushToken）替换成业务 deviceId，
     * 上游调用方一直传的是后者。 */
    return {
      ...providerResult,
      deviceId,
    };
  }

  async sendBatch(
    tenantId: string,
    deviceIds: string[],
    payload: PushPayload,
    opts?: PushOpts,
  ): Promise<PushResult[]> {
    /* 不并行：APNs HTTP/2 stream 已经多路复用，FCM 也单独限流；
     * 顺序发送让上层 log / 观测能按时间顺序读懂。 */
    const out: PushResult[] = [];
    for (const id of deviceIds) {
      out.push(await this.send(tenantId, id, payload, opts));
    }
    return out;
  }

  /** 关闭所有 provider 的长连接。在进程优雅退出时调用一次即可。 */
  async close(): Promise<void> {
    const seen = new Set<PushProvider>();
    for (const p of this.providers.values()) {
      if (seen.has(p)) continue;
      seen.add(p);
      try {
        await p.close();
      } catch (err) {
        this.logger?.warn('PushDispatcher', `provider.close failed: ${(err as Error).message}`);
      }
    }
  }

  private fireAndForgetInvalidation(deviceId: string, reason: string): void {
    if (!this.onTokenInvalidated) return;
    /* 不等待结果，不抛异常。回调失败由宿主自行 log。 */
    void this.onTokenInvalidated(deviceId, reason).catch((err: unknown) => {
      this.logger?.warn(
        'PushDispatcher',
        `tokenInvalidated callback failed for ${deviceId}: ${(err as Error).message}`,
      );
    });
  }
}
