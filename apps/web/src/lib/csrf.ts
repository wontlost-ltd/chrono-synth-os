/**
 * CSRF 令牌工具
 *
 * 从 <meta name="csrf-token"> 或 cookie 中读取服务器下发的 CSRF 令牌，
 * 供 API 客户端在变更请求（POST/PUT/DELETE 等）中携带。
 */

let cachedToken: string | null = null;

/** 从 meta 标签读取 CSRF 令牌 */
function readFromMeta(): string | null {
  if (typeof document === 'undefined') return null;
  const el = document.querySelector<HTMLMetaElement>('meta[name="csrf-token"]');
  return el?.content ?? null;
}

/**
 * 从 cookie 中读取 CSRF 令牌。
 *
 * 顺序：
 *   1) `csrf_token` — chrono-synth-os 的 auth 路由下发的 paired cookie
 *      （非 HttpOnly，与 chrono_refresh 配对，用于 double-submit 防护）
 *   2) `XSRF-TOKEN` — 兼容部分后端框架（Spring/Angular 默认拼写）
 *
 * 两者都存在时以 `csrf_token` 为准，因为本项目后端权威使用该名。
 */
function readFromCookie(): string | null {
  if (typeof document === 'undefined') return null;
  const primary = document.cookie.match(/(?:^|;\s*)csrf_token=([^;]+)/);
  if (primary?.[1]) return decodeURIComponent(primary[1]);
  const legacy = document.cookie.match(/(?:^|;\s*)XSRF-TOKEN=([^;]+)/);
  return legacy?.[1] ? decodeURIComponent(legacy[1]) : null;
}

/**
 * 获取当前 CSRF 令牌，优先读取 meta 标签，回退到 cookie。
 * 首次调用后缓存结果，避免重复 DOM 查询。
 */
export function getCsrfToken(): string | null {
  if (cachedToken !== null) return cachedToken;
  cachedToken = readFromMeta() ?? readFromCookie() ?? null;
  return cachedToken;
}

/**
 * 清除缓存的 CSRF 令牌（用于令牌轮换或会话变更后强制重新读取）。
 */
export function resetCsrfToken(): void {
  cachedToken = null;
}
