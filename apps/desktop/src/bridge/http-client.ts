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

/**
 * 凭据（base URL / token）变更时，作废缓存的账号 plan（account.plan）。
 *
 * plan 缓存是「上次探测到的账号类型」。一旦换了服务器或换了 token，旧 plan 可能属于另一个账号
 * ——若此时离线/探测失败，resolveAccountPlan 会回退旧缓存，把 enterprise 账号误渲染成 companion
 * 外壳（Codex PR-A Major）。故凭据一变就清掉缓存：宁可回到「未配置/重新探测」，也不沿用旧账号结论。
 *
 * best-effort + 动态 import：http-client 是同步 localStorage 层，plan 缓存在异步 app_settings；
 * 用 fire-and-forget 动态 import 清除，既不让本函数变 async，也避免与 tauri-commands 形成静态环。
 */
function invalidateCachedAccountPlan(): void {
  void (async () => {
    try {
      const [{ setAppSetting }, { APP_SETTING_ACCOUNT_PLAN }] = await Promise.all([
        import('./tauri-commands'),
        import('@/plan/account-plan'),
      ]);
      await setAppSetting(APP_SETTING_ACCOUNT_PLAN, '');
    } catch {
      /* 清缓存失败不阻断登录/配置流程；下次探测成功会覆盖，离线时脏缓存已被 normalize 收敛。 */
    }
  })();
}

export function getApiBaseUrl(): string | null {
  if (typeof localStorage === 'undefined') return null;
  return localStorage.getItem(STORAGE_BASE);
}

export function setApiBaseUrl(url: string | null): void {
  if (typeof localStorage === 'undefined') return;
  const next = url ? url.replace(/\/+$/, '') : null;
  const prev = localStorage.getItem(STORAGE_BASE);
  if (next) localStorage.setItem(STORAGE_BASE, next);
  else localStorage.removeItem(STORAGE_BASE);
  if (next !== prev) invalidateCachedAccountPlan();
}

export function getApiToken(): string | null {
  if (typeof localStorage === 'undefined') return null;
  return localStorage.getItem(STORAGE_TOKEN);
}

export function setApiToken(token: string | null): void {
  if (typeof localStorage === 'undefined') return;
  const next = token ?? null;
  const prev = localStorage.getItem(STORAGE_TOKEN);
  if (next) localStorage.setItem(STORAGE_TOKEN, next);
  else localStorage.removeItem(STORAGE_TOKEN);
  if (next !== prev) invalidateCachedAccountPlan();
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
  const base = getApiBaseUrl();
  const token = getApiToken();
  if (!base || !token) throw new ApiNotConfiguredError();
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    authorization: `Bearer ${token}`,
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
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}
