/**
 * 外部跳转 URL 校验（审计 Warning B6-3，与 apps/web 同款约定）。
 *
 * 桌面端用 `window.open(..., 'noopener,noreferrer')` 打开授权页——noopener 能防
 * 反向 window 引用，但**挡不住** `javascript:` 伪协议：该协议在打开时即执行。
 * 故同样在跳转前做协议白名单校验。
 */

const ALLOWED_PROTOCOLS = new Set(['https:']);

/** 校验并归一化外部 URL；非法返回 null（调用方必须处理该分支）。 */
export function safeExternalUrl(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) return null;
  return parsed.toString();
}

/** 在新窗口打开外部 URL；非法则不打开并返回 false。 */
export function openExternal(raw: string | null | undefined): boolean {
  const safe = safeExternalUrl(raw);
  if (safe === null) return false;
  if (typeof window === 'undefined') return false;
  window.open(safe, '_blank', 'noopener,noreferrer');
  return true;
}
