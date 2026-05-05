/**
 * Google API OAuth2 token helper
 *
 * 支持两种模式：
 *  1. service_account：用 RS256 JWT bearer 换 access_token（生产推荐）
 *  2. oauth_access_token：直接使用调用方提供的 access_token（用户授权产物）
 *
 * 实现细节：
 *  - 用 node:crypto 做 RS256 签名，零额外依赖
 *  - access_token 缓存到内存（按 service account email），过期前 60s 刷新
 *  - 拒绝从环境变量读取私钥（必须显式注入到 config，避免误用）
 */

import { createPrivateKey, createSign } from 'node:crypto';
import { StateError, ErrorCode } from '../../errors/index.js';

const TOKEN_REFRESH_BUFFER_MS = 60_000;

interface ServiceAccountKey {
  readonly client_email: string;
  readonly private_key: string;
  readonly token_uri?: string;
}

interface CachedToken {
  readonly accessToken: string;
  readonly expiresAt: number;
}

const cache = new Map<string, CachedToken>();

export interface GoogleAuthOptions {
  /** scope，例如 'https://www.googleapis.com/auth/calendar' */
  readonly scope: string;
  /** service account JSON（字符串）；与 oauthAccessToken 二选一 */
  readonly serviceAccountJson?: string;
  /** 已有的 access_token（用户授权流程产物） */
  readonly oauthAccessToken?: string;
}

/**
 * 获取 Google API access token。
 * 不缓存 oauthAccessToken（调用方负责刷新）；缓存 service account 签发的 token。
 */
export async function getGoogleAccessToken(opts: GoogleAuthOptions): Promise<string> {
  if (opts.oauthAccessToken) {
    return opts.oauthAccessToken;
  }
  if (!opts.serviceAccountJson) {
    throw new StateError(
      'Google API 调用需要 oauthAccessToken 或 serviceAccountJson',
      ErrorCode.STATE_INVALID_TRANSITION,
    );
  }

  let key: ServiceAccountKey;
  try {
    key = JSON.parse(opts.serviceAccountJson) as ServiceAccountKey;
  } catch {
    throw new StateError('serviceAccountJson 解析失败', ErrorCode.STATE_INVALID_TRANSITION);
  }
  if (!key.client_email || !key.private_key) {
    throw new StateError('serviceAccountJson 缺少 client_email/private_key', ErrorCode.STATE_INVALID_TRANSITION);
  }

  const cacheKey = `${key.client_email}::${opts.scope}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt - TOKEN_REFRESH_BUFFER_MS > Date.now()) {
    return cached.accessToken;
  }

  const tokenUri = key.token_uri ?? 'https://oauth2.googleapis.com/token';
  const now = Math.floor(Date.now() / 1000);
  const claim = {
    iss: key.client_email,
    scope: opts.scope,
    aud: tokenUri,
    iat: now,
    exp: now + 3600,
  };

  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64url(JSON.stringify(claim));
  const unsigned = `${header}.${payload}`;
  const signature = signRs256(unsigned, key.private_key);
  const jwt = `${unsigned}.${signature}`;

  const res = await fetch(tokenUri, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }).toString(),
  });
  if (!res.ok) {
    throw new StateError(`Google OAuth 失败: HTTP ${res.status}`, ErrorCode.STATE_INVALID_TRANSITION);
  }
  const body = await res.json() as { access_token?: string; expires_in?: number };
  if (!body.access_token) {
    throw new StateError('Google OAuth 响应缺少 access_token', ErrorCode.STATE_INVALID_TRANSITION);
  }

  const expiresAt = Date.now() + (typeof body.expires_in === 'number' ? body.expires_in : 3600) * 1000;
  cache.set(cacheKey, { accessToken: body.access_token, expiresAt });
  return body.access_token;
}

/** 仅用于测试：清空缓存 */
export function clearGoogleAuthCache(): void {
  cache.clear();
}

function base64url(input: string | Buffer): string {
  const buf = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function signRs256(unsigned: string, privateKeyPem: string): string {
  const keyObject = createPrivateKey({ key: privateKeyPem, format: 'pem' });
  const signer = createSign('RSA-SHA256');
  signer.update(unsigned);
  const sigBuf = signer.sign(keyObject);
  return base64url(sigBuf);
}
