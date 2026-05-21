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

/** Conservative IPv6 private / loopback / link-local detection. */
export function isPrivateIPv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === '::1' || lower === '::') return true;
  /* ::ffff:a.b.c.d — IPv4-mapped IPv6; reuse the v4 check. */
  if (lower.startsWith('::ffff:')) {
    const v4 = lower.slice(7);
    if (isIP(v4) === 4) return isPrivateIPv4(v4);
  }
  /* fc00::/7 unique-local */
  if (/^f[cd][0-9a-f]{2}:/.test(lower)) return true;
  /* fe80::/10 link-local */
  if (/^fe[89ab][0-9a-f]:/.test(lower)) return true;
  /* ff00::/8 multicast */
  if (/^ff[0-9a-f]{2}:/.test(lower)) return true;
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
