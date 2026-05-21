/**
 * Locale 解析 — 从 HTTP Accept-Language 头按 RFC 7231 的 q-value 顺序
 * 选出最佳支持的 locale。无依赖、纯函数。
 *
 * Plan: poc-to-enterprise-ga-2026-v7.3.md §2.2 P1-E-ext
 *
 * Design: we keep this **strictly minimal**. A full ICU stack
 * (locale/region/script negotiation, BCP-47 lookup, plural rules) lands
 * with P1-E-ext-v2 once the product actually needs region-specific
 * formatting. v1 covers what enterprise procurement asks for:
 *   - 默认 en
 *   - 接受 zh-CN（最大企业市场）
 *   - 对未知 locale 安全降级到默认值，不抛错
 */

export const SUPPORTED_LOCALES = ['en', 'zh-CN'] as const;
export type SupportedLocale = typeof SUPPORTED_LOCALES[number];
export const DEFAULT_LOCALE: SupportedLocale = 'en';

interface AcceptLanguageEntry {
  locale: string;
  q: number;
}

/**
 * Parse an Accept-Language header. The grammar:
 *
 *   Accept-Language = #( language-range [ ";" OWS "q=" qvalue ] )
 *
 * We **deliberately don't** do full BCP-47 lookup (which would let
 * `zh-Hans-CN` match `zh-CN`). The supported set is small enough that
 * exact-then-prefix matching covers all the practical cases.
 */
export function parseAcceptLanguage(header: string | undefined): AcceptLanguageEntry[] {
  if (!header) return [];
  const entries: AcceptLanguageEntry[] = [];
  for (const part of header.split(',')) {
    const [rawLocale, ...params] = part.trim().split(';').map(s => s.trim());
    if (!rawLocale) continue;
    let q = 1;
    for (const param of params) {
      const m = /^q=([\d.]+)$/i.exec(param);
      if (m) {
        const parsed = Number.parseFloat(m[1]!);
        if (!Number.isNaN(parsed) && parsed >= 0 && parsed <= 1) q = parsed;
      }
    }
    /* q=0 means explicitly NOT acceptable; skip — never serve a locale the
     * client refused, even if it would otherwise match. */
    if (q > 0) entries.push({ locale: rawLocale, q });
  }
  /* Stable sort: highest q first; ties keep header order (Array.sort is
   * stable in modern V8). */
  entries.sort((a, b) => b.q - a.q);
  return entries;
}

/**
 * Resolve the best supported locale for the request. Strategy:
 *  1. Exact match against SUPPORTED_LOCALES.
 *  2. Language-tag prefix match (e.g. `zh` → `zh-CN`).
 *  3. Default locale.
 *
 * Header parsing is case-insensitive on the language tag; matching is too.
 */
export function resolveLocale(header: string | undefined): SupportedLocale {
  const entries = parseAcceptLanguage(header);
  for (const { locale } of entries) {
    const lower = locale.toLowerCase();
    /* exact */
    const exact = SUPPORTED_LOCALES.find(s => s.toLowerCase() === lower);
    if (exact) return exact;
    /* prefix */
    const prefix = lower.split('-')[0];
    if (prefix) {
      const matchPrefix = SUPPORTED_LOCALES.find(
        s => s.toLowerCase().split('-')[0] === prefix,
      );
      if (matchPrefix) return matchPrefix;
    }
  }
  return DEFAULT_LOCALE;
}

export function isSupportedLocale(value: string): value is SupportedLocale {
  return (SUPPORTED_LOCALES as readonly string[]).includes(value);
}
