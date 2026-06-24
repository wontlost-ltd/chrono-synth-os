import { API_BASE_URL } from '../config';
import { getSession, setSession, clearSession, getSessionEpoch } from '../store/session';
import { addApiBreadcrumb } from '../lib/sentry';
import { getCsrfToken, resetCsrfToken } from '../lib/csrf';

/**
 * 标准化 API 错误。除 status/message 外，保留后端给出的机器可读 `code`
 * 与 i18n 渲染键 `messageId` —— 前端可据此切换文案 / 引导文案，不依赖
 * 易漂移的 `message` 字面值。`fields` 仅在 ValidationError 时出现。
 *
 * Plan: poc-to-enterprise-ga-2026-v7.3.md §8 #8 — error contract symmetry。
 */
export interface ApiErrorBody {
  code?: string;
  message?: string;
  messageId?: string;
  fields?: Record<string, unknown>;
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code: string | null = null,
    public readonly messageId: string | null = null,
    public readonly fields: Readonly<Record<string, unknown>> | null = null,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * 从 fetch 错误体里提取标准化错误形状。无论后端是否给出完整字段，
 * 都返回 `{ message, code, messageId, fields }`，让 UI 层可以稳定渲染。
 *
 * `message` 经过白名单 sanitize 以避免回显 SQL/堆栈片段；`code` 与
 * `messageId` 不参与 sanitize，因为它们本就是受控枚举值。
 */
function parseErrorBody(status: number, raw: string): {
  message: string;
  code: string | null;
  messageId: string | null;
  fields: Record<string, unknown> | null;
} {
  let parsed: ApiErrorBody | null = null;
  try {
    parsed = JSON.parse(raw) as ApiErrorBody;
  } catch {
    /* 非 JSON 错误体按原样处理 */
  }

  /* 防御性 narrowing：恶意/不规范的错误体可能给出 message: {} / message: 42 / message: null。
   * 不做 .trim() 之前先确认 typeof，否则一个 ApiError 路径会抛 TypeError，破坏统一的 sanitize 合约。
   * 分支顺序：
   *   1) message 是 string → 使用
   *   2) parsed 存在但 message 不是 string（含 null / 数字 / 对象）→ 视为"有 JSON 但 message 不可用"，
   *      不要回退到 raw（raw 是原始 JSON，把整个 JSON 渲染给用户会泄露其他字段并污染 sanitize 逻辑）
   *   3) parsed 不存在（非 JSON 错误体）→ 使用 raw */
  let rawMessage: string;
  if (typeof parsed?.message === 'string') {
    rawMessage = parsed.message;
  } else if (parsed !== null) {
    rawMessage = '';
  } else {
    rawMessage = raw;
  }
  let message = rawMessage.trim();
  if (!message || message.length > 200) message = `API request failed (${status})`;
  else if (/[<>]|stack|trace|sql|select|insert|update|delete/i.test(message)) message = `API request failed (${status})`;
  else message = `API ${status}: ${message}`;

  return {
    message,
    code: typeof parsed?.code === 'string' ? parsed.code : null,
    messageId: typeof parsed?.messageId === 'string' ? parsed.messageId : null,
    fields: parsed?.fields && typeof parsed.fields === 'object' && !Array.isArray(parsed.fields)
      ? parsed.fields as Record<string, unknown>
      : null,
  };
}

/** 尝试通过 HttpOnly cookie 刷新 accessToken。
 *
 * /auth/refresh 走 cookie auth + 受 CSRF 保护（双 cookie 模式），所以
 * 必须把 csrf_token cookie 的值通过 X-CSRF-Token header 回送 —— 否则
 * 服务端的 csrf 插件返回 403 CSRF_TOKEN_MISMATCH，前端把它当成「refresh
 * 失败」清掉 session，用户被强制重登。这是个长期存在的"自动登出"bug。
 */
/*
 * refresh 三态（移植 companion-web 模型，消除「单端点 401 误登出」隐患）：
 *   - 'refreshed'：拿到新 accessToken，会话已续期。
 *   - 'failed'   ：refresh **真实**被拒（cookie 过期/无效，res 非 ok）→ 会话确已死，clearSession。
 *   - 'superseded'：①期间发生 login/logout（epoch 变）②或网络/CSRF 等**瞬时**异常 → 本次结果作废，
 *                   **绝不** clearSession（避免一个非关键端点的瞬时 refresh 失败把有效会话全局清掉）。
 */
type RefreshOutcome = 'refreshed' | 'failed' | 'superseded';
let refreshPromise: Promise<RefreshOutcome> | null = null;

async function tryRefresh(): Promise<RefreshOutcome> {
  if (refreshPromise) return refreshPromise;

  const startedEpoch = getSessionEpoch();
  refreshPromise = (async (): Promise<RefreshOutcome> => {
    try {
      const csrf = getCsrfToken();
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'X-CSRF-Protection': '1',
      };
      if (csrf) headers['X-CSRF-Token'] = csrf;

      const res = await fetch(`${API_BASE_URL}/api/v1/auth/refresh`, {
        method: 'POST',
        headers,
        credentials: 'include',
        body: '{}',
      });
      /* 期间发生了 login/logout（epoch 变）→ 本次 refresh 结果已陈旧，丢弃不写回也不清会话。 */
      if (getSessionEpoch() !== startedEpoch) return 'superseded';
      if (!res.ok) { clearSession(); return 'failed'; }
      const json = await res.json() as { data: { accessToken: string } };
      if (getSessionEpoch() !== startedEpoch) return 'superseded';
      if (!json.data?.accessToken) { clearSession(); return 'failed'; }
      setSession({ accessToken: json.data.accessToken });
      /* refresh 成功 → 后端在 Set-Cookie 里下发新的 csrf_token；强制重读避免下次 POST 带旧令牌 403。 */
      resetCsrfToken();
      return 'refreshed';
    } catch {
      /* 瞬时异常（网络/中断/CSRF 抖动）：一律**不清会话**——避免一个非关键端点的瞬时 refresh 失败
       * 把有效会话全局登出。视作 superseded，调用方拿到原始 401/错误自行处理（不强制重登）。 */
      return 'superseded';
    } finally {
      refreshPromise = null;
    }
  })();

  return refreshPromise;
}

/** 公开刷新接口，供 AuthGuard 启动时尝试恢复会话。返回是否拿到有效会话。 */
export async function refreshAccessToken(): Promise<boolean> {
  return (await tryRefresh()) === 'refreshed';
}

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await doFetch<T>(path, init);
  return res;
}

async function doFetch<T>(path: string, init?: RequestInit, isRetry = false): Promise<T> {
  const session = getSession();
  /* 记录发请求时的 token，用于 401 时判定是否为「陈旧 401」（期间会话已被并发 login/logout 换掉）。 */
  const sentToken = session.accessToken;
  const headers: Record<string, string> = {};

  /* 优先使用 Bearer token，回退到 API Key */
  if (session.accessToken) {
    headers['Authorization'] = `Bearer ${session.accessToken}`;
  } else if (session.apiKey) {
    headers['X-API-Key'] = session.apiKey;
  }
  if (session.tenantId) headers['X-Tenant-Id'] = session.tenantId;

  const method = init?.method?.toUpperCase() ?? 'GET';
  if (method !== 'GET' && method !== 'HEAD') {
    headers['Content-Type'] = 'application/json';
    headers['X-CSRF-Protection'] = '1';
    /* 如果服务器下发了 CSRF 令牌（meta 标签或 cookie），一并携带 */
    const csrf = getCsrfToken();
    if (csrf) headers['X-CSRF-Token'] = csrf;
  }

  const res = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    signal: init?.signal,
    headers: { ...headers, ...init?.headers },
    credentials: 'include',
  });

  /*
   * 401 + 非重试：按会话身份决策（移植 companion-web 模型，消除「单端点 401 误登出」）。
   *   - 陈旧 401（当前 token 已与发请求时不同，即期间发生了 login/logout）→ 用当前会话重试一次，
   *     绝不 refresh/清会话（否则一个在途的旧请求 401 会清掉刚换的新会话）。
   *   - 否则同一会话 → 尝试 refresh；'refreshed'/'superseded' 都重试一次（superseded 表示期间会话
   *     变化或瞬时失败，会话未被清，值得用当前态重试）；仅 'failed'（refresh 真实被拒）不重试，
   *     此时 clearSession 已在 tryRefresh 内做，最终按 401 抛给调用方。 */
  if (res.status === 401 && !isRetry) {
    if (getSession().accessToken !== sentToken) {
      return doFetch<T>(path, init, true);
    }
    const outcome = await tryRefresh();
    if (outcome === 'refreshed' || outcome === 'superseded') return doFetch<T>(path, init, true);
  }

  addApiBreadcrumb(method, path, res.status);

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const parsed = parseErrorBody(res.status, text);
    throw new ApiError(res.status, parsed.message, parsed.code, parsed.messageId, parsed.fields);
  }

  if (res.status === 204 || res.headers.get('content-length') === '0') {
    return undefined as T;
  }

  const contentType = res.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) {
    return undefined as T;
  }

  const body = await res.text();
  if (!body.trim()) return undefined as T;

  let json: unknown;
  try {
    json = JSON.parse(body) as unknown;
  } catch {
    throw new ApiError(res.status, `Invalid JSON response`);
  }

  /* Unwrap `{data: T}` envelope only when `data` is the SOLE field.
     Server responses like `{data: [...], pagination, summary}` are rich
     envelopes that callers want as-is — auto-unwrapping there would drop
     pagination/summary and break the UI. */
  if (
    json !== null &&
    typeof json === 'object' &&
    !Array.isArray(json) &&
    'data' in json &&
    Object.keys(json).length === 1
  ) {
    return (json as { data: T }).data;
  }
  return json as T;
}
