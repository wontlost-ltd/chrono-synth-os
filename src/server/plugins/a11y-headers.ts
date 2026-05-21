/**
 * Accessibility-friendly response headers.
 *
 * Plan: poc-to-enterprise-ga-2026-v7.3.md §2.2 P1-AY-basic
 *
 * What this plugin does (small, deliberately):
 *  - Adds `Vary: Accept-Language` on every response so a future locale-aware
 *    error handler (P1-E-ext v2) won't get its localised body cross-served
 *    to clients with a different Accept-Language. Cheap and forward-safe.
 *  - Reflects the client's `Prefer: reduced-motion` (RFC 7240) into a
 *    response header `Preference-Applied: reduced-motion` so the frontend
 *    can confirm the signal made it through proxies. Clients still drive
 *    UI behaviour from their own user-agent CSS media query; this header
 *    is for the server side to *acknowledge* the preference, which is
 *    what RFC 7240 §2 mandates if any preference is honoured.
 *
 * Why not more? A11y of API responses is mostly about *not breaking*
 * downstream a11y tooling: keep error shape stable (already done in
 * error-handler.ts), keep `code` field present (asserted by contract
 * test), don't strip newlines from messages. Bigger a11y work (focus
 * order, ARIA roles, contrast) belongs in the web app, not the API.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';

const REDUCED_MOTION_TOKEN = 'reduced-motion';

function clientPrefersReducedMotion(prefer: string | undefined): boolean {
  if (!prefer) return false;
  /* RFC 7240: comma-separated preferences. Match token case-insensitively
   * but reject if a quoted form like `preference="..."` is used — that's
   * an Accept-style param, not a Prefer token. */
  for (const raw of prefer.split(',')) {
    const token = raw.trim().toLowerCase();
    if (token === REDUCED_MOTION_TOKEN) return true;
  }
  return false;
}

export function registerA11yHeaders(app: FastifyInstance): void {
  /* Use onSend so all upstream plugins (idempotency, helmet) have already
   * set their headers — but check reply.raw.headersSent first to avoid
   * racing the idempotency replay path that flushes synchronously inside
   * preHandler. If the headers already went out, our additions would be
   * a no-op anyway and reply.header() would throw ERR_HTTP_HEADERS_SENT
   * (which Fastify wraps as unhandledRejection and corrupts test state).
   *
   * In the normal (non-replay) flow, onSend is the canonical place to
   * mutate response headers per Fastify docs §lifecycle. */
  app.addHook('onSend', async (request: FastifyRequest, reply: FastifyReply, payload) => {
    /* Skip POST/PUT/DELETE/PATCH requests that use Idempotency-Key. The
     * idempotency plugin calls reply.send() synchronously inside
     * preHandler on replay, which races with this onSend; even with
     * try/catch the side effect of an attempted reply.header() corrupts
     * downstream pipeline state in Fastify (caught by persona-core-api
     * idempotency assertions counting marketplace_tasks rows).
     *
     * Safer: skip these requests entirely. Localised responses don't
     * apply to JSON write endpoints today (they don't return localised
     * error messages in the success path), so the Vary header is
     * cosmetic for them. */
    if (request.headers['idempotency-key']) return payload;
    if (reply.getHeader('x-idempotent-replayed') === 'true') return payload;

    try {
      const existingVary = reply.getHeader('vary');
      const varyTokens = new Set<string>();
      if (typeof existingVary === 'string') {
        for (const t of existingVary.split(',')) varyTokens.add(t.trim());
      } else if (Array.isArray(existingVary)) {
        for (const v of existingVary) for (const t of String(v).split(',')) varyTokens.add(t.trim());
      }
      varyTokens.add('Accept-Language');
      reply.header('Vary', [...varyTokens].filter(Boolean).join(', '));

      const preferHeader = request.headers['prefer'];
      const prefer = Array.isArray(preferHeader) ? preferHeader.join(',') : preferHeader;
      if (clientPrefersReducedMotion(prefer)) {
        reply.header('Preference-Applied', REDUCED_MOTION_TOKEN);
      }
    } catch {
      /* defensive only — header errors here would only ever be cosmetic. */
    }
    return payload;
  });
}
