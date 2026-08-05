/**
 * 外部跳转 URL 校验（审计 Warning B6-3）。
 *
 * 背景：Billing checkout/portal、OAuth 授权、导出下载四处都把**服务端返回的字符串**
 * 直接赋给 `window.location`。若上游被攻陷、配置错误或响应被篡改，用户会被带到
 * `javascript:` 伪协议（同源脚本执行）或钓鱼站点。这些 URL 在契约里目前只是
 * `z.string()`，前端不校验就等于完全信任。
 *
 * 为什么不做精确域名白名单：Stripe 的 checkout/portal 域名有多个且会变
 * （checkout.stripe.com、billing.stripe.com、带地区前缀的变体…），硬编码清单会在
 * 供应商正常变更时误伤真实跳转。真正承重的防线是**协议白名单**——阻断
 * `javascript:`/`data:`/`blob:` 这类可执行伪协议，并强制 https（防降级到明文）。
 * 域名层面的信任交给后端：URL 由后端从 SDK 拿到，而非用户输入。
 */

/** 允许跳转的协议。仅 https——http 会让令牌在明文信道上暴露。 */
const ALLOWED_PROTOCOLS = new Set(['https:']);

/**
 * 校验并归一化一个用于浏览器跳转的外部 URL。
 *
 * @returns 合法时返回归一化后的绝对 URL；非法（解析失败 / 协议不在白名单）返回 null。
 *          调用方**必须**处理 null 分支——不要回退到原始字符串。
 */
export function safeExternalUrl(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    /* 相对路径或畸形串一律拒绝：外部跳转必须是绝对 URL，
     * 相对路径落到 window.location 会变成同源导航，语义完全不同。 */
    return null;
  }
  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) return null;
  return parsed.toString();
}

/**
 * 跳转到外部 URL；URL 非法时不跳转并返回 false，由调用方向用户报错。
 * 集中在此以免四个调用点各写一遍校验（漏一处即是一个开放重定向）。
 */
export function navigateExternal(raw: string | null | undefined): boolean {
  const safe = safeExternalUrl(raw);
  if (safe === null) return false;
  if (typeof window === 'undefined') return false;
  window.location.assign(safe);
  return true;
}
