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
