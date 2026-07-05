/**
 * Lightweight HTTP client for talking to a chrono-synth-os instance.
 *
 * The Tauri shell normally runs against a local SQLite via tauri-commands,
 * but agent OAuth + pending-confirmation flows require the HTTP API
 * because they involve external Google redirects and confirmation tokens
 * that live in the server-side conversation_confirmation_tokens table.
 *
 * The base URL and JWT live in localStorage so the user can point this
 * client at their own chrono-synth-os deployment.
 */

const STORAGE_BASE = 'chrono.api.baseUrl';
const STORAGE_TOKEN = 'chrono.api.token';

function normalizeBaseUrl(url: string | null): string | null {
  return url ? url.replace(/\/+$/, '') : null;
}

export function getApiBaseUrl(): string | null {
  if (typeof localStorage === 'undefined') return null;
  return localStorage.getItem(STORAGE_BASE);
}

export function getApiToken(): string | null {
  if (typeof localStorage === 'undefined') return null;
  return localStorage.getItem(STORAGE_TOKEN);
}

/* 同步 setter 只写 localStorage（纯、可预测）。它们**不**自己清 plan 缓存——清缓存是异步的
 * （app_settings），与凭据写入不在同一事务里。需要「换凭据」语义的调用方必须走下面可 await 的
 * setApiCredentials/clearCachedAccountPlan，并在 reload 前 await，否则 reload 会中断 pending
 * promise 导致缓存没清掉（Codex PR-A 复审 Major：fire-and-forget 竞态）。 */
export function setApiBaseUrl(url: string | null): void {
  if (typeof localStorage === 'undefined') return;
  const next = normalizeBaseUrl(url);
  if (next) localStorage.setItem(STORAGE_BASE, next);
  else localStorage.removeItem(STORAGE_BASE);
}

export function setApiToken(token: string | null): void {
  if (typeof localStorage === 'undefined') return;
  if (token) localStorage.setItem(STORAGE_TOKEN, token);
  else localStorage.removeItem(STORAGE_TOKEN);
}

/**
 * 作废缓存的账号 plan（account.plan）——**可 await**。
 *
 * plan 缓存是「上次探测到的账号类型」。换服务器/换 token 后旧 plan 可能属于另一个账号；若此时
 * 离线/探测失败，resolveAccountPlan 会回退旧缓存，把 enterprise 误渲染成 companion 外壳。
 * 凭据一变就清缓存，宁可回到「重新探测」也不沿用旧账号结论。动态 import 避免与 tauri-commands 静态环。
 */
export async function clearCachedAccountPlan(): Promise<void> {
  try {
    const [{ setAppSetting }, { APP_SETTING_ACCOUNT_PLAN }] = await Promise.all([
      import('./tauri-commands'),
      import('@/plan/account-plan'),
    ]);
    await setAppSetting(APP_SETTING_ACCOUNT_PLAN, '');
  } catch {
    /* 清缓存失败不阻断流程；下次探测成功会覆盖，脏缓存也已被 normalizeCachedPlan 收敛为 unconfigured。 */
  }
}

export interface ApiCredentials {
  /** 新 base URL；undefined=不动，null=清除。 */
  readonly baseUrl?: string | null;
  /** 新 token；undefined=不动，null=清除。 */
  readonly token?: string | null;
}

/**
 * 事务式更新凭据：同步写完 localStorage 后 **await** 清 plan 缓存。
 *
 * 调用方必须 `await setApiCredentials(...)` 再做 reload/onComplete——这样 plan 缓存一定在 plan
 * 重新解析（或页面重载）之前被清掉，关闭「换凭据后离线沿用旧 plan」的竞态。只在「真的变了」时清缓存。
 */
export async function setApiCredentials(creds: ApiCredentials): Promise<void> {
  if (typeof localStorage === 'undefined') return;
  let changed = false;

  if (creds.baseUrl !== undefined) {
    const next = normalizeBaseUrl(creds.baseUrl);
    if (next !== getApiBaseUrl()) {
      setApiBaseUrl(next);
      changed = true;
    }
  }
  if (creds.token !== undefined) {
    const next = creds.token ?? null;
    if (next !== getApiToken()) {
      setApiToken(next);
      changed = true;
    }
  }

  if (changed) await clearAccountScopedCaches();
}

/**
 * 清所有「跟当前账号绑定」的本地缓存：plan + companion growth。换凭据/登出时调用。
 * growth 是用户画像数据，必须跟凭据生命周期一起清，否则换账号会串显旧用户成长（Codex ② Major）。
 * 动态 import 避免与 companion/tauri 模块形成静态环。
 */
export async function clearAccountScopedCaches(): Promise<void> {
  await clearCachedAccountPlan();
  try {
    const { clearCachedCompanionGrowth } = await import('@/companion/growth-data');
    await clearCachedCompanionGrowth();
  } catch {
    /* growth 缓存模块加载/清理失败不阻断凭据流程；脏缓存读取已被 schema 校验收敛。 */
  }
}

export class ApiNotConfiguredError extends Error {
  constructor() {
    super('Chrono Synth API not configured. Set base URL + token under Settings.');
    this.name = 'ApiNotConfiguredError';
  }
}

export interface ApiFetchOptions extends Omit<RequestInit, 'body'> {
  body?: unknown;
}

export async function apiFetch<T>(path: string, options: ApiFetchOptions = {}): Promise<T> {
  /* ADR-0061 S2：优先本地 sidecar（内嵌 Node OS）。取到 → 用其 base + 握手头（红线 11）；否则回退手工
   * 配置的远端 server（localStorage，自托管模式）。 */
  const { getSidecarEndpoint } = await import('./sidecar-endpoint');
  const sidecar = await getSidecarEndpoint();
  try {
    return await doFetch<T>(path, options, sidecar);
  } catch (err) {
    /* sidecar 模式下 403(握手失效)/网络错（sidecar 崩溃重启后端口+token 变）→ 失效缓存 + 重取端点 + 重试一次
     * （拿新 token/端口）。Codex S2 复审补：防「重启后旧 token 缓存踩坑」+「首次 invoke 失败永久缓存 null」。
     *
     * 缓存失效与重试**分离**（crash auto-restart follow-up）：只要是本地 sidecar 的网络错（端点可能因崩溃重启
     * 而陈旧），就**先失效缓存**——失效纯粹是清缓存、无副作用，让**下一次**请求重取活端点。而是否在**本次**
     * 补发重试仍受方法约束（非幂等 POST 不自证「未触达」，不重试；否则会重复副作用）。这样即便本次 POST
     * 不重试，紧接着的请求也不会再打死端口。 */
    if (sidecar && shouldInvalidateOnSidecarError(err)) {
      const { invalidateSidecarEndpoint } = await import('./sidecar-endpoint');
      invalidateSidecarEndpoint();
      if (isRetriableSidecarError(err, options.method)) {
        const fresh = await getSidecarEndpoint();
        if (fresh) return await doFetch<T>(path, options, fresh);
      }
    }
    throw err;
  }
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** 握手失效的**专用**错误码（server desktop-session guard 返回）。只有它才代表「未执行副作用的握手层拒绝」。 */
const DESKTOP_SESSION_DENY_CODE = 'AUTH_MISSING_DESKTOP_SESSION';

/** 带状态码 + 解析出的业务 code 的 HTTP 错误（供重试决策精确判定，不再 regex message）。 */
export class ApiHttpError extends Error {
  constructor(readonly status: number, readonly code: string | null, message: string) {
    super(message);
    this.name = 'ApiHttpError';
  }
}

/**
 * 判定是否可安全重试（sidecar 端点陈旧）。
 *  - **握手失效 403（且 code=AUTH_MISSING_DESKTOP_SESSION）**：server guard 在业务 handler **之前**拒绝 →
 *    未产生副作用 → **任何方法**都可安全重试（拿新 token）。**普通 403**（RBAC/plan/CSRF/业务）**不重试**——
 *    那是真实拒绝/可能已触达 handler，泛化重试会重复副作用或掩盖真错（Codex S2 复审补，收窄到专用 code）。
 *  - **网络错（TypeError）**：可能发生在请求已到达并提交副作用、响应断开之后 → 非幂等方法（POST/DELETE/PATCH）
 *    **不自动重试**（不可证明未触达）；仅 GET/HEAD/OPTIONS 等安全方法重试。
 */
function isRetriableSidecarError(err: unknown, method?: string): boolean {
  if (err instanceof ApiHttpError && err.status === 403 && err.code === DESKTOP_SESSION_DENY_CODE) return true;
  if (err instanceof TypeError) return SAFE_METHODS.has((method ?? 'GET').toUpperCase());
  return false;
}

/**
 * 是否应在此错误上**失效** sidecar 端点缓存（与是否重试解耦）。失效无副作用（仅清缓存），故比重试更宽：
 * 握手失效 403 + **任何**网络错（TypeError）都失效——崩溃重启后端口/token 变，任何方法的网络错都可能是
 * 「打到了死端口」，下次请求应重取活端点。返回 true 的集合是 isRetriableSidecarError 的超集。
 */
function shouldInvalidateOnSidecarError(err: unknown): boolean {
  if (err instanceof ApiHttpError && err.status === 403 && err.code === DESKTOP_SESSION_DENY_CODE) return true;
  return err instanceof TypeError;
}

async function doFetch<T>(path: string, options: ApiFetchOptions, sidecar: { baseUrl: string; handshakeToken: string } | null): Promise<T> {
  const base = sidecar ? sidecar.baseUrl : getApiBaseUrl();
  const token = getApiToken();
  /* 本地 sidecar 模式仍需 JWT token（S3 自动 provision 本地 admin）；远端模式 base+token 都须配。 */
  if (!base || !token) throw new ApiNotConfiguredError();
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    authorization: `Bearer ${token}`,
    /* 红线 11：本地 sidecar 请求带 per-launch 握手 token（同机其他进程/误连无此 token → 403）。 */
    ...(sidecar ? { 'x-chrono-desktop-session': sidecar.handshakeToken } : {}),
    ...((options.headers as Record<string, string>) ?? {}),
  };
  const init: RequestInit = {
    ...options,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  };
  const res = await fetch(`${base}${path}`, init);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    /* 解析业务 code（供重试精确判定：只有握手失效码才全方法重试）。非 JSON 或无 code → null。 */
    let code: string | null = null;
    try { const j = JSON.parse(text) as { code?: unknown }; if (typeof j.code === 'string') code = j.code; } catch { /* 非 JSON */ }
    throw new ApiHttpError(res.status, code, `HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}
