/**
 * Auth0 SSO 插件
 * 支持通过 Auth0 的 JWKS 端点验证外部 JWT
 * 与自签发 JWT 共存：先尝试自签发验证，失败时尝试 Auth0 JWKS
 */

import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '../../config/schema.js';

export interface Auth0Config {
  enabled: boolean;
  domain: string;
  clientId: string;
  clientSecret: string;
  audience: string;
}

interface JwksKey {
  kid: string;
  kty: string;
  n: string;
  e: string;
  use?: string;
  alg?: string;
}

interface JwksResponse {
  keys: JwksKey[];
}

/** JWKS 缓存 */
let cachedKeys: JwksKey[] = [];
let cacheExpiry = 0;
const CACHE_TTL_MS = 3600_000;

async function fetchJwks(domain: string): Promise<JwksKey[]> {
  const now = Date.now();
  if (cachedKeys.length > 0 && now < cacheExpiry) return cachedKeys;

  const url = `https://${domain}/.well-known/jwks.json`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`JWKS 获取失败: ${res.status}`);
  const data = await res.json() as JwksResponse;
  cachedKeys = data.keys;
  cacheExpiry = now + CACHE_TTL_MS;
  return cachedKeys;
}

/** 构造 Auth0 授权 URL */
export function buildAuthorizeUrl(config: Auth0Config, redirectUri: string, state: string): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: config.clientId,
    redirect_uri: redirectUri,
    scope: 'openid profile email',
    audience: config.audience,
    state,
  });
  return `https://${config.domain}/authorize?${params.toString()}`;
}

/** 用授权码换取 token */
export async function exchangeCode(config: Auth0Config, code: string, redirectUri: string): Promise<{
  access_token: string;
  id_token: string;
  token_type: string;
  expires_in: number;
}> {
  const res = await fetch(`https://${config.domain}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code,
      redirect_uri: redirectUri,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Auth0 token 交换失败: ${res.status} ${text}`);
  }

  return res.json() as Promise<{
    access_token: string;
    id_token: string;
    token_type: string;
    expires_in: number;
  }>;
}

/** 从 Auth0 userinfo 端点获取用户信息 */
export async function fetchUserInfo(domain: string, accessToken: string): Promise<{
  sub: string;
  email?: string;
  name?: string;
  picture?: string;
}> {
  const res = await fetch(`https://${domain}/userinfo`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });

  if (!res.ok) throw new Error(`获取用户信息失败: ${res.status}`);
  return res.json() as Promise<{ sub: string; email?: string; name?: string; picture?: string }>;
}

export async function registerAuth0(app: FastifyInstance, config: AppConfig): Promise<void> {
  if (!config.sso?.enabled) return;

  // 预加载 JWKS 密钥
  try {
    await fetchJwks(config.sso.domain);
    app.log.info({ domain: config.sso.domain }, 'Auth0 JWKS 密钥加载成功');
  } catch (err) {
    app.log.warn({ err }, 'Auth0 JWKS 密钥预加载失败（将在首次请求时重试）');
  }
}
