/**
 * 安全头插件 — OWASP API top 10 baseline.
 *
 * Plan: poc-to-enterprise-ga-2026-v7.3.md §3.8 P1-T-edge
 *
 * Why every header here:
 *   - strict-transport-security: forces HTTPS for 1 year incl. subdomains
 *   - referrer-policy: 'no-referrer' — don't leak the API URL or query
 *     to outbound links the client renders
 *   - x-content-type-options: 'nosniff' — block MIME sniffing
 *   - x-frame-options: 'DENY' — clickjacking defence (deprecated in
 *     favour of CSP frame-ancestors, but still respected by older clients)
 *   - x-permitted-cross-domain-policies: 'none' — Adobe Reader / Flash
 *     cross-domain policy file lock-down
 *   - cross-origin-opener-policy: 'same-origin' — isolate browser
 *     contexts from window.opener
 *   - cross-origin-resource-policy: 'same-origin' — block cross-origin
 *     reads of our API responses
 *
 * CSP is deferred:
 *   The API returns JSON; CSP applies primarily to HTML responses. Our
 *   docs route (Swagger UI) is the only HTML we serve and it needs
 *   inline script for the swagger UI bundle; tightening that requires
 *   nonce plumbing — left for P1-T-edge-ext.
 */

import type { FastifyInstance } from 'fastify';
import helmet from '@fastify/helmet';

export async function registerHelmet(app: FastifyInstance): Promise<void> {
  await app.register(helmet, {
    /* JSON API surface — CSP would be cosmetic. Enable in P1-T-edge-ext
     * with nonce-based inline-script handling for /docs route. */
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
    /* Force HTTPS for 1 year incl. subdomains; preload-eligible. */
    strictTransportSecurity: {
      maxAge: 31_536_000,
      includeSubDomains: true,
      preload: true,
    },
    referrerPolicy: { policy: 'no-referrer' },
    /* Default helmet already sets these but we declare them explicitly
     * to make the audit trail self-evident — auditors don't have to
     * know the helmet defaults. */
    xContentTypeOptions: true,
    xFrameOptions: { action: 'deny' },
    crossOriginOpenerPolicy: { policy: 'same-origin' },
    crossOriginResourcePolicy: { policy: 'same-origin' },
    /* Adobe Flash / PDF cross-domain policy file lock-down. */
    xPermittedCrossDomainPolicies: { permittedPolicies: 'none' },
  });
}
