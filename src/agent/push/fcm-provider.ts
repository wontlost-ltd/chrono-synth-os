/**
 * FcmProvider — 通过 FCM v1 HTTP API 把 PushPayload 投递到 Android 设备。
 *
 * 与 ApnsProvider 同样采用 端口/适配器 模式：
 *   FcmTransport 是抽象端口（POST messages:send，返回状态 + body），
 *   live 实现包 firebase-admin（或者 Google OAuth2 + REST 直连），
 *   测试实现用注入的 stub。
 *
 * 凭证注入（live 时）:
 *   FCM v1 需要 service-account JSON。FcmProvider.fromEnv() 读
 *   CHRONO_FCM_SERVICE_ACCOUNT_PATH，没有时返回 null。
 *
 * Token 失效翻译:
 *   FCM 在 token 已注销时返回 HTTP 404 {error: {status: "NOT_FOUND",
 *   details: [{errorCode: "UNREGISTERED"}]}}; 也可能是 INVALID_ARGUMENT
 *   带 errorCode INVALID_ARGUMENT。两者都映射成 tokenInvalidated.
 */

import type {
  PushOpts,
  PushPayload,
  PushProvider,
  PushResult,
} from '../../types/push.js';

/* ── 端口 ────────────────────────────────────────────────────────────── */

export interface FcmRequest {
  readonly body: unknown;
}

export interface FcmResponse {
  readonly status: number;
  readonly body: unknown;
}

export interface FcmTransport {
  send(req: FcmRequest): Promise<FcmResponse>;
  close(): Promise<void>;
}

/* ── 配置 ────────────────────────────────────────────────────────────── */

export interface FcmConfig {
  readonly projectId: string;
}

/* ── 错误 → tokenInvalidated 映射 ──────────────────────────────────── */

/**
 * FCM v1 在 token 已失效时返回这些 errorCode。
 *
 * 参考: https://firebase.google.com/docs/cloud-messaging/send-message#admin
 */
const FCM_INVALID_TOKEN_ERROR_CODES = new Set([
  'UNREGISTERED',
  'INVALID_ARGUMENT',
  'SENDER_ID_MISMATCH',
]);

/* ── Provider ────────────────────────────────────────────────────────── */

export class FcmProvider implements PushProvider {
  readonly channel = 'fcm' as const;

  constructor(
    private readonly transport: FcmTransport,
    private readonly _config: FcmConfig,
  ) {
    /* projectId 当前主要让构造器持有，便于将来注入到 transport；
     * MockTransport 不需要它，apns2/firebase-admin 已经从 service-account 读出。 */
    void this._config;
  }

  async send(pushToken: string, payload: PushPayload, opts?: PushOpts): Promise<PushResult> {
    const req = { body: this.buildBody(pushToken, payload, opts) };
    let resp: FcmResponse;
    try {
      resp = await this.transport.send(req);
    } catch (err) {
      return {
        deviceId: pushToken,
        success: false,
        error: `fcm transport error: ${(err as Error).message}`,
      };
    }

    if (resp.status === 200) {
      return { deviceId: pushToken, success: true };
    }

    const errorCode = parseErrorCode(resp.body);
    const tokenInvalidated = errorCode !== null && FCM_INVALID_TOKEN_ERROR_CODES.has(errorCode);

    return {
      deviceId: pushToken,
      success: false,
      error: errorCode ? `fcm ${resp.status} ${errorCode}` : `fcm ${resp.status}`,
      ...(tokenInvalidated ? { tokenInvalidated: true } : {}),
    };
  }

  async close(): Promise<void> {
    await this.transport.close();
  }

  /**
   * 构造 FCM v1 请求 body。
   * 参考: https://firebase.google.com/docs/reference/fcm/rest/v1/projects.messages
   *
   * 注意 FCM 的 priority 用 string 而不是 enum，TTL 用 "<seconds>s" 字符串
   * 形式（Google duration encoding）。collapse_key 直接对应 collapseKey opt.
   */
  private buildBody(pushToken: string, payload: PushPayload, opts?: PushOpts): unknown {
    const message: Record<string, unknown> = {
      token: pushToken,
      notification: {
        title: payload.title,
        body: payload.body,
      },
    };
    if (payload.data) {
      message['data'] = { ...payload.data };
    }

    const android: Record<string, unknown> = {};
    if (opts?.priority) {
      android['priority'] = opts.priority === 'high' ? 'HIGH' : 'NORMAL';
    }
    if (opts?.ttlSeconds !== undefined) {
      android['ttl'] = `${opts.ttlSeconds}s`;
    }
    if (opts?.collapseKey) {
      android['collapse_key'] = opts.collapseKey;
    }
    if (Object.keys(android).length > 0) {
      message['android'] = android;
    }

    return { message };
  }
}

function parseErrorCode(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const errObj = (body as { error?: unknown }).error;
  if (!errObj || typeof errObj !== 'object') return null;
  /* FCM v1 may surface the code in either error.status or error.details[].errorCode */
  const status = (errObj as { status?: unknown }).status;
  if (typeof status === 'string' && status === 'NOT_FOUND') return 'UNREGISTERED';
  const details = (errObj as { details?: unknown }).details;
  if (Array.isArray(details)) {
    for (const d of details) {
      if (d && typeof d === 'object') {
        const code = (d as { errorCode?: unknown }).errorCode;
        if (typeof code === 'string') return code;
      }
    }
  }
  if (typeof status === 'string') return status;
  return null;
}
