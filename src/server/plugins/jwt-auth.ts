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
import { createDynamicSigner, createDynamicVerifier } from './jwt-dynamic-crypto.js';
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
    /**
     * 动态签名器：每次调用从 KeyRing 现取 active key，支持热轮换。
     * 与历史 `app.jwt.sign()` 同步签名形态保持一致，但不被 fastify-jwt
     * register-time 的 secret 锁住。GA §8 #1 Critical 修复入口。
     */
    jwtSign?: (payload: JwtPayload) => string;
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

/**
 * 可选注入：JwtKeyStore 用于把 KeyRing 持久化到 jwt_signing_keys。
 * 若提供：
 *   - boot 时优先尝试从 DB 装载已有 ring；
 *   - 若 DB 为空，按 config 构造 ring 并 persist 回去；
 *   - rotate API 成功后同步 persist，保证多实例最终一致。
 * 不提供时回退到既有的纯内存路径（向后兼容）。
 */
export interface JwtAuthDeps {
  keyStore?: import('./jwt-key-store.js').JwtKeyStore;
  /**
   * 多实例 key-state 同步周期（毫秒）。默认 60s：每个 Pod 每分钟从
   * jwt_signing_keys 拉一次最新快照，把退役/封禁状态在所有节点统一。
   * 设置为 0 关闭轮询（单实例 / 仅启动加载场景）。
   */
  reloadIntervalMs?: number;
}

export async function registerJwtAuth(
  app: FastifyInstance,
  config: AppConfig,
  deps: JwtAuthDeps = {},
): Promise<void> {
  app.decorate('jwtEnabled', config.jwt.enabled);
  if (!config.jwt.enabled) return;

  const multiKid = config.jwt.keys.length > 0;
  const isAsymmetric = config.jwt.algorithm.startsWith('RS') || config.jwt.algorithm.startsWith('ES');

  /* Build (or synthesise from legacy single-key) the KeyRing. */
  let keyRing: KeyRing;
  let activeKid: string;
  /* 1) 优先从 DB 装载持久化的 ring（多实例同步入口）。 */
  if (deps.keyStore) {
    const restored = deps.keyStore.loadKeyRing();
    if (restored) {
      keyRing = restored;
      activeKid = restored.activeKid();
    } else {
      keyRing = null as unknown as KeyRing;
      activeKid = '';
    }
  } else {
    keyRing = null as unknown as KeyRing;
    activeKid = '';
  }
  /* GA §8 #1: 启动时记录 boot 时的 active kid，仅用于诊断与 token
   * verification 的 legacy 兜底（不带 kid 的旧 token 用 bootEntry 验证）。
   * 签发侧不再受 boot key 锁定 —— 使用 createDynamicSigner() 在每次签发
   * 时从 KeyRing 现取 active key，让 /api/v1/auth/keys/rotate 真正实现
   * 进程内热轮换。 */
  /* 2) DB 未提供或为空 → 从 config 构造，并 persist 一次作为种子。 */
  if (!keyRing) {
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
    /* Seed-persist on cold boot, so subsequent reloads are stable across
     * restarts and pods. GA 模式：keyStore 已注入但 persist 失败 → 直接
     * 抛出，让 boot 失败而不是无声地降级为内存模式。这样 K8s 会重启
     * Pod，运维能在日志里看到真正的 JWT 持久化问题。 */
    if (deps.keyStore) {
      try {
        deps.keyStore.persistKeyRing(keyRing);
      } catch (err) {
        app.log.error({ err }, 'jwt-key-store: seed persist failed; refusing to boot in degraded mode');
        throw new Error(`JWT KeyRing seed persistence failed: ${(err as Error).message}`);
      }
    }
  }
  const bootEntry = keyRing.signEntry();
  /* GA §8 #1: 记录 boot 时 active kid，仅用于 ops 可观察性。dynamicSigner
   * 在每次签发时从 keyRing.signEntry() 现取 active key，rotate 之后无需
   * 重启即可切换签发；这条日志让运维在 incident response 时能快速核对
   * 启动状态。 */
  app.log.info({ bootActiveKid: activeKid, algorithm: bootEntry.algorithm }, 'jwt-auth: boot active kid recorded');

  /* Sign-side: dynamic signer drives the GA §8 #1 hot-rotation contract.
   *
   * fastify-jwt 的 `secret` 在 register() 时被捕获，无法热换。为了让
   * /api/v1/auth/keys/rotate 真正在进程内改变签发密钥，我们让
   * app.jwtSign(payload) 走 createDynamicSigner —— 每次签发都从
   * keyRing.signEntry() 现取，配合按 kid LRU 缓存复用 fast-jwt signer。
   *
   * 同时保留 fastify-jwt register，仅用于：
   *   - 兼容 legacy `app.jwt.sign(payload)` 与 `request.jwtVerify()` 仍存在的
   *     测试夹具（生产代码已迁移到 app.jwtSign / dynamicVerify）。
   *   - JWKS 算法白名单计算 (`allowedAlgos`)。
   *
   * legacySecret 仍指向 boot active 仅作 fastify-jwt 字段占位，生产流量
   * 不再依赖它来签发或验证。 */
  const activeIsAsym = bootEntry.algorithm.startsWith('RS') || bootEntry.algorithm.startsWith('ES');
  const symmetricSecret = bootEntry.secret || config.jwt.secret;
  const legacySecret = activeIsAsym
    ? { private: bootEntry.privateKey, public: bootEntry.publicKey }
    : symmetricSecret;
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

  /* GA §8 #1: 注册基于 KeyRing 的动态签名/验证器。
   * - dynamicSign 每次取 keyRing.signEntry()，热轮换后立刻命中新 active key。
   * - dynamicVerify 按 token header.kid 取 keyRing.verifyEntry()，未带 kid 的
   *   legacy token 用 bootEntry 兜底。 */
  const dynamicSign = createDynamicSigner(keyRing, {
    issuer: config.jwt.issuer,
    expiresInSeconds: Math.floor(config.jwt.accessTtlMs / 1000),
  });
  const dynamicVerify = createDynamicVerifier<JwtPayload>(keyRing, {
    allowedIssuer: config.jwt.issuer,
    bootEntry,
  });

  /* Expose state for route handlers and tests. */
  app.decorate('jwtKid', activeKid);
  app.decorate('jwtKeyRing', keyRing);
  app.decorate('jwtDenyList', denyList);
  app.decorate('jwtSign', dynamicSign);

  /* 多实例 key-state 同步：每个 Pod 周期 reload，把其它实例的退役/封禁
   * 状态在 ≤reloadIntervalMs 内推到本 Pod。fastify-jwt 的 sign secret
   * 仍受 bootActiveKid 锁定（不可热换 signer），但 verify 侧的
   * retired/compromised 视图会跟着刷新，立刻拒绝被吊销的 token。 */
  const reloadIntervalMs = deps.reloadIntervalMs ?? 60_000;
  if (deps.keyStore && reloadIntervalMs > 0) {
    const timer = setInterval(() => {
      try {
        const fresh = deps.keyStore?.reloadKeyRing();
        if (!fresh) return;
        const remoteStates = new Map<string, import('./jwt-keyring.js').JwtKeyState>();
        for (const entry of fresh.allEntries()) remoteStates.set(entry.kid, entry.state);
        const changed = keyRing.applyRemoteStates(remoteStates);
        if (changed.length > 0) {
          app.log.info({ kids: changed }, 'jwt-key-store: remote state transitions applied');
        }
      } catch (err) {
        app.log.warn({ err }, 'jwt-key-store: periodic reload failed');
      }
    }, reloadIntervalMs);
    timer.unref?.();
    app.addHook('onClose', async () => clearInterval(timer));
  }

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
          message: 'This operation requires admin role.',
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
    /* GA §8 #1: 取消 AUTH_ROTATE_RESTART_REQUIRED 硬关。
     * createDynamicSigner 让每次签发都从 keyRing.signEntry() 现取，rotate
     * 之后无需重启即可让新签发的 token 用新 active key 签名；JWKS 与
     * verify 路径也同步切换。bootActiveKid 仅留作诊断字段（response
     * 仍带回，便于运维确认轮换前的状态）。 */
    /* Persist-first 旋转：
     *   1) 克隆当前 ring；
     *   2) 在克隆上跑 rotate；
     *   3) 若 keyStore 已配置，先 persist 克隆 → 失败则 503，原 ring 不变；
     *   4) 持久化成功（或无 store）后再把克隆原子换给现役 keyRing。
     * 这样保证：每个 pod 在 200 响应前后，DB 与内存视图一致；任何
     * 持久化失败都阻止响应 200，避免多实例分裂。 */
    const candidate = new KeyRing(keyRing.allEntries());
    try {
      candidate.rotate({
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
    if (deps.keyStore) {
      try {
        /* Merge metadata: load existing rows; for entries whose state
         * differs from the candidate ring, refresh stateChangedAt to now. */
        const prevMeta = deps.keyStore.loadMetadata();
        const nowIso = new Date().toISOString();
        const refreshedMeta = new Map(prevMeta);
        for (const entry of candidate.allEntries()) {
          const prev = prevMeta.get(entry.kid);
          const oldEntry = keyRing.allEntries().find(e => e.kid === entry.kid);
          const stateChanged = !oldEntry || oldEntry.state !== entry.state;
          if (stateChanged) {
            refreshedMeta.set(entry.kid, {
              createdAt: prev?.createdAt ?? nowIso,
              stateChangedAt: nowIso,
              retiredAt: entry.state === 'retired' || entry.state === 'compromised' ? nowIso : null,
            });
          }
        }
        deps.keyStore.persistKeyRing(candidate, { metadata: refreshedMeta });
      } catch (err) {
        request.log.error({ err }, 'jwt-key-store: persist on rotate failed; refusing to apply');
        return reply.status(503).send({
          error: 'RotateError',
          code: 'AUTH_ROTATE_PERSIST_FAILED',
          message: 'Persisting the rotated key ring failed; rotation aborted to avoid pod-level drift. Retry or check the key store.',
        });
      }
    }
    /* Persisted (or no store) → apply same rotate to the live ring.
     * 由于 KeyRing.rotate() 是同事务式的（成功/异常都不留半步状态），
     * candidate 上能成功 rotate 的输入在 live ring 上也能成功；这里
     * 重放可以避免暴露内部字段（不需要 Object.assign 私有属性）。 */
    keyRing.rotate({
      newActiveKid: body.newActiveKid,
      oldActiveNewState: body.oldActiveNewState,
      addNew: body.addNew as JwtKeyEntry[] | undefined,
    });
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

    /* GA §8 #1: 使用 dynamicVerify 按 token header.kid 选验证密钥，
     * 让轮换后用新 active key 签发的 token 在本进程内立即可验证；旧的
     * fastify-jwt 静态验证仅作为 KeyRing 不可用时的 defensive 兜底。 */
    try {
      const payload = dynamicVerify(bearer);
      (request as FastifyRequest & { user?: JwtPayload }).user = payload;
    } catch {
      return reply.status(401).send({
        error: 'AuthenticationError',
        code: 'AUTH_INVALID_TOKEN',
        message: '令牌无效或已过期',
      });
    }

    /* JTI deny-list check — must run AFTER dynamicVerify populates request.user. */
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
