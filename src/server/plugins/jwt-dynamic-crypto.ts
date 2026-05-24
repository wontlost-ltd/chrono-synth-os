/**
 * 动态签名 / 验证封装 — KeyRing 热轮换支持（GA §8 #1 Critical 修复）
 *
 * fastify-jwt 的 signer 在 register() 时捕获 `secret`，无法热换。
 * 这里在 fast-jwt 的 createSigner / createVerifier 之上加一层"按 kid 取
 * 当前 KeyRing 视图"的解析，每次签发都从 `keyRing.signEntry()` 现取，
 * 验证按 token header.kid 现取。从而把"重启才能换签发密钥"的硬限制
 * 拆除，让 /api/v1/auth/keys/rotate 真正实现进程内热轮换。
 *
 * 设计要点：
 *   1) 仍是同步 API：`sign(payload) -> string` / `verify(token) -> payload`，
 *      不破坏 auth-service.ts 既有的 `app.jwt.sign(payload)` 调用形态。
 *   2) 每个 kid 的 fast-jwt signer/verifier 缓存一次后复用，避免每次签发
 *      都解析 PEM 的 CPU 开销。缓存对每个 KeyRing 实例独立，不跨进程。
 *   3) Header 自动注入 kid，让外部 JWKS 验证方按 kid 选 key。
 *   4) Verify 路径未提供 kid 的 legacy token 走 "boot 密钥" 兜底，与
 *      jwt-auth.ts onRequest 钩子里现有的策略一致。
 */

import { createSigner, createVerifier } from 'fast-jwt';
import type { KeyRing, JwtKeyEntry } from './jwt-keyring.js';
import { buildSignKeyObject } from './jwt-keyring.js';

/**
 * 取出 verify 用的 key 字符串。
 * fast-jwt 的 createVerifier 仅接受 PEM 字符串 / Buffer / 共享密钥字符串，
 * 不接受 Node KeyObject —— 这里直接喂 PEM/secret，匹配 fast-jwt 的算法
 * 自动探测。
 */
function buildVerifyKeyString(entry: JwtKeyEntry): string {
  const isAsym = entry.algorithm.startsWith('RS') || entry.algorithm.startsWith('ES');
  if (isAsym) {
    if (!entry.publicKey) {
      throw new Error(`KeyRing.buildVerifyKeyString: kid "${entry.kid}" has no publicKey`);
    }
    return entry.publicKey;
  }
  return entry.secret;
}

/** fast-jwt 暴露的同步 signer/verifier 类型只是返回函数，这里收紧最小契约。 */
type SyncSign = (payload: unknown) => string;
type SyncVerify<T> = (token: string) => T;

export interface DynamicSignerOptions {
  /** Issuer claim（与现有 jwt.iss 一致）。 */
  issuer: string;
  /** access token TTL（秒）。 */
  expiresInSeconds: number;
}

export interface DynamicVerifierOptions {
  /** Issuer 白名单。 */
  allowedIssuer: string;
  /**
   * 兼容已有 fastify-jwt 静态 verifier：当 token header 不带 kid 时
   * 用 bootEntry 验证。GA 之前签发的 legacy token 全部无 kid，必须保留此兜底。
   */
  bootEntry: JwtKeyEntry;
}

/**
 * 构造一个永远基于 keyRing 当前 signEntry() 选键的同步签名器。
 *
 * 缓存：以 kid+algorithm 为主键缓存 fast-jwt signer。轮换后命中新 kid
 * 会自动建一项新缓存，旧 kid 的缓存留作历史（无害，下次 GC 周期清理）。
 */
export function createDynamicSigner(
  keyRing: KeyRing,
  opts: DynamicSignerOptions,
): SyncSign {
  const cache = new Map<string, SyncSign>();

  function cacheKey(entry: JwtKeyEntry): string {
    return `${entry.kid}::${entry.algorithm}`;
  }

  function makeSigner(entry: JwtKeyEntry): SyncSign {
    /* fast-jwt 接受 PEM 字符串作为 key；同步 signer 不传 KeyFetcher。 */
    const key = buildSignKeyObject(entry);
    const signer = createSigner({
      key,
      algorithm: entry.algorithm,
      iss: opts.issuer,
      expiresIn: opts.expiresInSeconds * 1000,
      /* 把 kid 注入 JWT header 让验证方按 kid 路由。 */
      header: { alg: entry.algorithm, typ: 'JWT', kid: entry.kid },
    });
    return signer as unknown as SyncSign;
  }

  return (payload: unknown): string => {
    const entry = keyRing.signEntry();
    const key = cacheKey(entry);
    let signer = cache.get(key);
    if (!signer) {
      signer = makeSigner(entry);
      cache.set(key, signer);
    }
    return signer(payload);
  };
}

/**
 * 解析 JWT header（无签名校验），提取 kid。失败返回 undefined。
 * 必须 zero-throw，否则 verify 主路径会被恶意 token 干扰。
 */
function peekKid(token: string): string | undefined {
  const firstDot = token.indexOf('.');
  if (firstDot <= 0) return undefined;
  try {
    const headerB64 = token.slice(0, firstDot);
    const headerJson = Buffer.from(headerB64, 'base64url').toString('utf-8');
    const header = JSON.parse(headerJson) as { kid?: unknown };
    if (typeof header.kid === 'string') return header.kid;
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * 构造一个按 token header.kid 选验证密钥的同步验证器。
 *
 * 路径：
 *   - kid 命中 keyRing.verifyEntry(kid) → 用该 entry 验签。
 *   - kid 缺失（legacy token） → 用 bootEntry 验签。
 *   - kid 不在 KeyRing（retired / compromised / unknown） → 抛错。
 */
export function createDynamicVerifier<T = unknown>(
  keyRing: KeyRing,
  opts: DynamicVerifierOptions,
): SyncVerify<T> {
  const cache = new Map<string, SyncVerify<T>>();

  function cacheKey(entry: JwtKeyEntry): string {
    return `${entry.kid}::${entry.algorithm}`;
  }

  function makeVerifier(entry: JwtKeyEntry): SyncVerify<T> {
    const key = buildVerifyKeyString(entry);
    const verifier = createVerifier({
      key,
      algorithms: [entry.algorithm],
      allowedIss: opts.allowedIssuer,
    });
    return verifier as unknown as SyncVerify<T>;
  }

  function pickEntry(token: string): JwtKeyEntry {
    const kid = peekKid(token);
    if (kid === undefined) return opts.bootEntry;
    const entry = keyRing.verifyEntry(kid);
    if (!entry) {
      const err = new Error(`unknown or revoked kid "${kid}"`) as Error & { code?: string };
      err.code = 'AUTH_KID_REVOKED';
      throw err;
    }
    return entry;
  }

  return (token: string): T => {
    const entry = pickEntry(token);
    const key = cacheKey(entry);
    let verifier = cache.get(key);
    if (!verifier) {
      verifier = makeVerifier(entry);
      cache.set(key, verifier);
    }
    return verifier(token);
  };
}
