/**
 * GitHub 出站安全网关（薄封装）。
 *
 * 所有 GitHub 网络出站请求只经此函数发出：先用 SSRF guard 做先验校验
 * （锁死 host = api.github.com、scheme = https:），拒绝时直接抛错且
 * **绝不发出网络请求**；通过后才以 `redirect:'manual'` + 10s 超时调用
 * fetch。禁止自动跟随重定向可防止被 3xx 引导到 allowlist 之外的地址。
 *
 * 本封装只负责出站边界安全，不涉及认证/token 注入（见 AuthManager）。
 *
 * 复用：`validateOutboundUrl`（src/security/ssrf-guard.ts）承担实际的
 * scheme/host/私网地址判定，此处仅将默认策略收窄到 GitHub。
 */

import { validateOutboundUrl, DEFAULT_SSRF_OPTIONS } from '../../security/ssrf-guard.js';

/** GitHub 公有云 API 唯一允许的出站 host。 */
export const GITHUB_API_HOST = 'api.github.com';

/** 出站请求超时（毫秒）。GitHub API 正常响应远快于此值。 */
const REQUEST_TIMEOUT_MS = 10_000;

/** githubFetch 的可选项。 */
export interface GithubFetchOptions {
  /**
   * 覆盖默认的 host allowlist（默认 `[GITHUB_API_HOST]`）。用于 GitHub
   * Enterprise Server 自托管场景，允许指定内部 API host。
   */
  hostAllowlist?: string[];
  /**
   * 可注入的 fetch 实现，默认使用全局 `fetch`。仅用于可测性——生产路径
   * 始终走全局 fetch。
   */
  fetchImpl?: typeof fetch;
}

/**
 * 经 SSRF guard 校验后发出 GitHub 出站请求。
 *
 * @param url  目标 URL（必须是 https 且 host 命中 allowlist）。
 * @param init 透传给 fetch 的请求选项；`redirect` 与 `signal` 会被本封装覆盖。
 * @param opts 可选的 allowlist / fetch 注入。
 * @throws 当 URL 未通过 SSRF guard 时抛出 Error，且不发出任何网络请求。
 */
export async function githubFetch(
  url: string,
  init: RequestInit,
  opts?: GithubFetchOptions,
): Promise<Response> {
  const decision = validateOutboundUrl(url, {
    ...DEFAULT_SSRF_OPTIONS,
    hostAllowlist: opts?.hostAllowlist ?? [GITHUB_API_HOST],
    allowedSchemes: ['https:'],
  });

  if (!decision.ok) {
    /* 拒绝即终止——绝不发出网络请求。 */
    throw new Error(decision.reason ?? decision.code);
  }

  const doFetch = opts?.fetchImpl ?? fetch;
  return doFetch(url, {
    ...init,
    redirect: 'manual',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}
