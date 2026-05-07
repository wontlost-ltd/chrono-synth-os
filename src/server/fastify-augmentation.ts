/**
 * Module augmentation for Fastify request.
 *
 * Plugins decorate the request with structured fields (jwt user, timing).
 * Declaring them once means callers don't need
 * `(request as unknown as {...}).user` casts — TypeScript resolves the
 * augmented properties through the normal type system.
 *
 * `FastifyInstance.redis` and `FastifyInstance.jwtEnabled` are declared in
 * their respective plugin files (plugins/redis.ts, plugins/jwt-auth.ts);
 * we don't redeclare them here.
 *
 * This file is type-only; it has no runtime side effects.
 */

import 'fastify';
import type { JwtPayload } from '../types/auth.js';

declare module 'fastify' {
  interface FastifyRequest {
    /* @fastify/jwt declares `user` as a required property (no `?`); we
     * narrow it here from `unknown` to JwtPayload. Routes that run on
     * unauthenticated paths still need to null-check via optional
     * chaining (request.user?.sub) since the request decorator is set
     * conditionally by the auth plugin. */
    user: JwtPayload;

    /* Audit-log helper sets this from the resolved user record. */
    userEmail?: string | null;

    /* Internal request timing, set by audit-log + metrics + request-timeout
     * plugins. Number = performance.now() snapshot. */
    __startTime?: number;
    __timeoutTimer?: ReturnType<typeof setTimeout>;
  }
}
