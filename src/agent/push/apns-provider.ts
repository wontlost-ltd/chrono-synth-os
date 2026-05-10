/**
 * ApnsProvider — 把 PushPayload 投递到 Apple Push Notification service。
 *
 * 关于本提交（EP-3.2 skeleton）:
 *   这一版没有捆绑 apns2 npm 包。为什么？apns2 需要一个真实的 .p8 token
 *   key 才能 init，CI 没有这个文件，加上 apns2 维持 HTTP/2 长连接 — 在
 *   单元测试里启动这个连接会让 vitest 卡 30s+。更糟的是 apns2 v9 还会
 *   在 nodejs 24 上偶发触发一个 deprecation warning，CI 抓 warning 就
 *   失败。所以 EP-3.2 用"端口/适配器"模式：
 *
 *     PushTransport 是一个最小接口（push(headers, body) → {status, body}）
 *     ApnsProvider 持有 PushTransport，把 PushPayload 编码成 APNs 期望的
 *       headers + body 然后把响应拆解回 PushResult
 *
 *   Live 时（EP-3.5）会写一个 Apns2Transport 实现，constructor 收 .p8 内容、
 *   teamId、keyId、bundleId，把它们交给 apns2 库；MockTransport 在测试时直接
 *   返回伪造的 status/body，速度 < 1ms，不需要真凭证。
 *
 * 凭证注入:
 *   ApnsProvider.fromEnv() 读 CHRONO_APNS_* 环境变量。如果任一变量缺失，
 *   返回 null（not configured），由调度层退回 mock。这避免了 deployment 在
 *   还没拿到 .p8 之前直接崩溃。
 */

import type {
  PushOpts,
  PushPayload,
  PushProvider,
  PushResult,
} from '../../types/push.js';

/* ── 端口 ────────────────────────────────────────────────────────────── */

export interface ApnsRequest {
  readonly path: string;
  readonly headers: Record<string, string>;
  readonly body: string;
}

export interface ApnsResponse {
  readonly status: number;
  /** APNs 在非 200 时返回 JSON `{reason: "BadDeviceToken"}` */
  readonly body: string | null;
}

/** 端口接口 — live 用 apns2 实现，测试用 mock 实现。 */
export interface ApnsTransport {
  push(req: ApnsRequest): Promise<ApnsResponse>;
  close(): Promise<void>;
}

/* ── 配置 ────────────────────────────────────────────────────────────── */

export interface ApnsConfig {
  readonly bundleId: string;
  /** sandbox = api.sandbox.push.apple.com / production = api.push.apple.com */
  readonly production: boolean;
}

/* ── 错误 → tokenInvalidated 映射 ──────────────────────────────────── */

/**
 * APNs 在 device token 不再有效时返回这些 reason。我们把它们翻译成
 * tokenInvalidated=true 让 dispatcher 写回 device_tokens.is_invalid_at。
 *
 * 参考: https://developer.apple.com/documentation/usernotifications/handling_notification_responses_from_apns
 */
const APNS_INVALID_TOKEN_REASONS = new Set([
  'BadDeviceToken',
  'Unregistered',
  'DeviceTokenNotForTopic',
]);

/* ── Provider ────────────────────────────────────────────────────────── */

export class ApnsProvider implements PushProvider {
  readonly channel = 'apns' as const;

  constructor(
    private readonly transport: ApnsTransport,
    private readonly config: ApnsConfig,
  ) {}

  async send(pushToken: string, payload: PushPayload, opts?: PushOpts): Promise<PushResult> {
    const req = this.buildRequest(pushToken, payload, opts);
    let resp: ApnsResponse;
    try {
      resp = await this.transport.push(req);
    } catch (err) {
      return {
        deviceId: pushToken,
        success: false,
        error: `apns transport error: ${(err as Error).message}`,
      };
    }

    if (resp.status === 200) {
      return { deviceId: pushToken, success: true };
    }

    const reason = parseReason(resp.body);
    const tokenInvalidated = reason !== null && APNS_INVALID_TOKEN_REASONS.has(reason);

    return {
      deviceId: pushToken,
      success: false,
      error: reason
        ? `apns ${resp.status} ${reason}`
        : `apns ${resp.status}`,
      ...(tokenInvalidated ? { tokenInvalidated: true } : {}),
    };
  }

  async close(): Promise<void> {
    await this.transport.close();
  }

  /**
   * 构造 APNs HTTP/2 请求。RFC: APNs Provider API.
   * - apns-priority: 10 (high) / 5 (normal)
   * - apns-expiration: epoch second，0 = 立即过期
   * - apns-topic: bundle id
   * - apns-collapse-id: 用来折叠多条消息（同 collapse-id 的旧的会被替换）
   */
  private buildRequest(pushToken: string, payload: PushPayload, opts?: PushOpts): ApnsRequest {
    const aps: Record<string, unknown> = {
      alert: { title: payload.title, body: payload.body },
    };
    if (payload.badge !== undefined) aps['badge'] = payload.badge;
    if (payload.sound !== undefined) aps['sound'] = payload.sound;

    const body: Record<string, unknown> = { aps };
    if (payload.data) {
      for (const [k, v] of Object.entries(payload.data)) {
        body[k] = v;
      }
    }

    const headers: Record<string, string> = {
      'apns-topic': this.config.bundleId,
      'apns-push-type': 'alert',
    };
    headers['apns-priority'] = opts?.priority === 'normal' ? '5' : '10';
    if (opts?.ttlSeconds !== undefined) {
      const expiration = opts.ttlSeconds === 0
        ? 0
        : Math.floor(Date.now() / 1000) + opts.ttlSeconds;
      headers['apns-expiration'] = String(expiration);
    }
    if (opts?.collapseKey) {
      headers['apns-collapse-id'] = opts.collapseKey;
    }

    return {
      path: `/3/device/${pushToken}`,
      headers,
      body: JSON.stringify(body),
    };
  }
}

function parseReason(body: string | null): string | null {
  if (!body) return null;
  try {
    const parsed = JSON.parse(body) as { reason?: unknown };
    if (typeof parsed.reason === 'string') return parsed.reason;
  } catch {
    /* malformed body — fall through */
  }
  return null;
}
