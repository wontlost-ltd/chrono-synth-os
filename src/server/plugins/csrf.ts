/**
 * CSRF protection for cookie-authenticated state-changing requests.
 *
 * Plan: poc-to-enterprise-ga-2026-v7.3.md §3.9 P1-Y-api-baseline
 *
 * Threat model + design:
 *
 *   Bearer-token APIs are *not* CSRF-vulnerable: the attacker can't make
 *   the browser attach a custom Authorization header on a cross-origin
 *   forged request. The vulnerable surface is the **refresh-token
 *   cookie** path — /api/v1/auth/refresh and /api/v1/auth/logout —
 *   where the browser auto-attaches the HttpOnly cookie.
 *
 *   SameSite=Lax (default) blocks most cross-site POSTs but NOT
 *   third-party iframe submissions or same-site sub-domain attacks. We
 *   layer in a **double-submit token**: server sets a non-HttpOnly
 *   cookie containing a random value AND a CSRF-Token header must
 *   match. An attacker cross-origin can't read the cookie (Same-Origin
 *   Policy), so they can't echo the right header.
 *
 *   GET / HEAD / OPTIONS are exempt (no state change). Any other
 *   method on a configured-protected path with a cookie attached must
 *   carry a matching X-CSRF-Token header.
 *
 * What this plugin does NOT do:
 *   - Doesn't issue the cookie. The auth/login flow sets `csrf_token=<rand>`
 *     non-HttpOnly cookie as a side effect; this plugin only validates.
 *   - Doesn't apply to API-key / Bearer-token traffic — they're not
 *     CSRF-vulnerable. Caller-friendly: the plugin lets requests through
 *     when no refresh-token cookie is present.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';

export interface CsrfOptions {
  /** Cookie name carrying the user-visible CSRF token (NOT HttpOnly). */
  cookieName: string;
  /** Header name the client must echo the cookie value into. */
  headerName: string;
  /** Cookie name of the refresh-token (HttpOnly); presence implies cookie-auth. */
  triggerCookieName: string;
  /** Paths that require CSRF validation (substring match). Empty = all. */
  protectedPathPrefixes: readonly string[];
  /** Methods exempted regardless. */
  safeMethods: readonly string[];
}

export const DEFAULT_CSRF_OPTIONS: CsrfOptions = {
  cookieName: 'csrf_token',
  headerName: 'x-csrf-token',
  triggerCookieName: 'refresh_token',
  protectedPathPrefixes: ['/api/v1/auth/refresh', '/api/v1/auth/logout'],
  safeMethods: ['GET', 'HEAD', 'OPTIONS'],
};

function parseCookies(header: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key) out.set(key, value);
  }
  return out;
}

function isProtectedPath(url: string, prefixes: readonly string[]): boolean {
  if (prefixes.length === 0) return true;
  /* url may include query string; compare path part only */
  const path = url.split('?', 1)[0] ?? url;
  return prefixes.some(p => path.startsWith(p));
}

export function registerCsrf(app: FastifyInstance, opts: CsrfOptions = DEFAULT_CSRF_OPTIONS): void {
  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    if (opts.safeMethods.includes(request.method)) return;
    if (!isProtectedPath(request.url, opts.protectedPathPrefixes)) return;

    const cookies = parseCookies(request.headers.cookie);
    /* No refresh cookie => caller is Bearer/API-key; not CSRF-vulnerable. */
    if (!cookies.has(opts.triggerCookieName)) return;

    const cookieToken = cookies.get(opts.cookieName);
    const headerValue = request.headers[opts.headerName];
    const headerToken = Array.isArray(headerValue) ? headerValue[0] : headerValue;

    if (!cookieToken || !headerToken || cookieToken !== headerToken) {
      return reply.status(403).send({
        error: 'CsrfError',
        code: 'CSRF_TOKEN_MISMATCH',
        message: 'Cookie-authenticated state-changing request missing or has mismatched CSRF token',
      });
    }
  });
}
