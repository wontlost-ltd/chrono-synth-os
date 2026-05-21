/**
 * JWT 认证插件
 * 对 /api/* 路由验证 Bearer 令牌，解码后注入 request.user
 * 与 API Key 认证共存：优先检查 Bearer token，无 token 时回退到 API Key
 *
 * 支持对称（HS256/384/512）与非对称（RS256/ES256）算法。非对称模式启用
 * JWKS endpoint + key rollover；详 P0-D 验收 .claude/runbooks/p0-d-jwks-acceptance.md
 */

import { createHash, createPublicKey } from 'node:crypto';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import type { AppConfig } from '../../config/schema.js';
import type { JwtPayload } from '../../types/auth.js';
import {
  KeyRing,
  buildSignKeyObject,
  type JwtKeyEntry,
} from './jwt-keyring.js';
import { createJtiDenyList, type JtiDenyList } from './jwt-deny-list.js';
import { JwtRotateBodySchema, JwtDenyJtiBodySchema } from '../schemas/api-schemas.js';

/** Wrap `createPublicKey` so the JWKS handler has a single, mockable entry. */
function createPublicKeyObject(pem: string): ReturnType<typeof createPublicKey> {
  return createPublicKey({ key: pem, format: 'pem' });
}

/** 扩展 @fastify/jwt 类型以使用自定义载荷 */
declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: JwtPayload;
    user: JwtPayload;
  }
}

/** 不需要认证的路径前缀（仅健康检查端点豁免，指标端点需认证）
 *  /.well-known/jwks.json — 应用自身签发的 JWT 验证密钥 (P0-D #2)。 */
const PUBLIC_PATHS = new Set([
  '/healthz',
  '/readyz',
  '/api/v1/mcp/capabilities',
  '/.well-known/jwks.json',
]);

/** 认证路由自身豁免（注册/登录无需 token） */
const AUTH_PATHS = new Set([
  '/api/v1/auth/login',
  '/api/v1/auth/register',
  '/api/v1/auth/refresh',
  '/api/v1/auth/logout',
  '/api/v1/auth/sso/authorize',
  '/api/v1/auth/sso/callback',
  '/api/v1/auth/oidc/login',
  '/api/v1/auth/oidc/callback',
  '/api/v1/billing/plans',
]);

function isPublicPath(url: string): boolean {
  const path = url.split('?')[0];
  if (PUBLIC_PATHS.has(path)) return true;
  if (AUTH_PATHS.has(path)) return true;
  if (path.startsWith('/scim/')) return true;
  /* Stripe webhook 豁免（由 Stripe 签名验证保护） */
  if (path === '/api/v1/billing/webhook') return true;
  /* Google OAuth 回调（由 state 签名保护） */
  if (path === '/api/v1/agent/oauth/google/callback') return true;
  return false;
}

declare module 'fastify' {
  interface FastifyInstance {
    jwtEnabled: boolean;
    /** Active JWT `kid` (key identifier) — undefined when jwt.enabled=false. */
    jwtKid?: string;
    /** Live KeyRing instance — undefined when jwt.enabled=false. */
    jwtKeyRing?: KeyRing;
    /** In-memory JTI deny-list — undefined when jwt.enabled=false. */
    jwtDenyList?: JtiDenyList;
  }
}

/** Derive a stable kid from a public key (canonical SPKI DER) or HS metadata.
 *  Treats whitespace-only `config.jwt.kid` as blank so accidental " " never
 *  ends up in JWT headers or JWKS. */
function resolveKid(config: AppConfig): string {
  const trimmed = config.jwt.kid.trim();
  if (trimmed) return trimmed;
  /* For asymmetric mode, hash the **canonical SPKI DER** (whitespace-agnostic,
   * format-agnostic — same logical key always yields the same kid).
   * For symmetric mode, hash the issuer + secret length so it doesn't leak
   * the secret while still being stable for log correlation. */
  const isAsymmetric = config.jwt.algorithm.startsWith('RS') || config.jwt.algorithm.startsWith('ES');
  if (isAsymmetric && config.jwt.publicKey) {
    try {
      const der = createPublicKeyObject(config.jwt.publicKey).export({ type: 'spki', format: 'der' });
      return createHash('sha256').update(der as Buffer).digest('hex').slice(0, 16);
    } catch {
      /* Fallback to PEM-text hash if DER export fails; still deterministic. */
      return createHash('sha256').update(config.jwt.publicKey).digest('hex').slice(0, 16);
    }
  }
  const seed = `${config.jwt.issuer}-${config.jwt.secret.length}`;
  return createHash('sha256').update(seed).digest('hex').slice(0, 16);
}

export async function registerJwtAuth(app: FastifyInstance, config: AppConfig): Promise<void> {
  app.decorate('jwtEnabled', config.jwt.enabled);
  if (!config.jwt.enabled) return;

  const multiKid = config.jwt.keys.length > 0;
  const isAsymmetric = config.jwt.algorithm.startsWith('RS') || config.jwt.algorithm.startsWith('ES');

  /* Build (or synthesise from legacy single-key) the KeyRing. */
  let keyRing: KeyRing;
  let activeKid: string;
  /* Boot-time active kid — fastify-jwt's `secret` is captured at register()
   * time and cannot be changed without restart. Rotate that would change the
   * *signing-effective* active key must be refused (409 RESTART_REQUIRED);
   * otherwise JWKS would advertise a key the server cannot actually sign with,
   * causing every newly issued token to fail verification at the client. See
   * the rotate endpoint below for the gate. */
  if (multiKid) {
    keyRing = new KeyRing(config.jwt.keys as JwtKeyEntry[]);
    activeKid = keyRing.activeKid();
  } else {
    /* Legacy single-key path: synthesise a single-entry KeyRing so the
     * downstream code paths are uniform. */
    const synthKid = resolveKid(config);
    const entry: JwtKeyEntry = {
      kid: synthKid,
      state: 'active',
      algorithm: config.jwt.algorithm,
      privateKey: config.jwt.privateKey,
      publicKey: config.jwt.publicKey,
      secret: isAsymmetric ? '' : config.jwt.secret,
    };
    keyRing = new KeyRing([entry]);
    activeKid = synthKid;
  }
  const bootActiveKid = activeKid;

  /* Sign-side key: always the currently active key.
   *
   * Why not a secret-callback for multi-kid verify?
   *   fastify-jwt's `secret` callback would let us route verify-time keys
   *   by `kid`, BUT the existing `app.jwt.sign(payload)` synchronous API
   *   in auth-service.ts requires a synchronously-resolvable secret. With a
   *   callback, sign returns a Promise — silently breaking every call site.
   *   Refactoring all sign call sites is out of P0-D #1 scope; deferred to
   *   P1-M (DB-backed key store with a proper sign/verify abstraction).
   *
   * Pragmatic intermediate state (this commit):
   *   - KeyRing tracks lifecycle in-memory; rotate endpoint updates it.
   *   - JWKS endpoint publishes active+grace keys → external verifiers can
   *     validate tokens signed under EITHER kid (forward-compatible).
   *   - This process signs with the single active key, baked into the
   *     fastify-jwt static secret. Rotating sign-time requires an app
   *     restart (acceptable for incident-response drill). */
  const activeSignEntry = keyRing.signEntry();
  const activeIsAsym = activeSignEntry.algorithm.startsWith('RS') || activeSignEntry.algorithm.startsWith('ES');
  const legacySecret = activeIsAsym
    ? { private: activeSignEntry.privateKey, public: activeSignEntry.publicKey }
    : (multiKid ? activeSignEntry.secret : config.jwt.secret);
  /* `isAsymmetric` and `buildSignKeyObject` are still referenced below for
   * JWKS shape decisions; satisfy the no-unused-vars lint. */
  void isAsymmetric;
  void buildSignKeyObject;

  /* JTI deny-list — explicit token-level revocation (logout, incident response). */
  const denyList = createJtiDenyList();

  await app.register(fastifyJwt, {
    secret: legacySecret,
    sign: {
      iss: config.jwt.issuer,
      expiresIn: Math.floor(config.jwt.accessTtlMs / 1000),
      algorithm: keyRing.signEntry().algorithm,
      /* Embed kid in JWT header so multi-kid verifiers (own JWKS, customer
       * IDP) can pick the right key. Default sign options forward to
       * jsonwebtoken's `header` param. */
      header: { alg: keyRing.signEntry().algorithm, typ: 'JWT', kid: activeKid },
      /* fast-jwt's `jti` sign option requires a STATIC string, so we can't
       * use it for per-call uniqueness. Instead, callers that need
       * revocable tokens add a `jti` claim to the payload themselves (e.g.
       * auth-service.ts pre-pends `randomUUID()` for access tokens).
       *
       * Deny-list check in onRequest is gated on `jti` being present —
       * existing legacy callers stay compatible; new code can opt in by
       * adding `jti` and POSTing to /api/v1/auth/keys/deny-jti on logout. */
    },
    verify: {
      allowedIss: config.jwt.issuer,
      /* Accept all algorithms actually used by published (active+grace) keys.
       * Without this, fast-jwt rejects valid grace-key tokens during rollover
       * across algorithm families (e.g. RS256→ES256 migration). */
      algorithms: Array.from(new Set(keyRing.publishedEntries().map(e => e.algorithm))),
    },
  });

  /* Expose state for route handlers and tests. */
  app.decorate('jwtKid', activeKid);
  app.decorate('jwtKeyRing', keyRing);
  app.decorate('jwtDenyList', denyList);

  /* /.well-known/jwks.json — RFC 7517 JWKS endpoint.
   *
   * Asymmetric (RS256/ES256): returns the public key in JWK form (kty/n/e or
   *   kty/crv/x/y). Clients can cache + verify offline.
   * Symmetric (HS256/...): returns minimal metadata (kty=oct + kid + alg) so
   *   clients can detect the active kid for log correlation. The shared secret
   *   itself is NEVER published. Real key distribution still requires an
   *   out-of-band exchange.
   *
   * Cache-Control: short max-age aligns with v7.3 P0-D requirement
   * ("JWKS cache TTL ≤ 5min"). Clients should honour it; this is the
   * upper bound for key-rollover propagation. */
  app.get('/.well-known/jwks.json', async (_req, reply) => {
    reply.header('cache-control', 'public, max-age=300');
    /* Publish active + grace keys. Retired and compromised are NOT in JWKS;
     * verifyEntry() also returns undefined for them, so clients have no way
     * to validate tokens signed with those kids — that IS the revocation. */
    const published = keyRing.publishedEntries();
    const keys: Record<string, unknown>[] = [];
    for (const entry of published) {
      const isAsym = entry.algorithm.startsWith('RS') || entry.algorithm.startsWith('ES');
      if (isAsym && entry.publicKey) {
        try {
          const publicKey = createPublicKeyObject(entry.publicKey);
          const jwk = publicKey.export({ format: 'jwk' }) as Record<string, unknown>;
          keys.push({ ...jwk, kid: entry.kid, alg: entry.algorithm, use: 'sig' });
        } catch (err) {
          app.log.error({ err, kid: entry.kid }, 'JWKS public key derivation failed');
          /* Continue: skip the broken key rather than fail the whole endpoint. */
        }
      } else {
        /* Symmetric (HS*): metadata only — never emit `k` (the shared secret). */
        keys.push({
          kty: 'oct',
          kid: entry.kid,
          alg: entry.algorithm,
          use: 'sig',
        });
      }
    }
    return { keys };
  });

  /* POST /api/v1/auth/keys/rotate — emergency rotate endpoint (P0-D #1).
   *
   * Requires admin role today; P1-M will swap that for a break-glass token
   * with explicit expiry + approval audit. Until then, an admin's leaked
   * credentials are the same threat surface as the new active key itself.
   *
   * Body shape:
   *   {
   *     newActiveKid: string,
   *     oldActiveNewState?: 'grace' | 'retired' | 'compromised',
   *     addNew?: JwtKeyEntry[]   // new entries to insert; newActiveKid may
   *                              // refer to one of these
   *   }
   *
   * In-memory only — see acceptance doc for why DB persistence is P1-M scope. */
  app.post('/api/v1/auth/keys/rotate', {
    preHandler: async (request, reply) => {
      const user = (request as FastifyRequest & { user?: { role?: string } }).user;
      const role = user?.role;
      if (role !== 'admin') {
        return reply.status(403).send({
          error: 'AuthorizationError',
          code: 'AUTH_INSUFFICIENT_ROLE',
          message: 'POST /api/v1/auth/keys/rotate requires admin role (P1-M will replace with break-glass)',
        });
      }
    },
  }, async (request, reply) => {
    const parseResult = JwtRotateBodySchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.status(400).send({
        error: 'ValidationError',
        message: 'invalid rotate body',
        issues: parseResult.error.issues,
      });
    }
    const body = parseResult.data;
    /* Gate: refuse rotations that would change the signing-effective active
     * kid. fastify-jwt captured its signing key at register() time; we can
     * only change the *advertised* (JWKS) active kid and the *verify-side*
     * KeyRing state in-process. If a rotate moved active away from
     * bootActiveKid, JWKS clients would converge on the new key, but
     * newly-issued tokens would still be signed with the boot key → every
     * client rejects every fresh token. This is exactly the failure mode
     * the dual reviewers flagged as Critical. Force operator to do
     * config update + restart instead. */
    if (body.newActiveKid !== bootActiveKid) {
      return reply.status(409).send({
        error: 'RotateError',
        code: 'AUTH_ROTATE_RESTART_REQUIRED',
        message: 'Rotating to a different active key requires updating jwt.keys config and restarting the process. The in-process rotate endpoint can only mark existing keys grace/retired/compromised — not change signing.',
        bootActiveKid,
        requestedNewActiveKid: body.newActiveKid,
      });
    }
    try {
      keyRing.rotate({
        newActiveKid: body.newActiveKid,
        oldActiveNewState: body.oldActiveNewState,
        addNew: body.addNew as JwtKeyEntry[] | undefined,
      });
    } catch (err) {
      return reply.status(400).send({
        error: 'RotateError',
        message: (err as Error).message,
      });
    }
    /* IMPORTANT: refresh the cached `activeKid` decorator so subsequent
     * introspection (logs, tests) reflects the rotation. */
    (app as unknown as { jwtKid: string }).jwtKid = keyRing.activeKid();
    /* snapshot() returns JwtKeyView only — privateKey/publicKey/secret never
     * leave KeyRing; safe to log + return to admin. */
    const snapshot = keyRing.snapshot();
    request.log.info({ newActive: keyRing.activeKid(), snapshot }, 'JWT KeyRing rotated');
    return { ok: true, activeKid: keyRing.activeKid(), snapshot };
  });

  /* POST /api/v1/auth/keys/deny-jti — explicit revocation of a single token.
   * Used by logout flow and incident response. Admin-only (P1-M will scope
   * down to break-glass for non-self revocation).
   *
   * Body: { jti: string, expiresAtMs: number }
   *   - expiresAtMs: timestamp when this entry can be evicted (typically
   *     the access token's exp; deny-list LRU evicts after this). */
  app.post('/api/v1/auth/keys/deny-jti', {
    preHandler: async (request, reply) => {
      const user = (request as FastifyRequest & { user?: { role?: string } }).user;
      if (user?.role !== 'admin') {
        return reply.status(403).send({
          error: 'AuthorizationError',
          code: 'AUTH_INSUFFICIENT_ROLE',
          message: 'requires admin role',
        });
      }
    },
  }, async (request, reply) => {
    const parseResult = JwtDenyJtiBodySchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.status(400).send({
        error: 'ValidationError',
        message: 'invalid deny-jti body',
        issues: parseResult.error.issues,
      });
    }
    denyList.deny(parseResult.data.jti, parseResult.data.expiresAtMs);
    return { ok: true, denyListSize: denyList.size() };
  });

  /* GET /api/v1/auth/keys — diagnostic; admin only. */
  app.get('/api/v1/auth/keys', {
    preHandler: async (request, reply) => {
      const user = (request as FastifyRequest & { user?: { role?: string } }).user;
      if (user?.role !== 'admin') {
        return reply.status(403).send({
          error: 'AuthorizationError',
          code: 'AUTH_INSUFFICIENT_ROLE',
          message: 'GET /api/v1/auth/keys requires admin role',
        });
      }
    },
  }, async () => {
    /* snapshot() returns JwtKeyView only — privateKey/publicKey/secret never
     * leave KeyRing. The type system enforces redaction; no manual stripping. */
    return keyRing.snapshot();
  });

  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    if (isPublicPath(request.url) || request.method === 'OPTIONS') return;

    /* 允许上游认证插件（如 metrics scrape key）提前完成认证 */
    if (request.user) return;

    const authHeader = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      /* 无 Bearer token — 回退到 API Key 认证（由 auth.ts 插件处理） */
      /* 若 API Key 认证也未启用，则需要 JWT，拒绝无认证请求 */
      if (!config.auth.enabled) {
        return reply.status(401).send({
          error: 'AuthenticationError',
          code: 'AUTH_REQUIRED',
          message: '需要 Bearer 令牌',
        });
      }
      return;
    }

    /* P0-D #1: enforce KeyRing state on inbound tokens.
     *
     * fastify-jwt's static-key verifier doesn't know about retired/compromised
     * lifecycle. We decode the JWT header (no signature check) to extract the
     * `kid`, then reject if KeyRing.verifyEntry() refuses it (retired/
     * compromised/unknown). Only after that do we let jwtVerify do the
     * cryptographic check against the static boot key.
     *
     * This is a defence-in-depth layer: even if rotation hasn't restarted the
     * process (P0-D #1 limitation 1), tokens signed under a kid that is
     * since-retired-or-compromised are rejected. */
    const bearer = authHeader.slice('Bearer '.length).trim();
    const dotPositions: number[] = [];
    for (let i = 0; i < bearer.length; i++) {
      if (bearer[i] === '.') dotPositions.push(i);
    }
    if (dotPositions.length !== 2) {
      return reply.status(401).send({
        error: 'AuthenticationError',
        code: 'AUTH_INVALID_TOKEN',
        message: '令牌格式无效',
      });
    }
    let incomingKid: string | undefined;
    try {
      const headerB64 = bearer.slice(0, dotPositions[0]!);
      const headerJson = Buffer.from(headerB64, 'base64url').toString('utf-8');
      const headerObj = JSON.parse(headerJson) as { kid?: unknown };
      if (typeof headerObj.kid === 'string') incomingKid = headerObj.kid;
    } catch {
      /* Malformed header — let jwtVerify produce the canonical 401. */
    }
    /* If the token declares a kid, the KeyRing must accept it.
     * Legacy tokens (no kid) bypass this check and rely on jwtVerify alone —
     * acceptable while the legacy boot key is the only active key. */
    if (incomingKid !== undefined) {
      const entry = keyRing.verifyEntry(incomingKid);
      if (!entry) {
        return reply.status(401).send({
          error: 'AuthenticationError',
          code: 'AUTH_KID_REVOKED',
          message: `令牌 kid 不在 active/grace KeyRing 中（被吊销或不识别）`,
        });
      }
    }

    try {
      await request.jwtVerify();
    } catch {
      return reply.status(401).send({
        error: 'AuthenticationError',
        code: 'AUTH_INVALID_TOKEN',
        message: '令牌无效或已过期',
      });
    }

    /* JTI deny-list check — must run AFTER jwtVerify populates request.user. */
    const user = (request as FastifyRequest & { user?: { jti?: string } }).user;
    const jti = user?.jti;
    if (jti && denyList.isDenied(jti)) {
      return reply.status(401).send({
        error: 'AuthenticationError',
        code: 'AUTH_TOKEN_REVOKED',
        message: '令牌已被吊销',
      });
    }
  });
}
