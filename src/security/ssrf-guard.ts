/**
 * SSRF guard — validate outbound URLs against an egress allowlist and
 * block private / loopback / link-local addresses.
 *
 * Plan: poc-to-enterprise-ga-2026-v7.3.md §3.8 P1-X-ssrf
 *
 * Where to call this:
 *   - Webhook delivery (DriftAlertService, integrations)
 *   - URL content fetcher (knowledge import, web search tool)
 *   - OAuth callback registration
 *
 * Two-stage check (defence in depth against DNS rebinding):
 *   1. Pre-resolve check: protocol + host shape vs the static allowlist.
 *   2. Post-resolve check: the caller passes the *resolved IP* and we
 *      re-validate that it's not RFC 1918 / loopback / link-local /
 *      multicast / IPv6 equivalents. The caller is expected to resolve
 *      ONCE and use the same IP for the actual connection (pin DNS),
 *      otherwise an attacker can return a public IP at resolve time and
 *      a private IP at connect time (the classic DNS rebinding attack).
 */

import { isIP } from 'node:net';

export type SsrfDecision =
  | { ok: true }
  | { ok: false; code: 'INVALID_URL' | 'UNSUPPORTED_SCHEME' | 'PRIVATE_HOST' | 'NOT_IN_ALLOWLIST'; reason: string };

export interface SsrfGuardOptions {
  /** Allowed URL schemes; everything else is blocked. */
  allowedSchemes: readonly string[];
  /** Optional explicit hostname allowlist; empty means any non-private hostname. */
  hostAllowlist: readonly string[];
  /** Honour overriding env var `SSRF_GUARD_DISABLED=1` for dev only — emits a
   * warning when the bypass is active. Default false (cannot be bypassed). */
  allowEnvBypass: boolean;
}

export const DEFAULT_SSRF_OPTIONS: SsrfGuardOptions = {
  allowedSchemes: ['https:'],
  hostAllowlist: [],
  allowEnvBypass: false,
};

/* IPv4 private + special ranges per RFC 1918 / 5735 / 6890. Each entry
 * is a [start, end] tuple of integer-encoded addresses for inclusive
 * range checks. */
const PRIVATE_V4_RANGES: ReadonlyArray<readonly [number, number]> = [
  [intFromV4('10.0.0.0'),       intFromV4('10.255.255.255')],
  [intFromV4('172.16.0.0'),     intFromV4('172.31.255.255')],
  [intFromV4('192.168.0.0'),    intFromV4('192.168.255.255')],
  [intFromV4('127.0.0.0'),      intFromV4('127.255.255.255')],   /* loopback */
  [intFromV4('169.254.0.0'),    intFromV4('169.254.255.255')],   /* link-local / AWS metadata */
  [intFromV4('100.64.0.0'),     intFromV4('100.127.255.255')],   /* CGNAT */
  [intFromV4('224.0.0.0'),      intFromV4('239.255.255.255')],   /* multicast */
  [intFromV4('0.0.0.0'),        intFromV4('0.255.255.255')],     /* "this network" */
  [intFromV4('192.0.2.0'),      intFromV4('192.0.2.255')],       /* TEST-NET-1 */
  [intFromV4('198.18.0.0'),     intFromV4('198.19.255.255')],    /* benchmarking */
  [intFromV4('198.51.100.0'),   intFromV4('198.51.100.255')],    /* TEST-NET-2 */
  [intFromV4('203.0.113.0'),    intFromV4('203.0.113.255')],     /* TEST-NET-3 */
  [intFromV4('255.255.255.255'), intFromV4('255.255.255.255')],  /* limited broadcast */
];

function intFromV4(ip: string): number {
  const parts = ip.split('.').map(p => Number.parseInt(p, 10));
  if (parts.length !== 4 || parts.some(p => Number.isNaN(p))) return -1;
  return ((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0;
}

export function isPrivateIPv4(ip: string): boolean {
  const n = intFromV4(ip);
  if (n < 0) return false;
  return PRIVATE_V4_RANGES.some(([lo, hi]) => n >= lo && n <= hi);
}

/**
 * 把 IPv6 文本展开成 8 组 16 位整数（完整 128 位）。不可解析返回 undefined。
 *
 * 为什么必须归一化而非字符串前缀匹配：IPv4-mapped 地址有**多种等价写法**——
 * `::ffff:127.0.0.1` 与 `::ffff:7f00:1` 是同一个地址，但后者不含点分形式。
 * 早期实现只认前者，导致 `::ffff:a9fe:a9fe`（=169.254.169.254 云元数据端点）
 * 被判为公网地址而放行（审计 Critical）。
 */
function expandIPv6(ip: string): number[] | undefined {
  let s = ip.toLowerCase().trim();
  /* 去掉 zone id（fe80::1%eth0）与可能的方括号。 */
  const pct = s.indexOf('%');
  if (pct >= 0) s = s.slice(0, pct);
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);

  /* 尾部若是点分 IPv4（::ffff:1.2.3.4 / ::1.2.3.4），先换算成两组 16 位。 */
  const lastColon = s.lastIndexOf(':');
  const tail = lastColon >= 0 ? s.slice(lastColon + 1) : '';
  if (tail.includes('.')) {
    if (isIP(tail) !== 4) return undefined;
    const n = intFromV4(tail);
    if (n < 0) return undefined;
    s = `${s.slice(0, lastColon + 1)}${((n >>> 16) & 0xffff).toString(16)}:${(n & 0xffff).toString(16)}`;
  }

  /* 展开 :: 省略段。 */
  const dbl = s.indexOf('::');
  let head: string[];
  let rest: string[];
  if (dbl >= 0) {
    head = s.slice(0, dbl).split(':').filter((p) => p.length > 0);
    rest = s.slice(dbl + 2).split(':').filter((p) => p.length > 0);
    if (head.length + rest.length > 8) return undefined;
  } else {
    head = s.split(':');
    rest = [];
    if (head.length !== 8) return undefined;
  }
  const zeros = 8 - head.length - rest.length;
  const groups = [...head, ...Array<string>(zeros).fill('0'), ...rest];

  const out: number[] = [];
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return undefined;
    out.push(Number.parseInt(g, 16));
  }
  return out.length === 8 ? out : undefined;
}

/**
 * IPv6 私有 / 环回 / 链路本地检测。**先归一化成 128 位再判定**，
 * 使各种等价写法（点分、十六进制、补零、IPv4-compatible）得到一致结果。
 */
export function isPrivateIPv6(ip: string): boolean {
  const g = expandIPv6(ip);
  if (!g) return false;

  /* 前 6 组全 0 时，末 2 组是嵌入的 IPv4（IPv4-compatible ::a.b.c.d）；
   * 前 5 组 0 + 第 6 组 0xffff 是 IPv4-mapped ::ffff:a.b.c.d。两者都要按 v4 规则判。 */
  const firstFiveZero = g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0;
  if (firstFiveZero && (g[5] === 0xffff || g[5] === 0)) {
    const embedded = ((g[6]! << 16) >>> 0) + g[7]!;
    /* ::0 与 ::1 由嵌入值 0/1 覆盖（0.0.0.0 与 0.0.0.1 都在 "this network" 段内）。 */
    return PRIVATE_V4_RANGES.some(([lo, hi]) => embedded >= lo && embedded <= hi);
  }

  const h = g[0]!;
  if (h >= 0xfc00 && h <= 0xfdff) return true;   /* fc00::/7  unique-local */
  if (h >= 0xfe80 && h <= 0xfebf) return true;   /* fe80::/10 link-local */
  if (h >= 0xff00) return true;                  /* ff00::/8  multicast */
  return false;
}

export function isPrivateAddress(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) return isPrivateIPv4(ip);
  if (kind === 6) return isPrivateIPv6(ip);
  return false;
}

/**
 * Pre-resolve check: parse URL + validate scheme + host shape. Caller
 * still needs to do the post-resolve check (assertResolvedAddressSafe)
 * once DNS returns to defend against DNS rebinding.
 */
export function validateOutboundUrl(
  rawUrl: string,
  opts: SsrfGuardOptions = DEFAULT_SSRF_OPTIONS,
): SsrfDecision {
  if (opts.allowEnvBypass && process.env.SSRF_GUARD_DISABLED === '1') {
    /* Bypass acknowledged — caller responsible for logging. */
    return { ok: true };
  }

  let url: URL;
  try { url = new URL(rawUrl); }
  catch { return { ok: false, code: 'INVALID_URL', reason: `URL parse failed: ${rawUrl}` }; }

  if (!opts.allowedSchemes.includes(url.protocol)) {
    return {
      ok: false, code: 'UNSUPPORTED_SCHEME',
      reason: `scheme ${url.protocol} not in allowlist ${opts.allowedSchemes.join(',')}`,
    };
  }

  /* If the host is a literal IP, check it now — no DNS round-trip
   * needed. URL keeps IPv6 hosts in [::1] form; strip brackets so the
   * Node isIP() check sees a parseable address. Hostnames must wait
   * for post-resolve. */
  const rawHost = url.hostname;
  const host = rawHost.startsWith('[') && rawHost.endsWith(']')
    ? rawHost.slice(1, -1)
    : rawHost;
  if (isIP(host)) {
    if (isPrivateAddress(host)) {
      return { ok: false, code: 'PRIVATE_HOST', reason: `host ${host} is in a private/reserved range` };
    }
    /* Literal IPs bypass the hostname allowlist by design — if you
     * configure a hostname allowlist you want DNS to be the bridge. */
    if (opts.hostAllowlist.length > 0) {
      return { ok: false, code: 'NOT_IN_ALLOWLIST', reason: `IP literals are not allowed when hostAllowlist is set` };
    }
    return { ok: true };
  }

  if (opts.hostAllowlist.length > 0 && !opts.hostAllowlist.includes(host)) {
    return { ok: false, code: 'NOT_IN_ALLOWLIST', reason: `host ${host} not in allowlist` };
  }

  return { ok: true };
}

/**
 * Post-DNS-resolve check — guard against DNS rebinding. The caller is
 * expected to resolve once, validate the IP here, then connect to that
 * EXACT IP (pinned). Otherwise the resolver may return the safe public
 * IP at validation time and the malicious internal IP at connect time.
 */
export function assertResolvedAddressSafe(ip: string): SsrfDecision {
  if (!isIP(ip)) {
    return { ok: false, code: 'INVALID_URL', reason: `resolved value "${ip}" is not an IP` };
  }
  if (isPrivateAddress(ip)) {
    return { ok: false, code: 'PRIVATE_HOST', reason: `resolved IP ${ip} is in a private/reserved range (DNS rebinding suspected)` };
  }
  return { ok: true };
}
