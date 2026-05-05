/**
 * Google OAuth2 用户授权流（Authorization Code Grant）
 *
 * 流程：
 *  1. buildAuthorizeUrl(state) → 重定向到 Google 同意页
 *  2. 用户同意后 Google 重定向到 redirectUri?code=...&state=...
 *  3. exchangeCodeForToken(code) → 用 client_id/secret + code 换 access/refresh token
 *  4. refreshAccessToken(refreshToken) → access 过期时换新 access（refresh 一般不变）
 *
 * 安全考量：
 *  - state 由调用方维护并校验 CSRF；本模块不做 state 存储
 *  - client_secret 仅在 token 端点 HTTPS 发送，不写日志
 *  - PKCE 暂不启用（服务端 webapp 流程；client_secret 已为强凭据）
 */

import { StateError, ValidationError, ErrorCode } from '../errors/index.js';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';

export interface GoogleOauthClientConfig {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly redirectUri: string;
}

export interface AuthorizeUrlInput {
  readonly scope: string;
  readonly state: string;
  readonly loginHint?: string;
}

export interface ExchangeCodeResult {
  readonly accessToken: string;
  readonly refreshToken: string | null;
  readonly accessExpiresAt: number;
  readonly scope: string;
  readonly tokenType: string;
}

export class GoogleOauthFlow {
  constructor(private readonly config: GoogleOauthClientConfig) {
    if (!config.clientId || !config.clientSecret || !config.redirectUri) {
      throw new ValidationError(
        'GoogleOauthFlow 需要 clientId/clientSecret/redirectUri',
        ErrorCode.VALIDATION_REQUIRED,
      );
    }
  }

  /** 构造授权 URL，用户浏览器跳转后将回到 redirectUri */
  buildAuthorizeUrl(input: AuthorizeUrlInput): string {
    if (!input.state || input.state.length < 16) {
      throw new ValidationError('state 长度需 >= 16，调用方需注入 CSRF 抗性', ErrorCode.VALIDATION_FORMAT);
    }
    const params = new URLSearchParams({
      client_id: this.config.clientId,
      redirect_uri: this.config.redirectUri,
      response_type: 'code',
      scope: input.scope,
      access_type: 'offline',
      prompt: 'consent',
      state: input.state,
      include_granted_scopes: 'true',
    });
    if (input.loginHint) params.set('login_hint', input.loginHint);
    return `${AUTH_URL}?${params.toString()}`;
  }

  /** 用授权码换 token */
  async exchangeCodeForToken(code: string): Promise<ExchangeCodeResult> {
    if (!code) {
      throw new ValidationError('code 必填', ErrorCode.VALIDATION_REQUIRED);
    }
    const body = new URLSearchParams({
      code,
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      redirect_uri: this.config.redirectUri,
      grant_type: 'authorization_code',
    });
    return await this.postToken(body, 'exchangeCodeForToken');
  }

  /** 用 refresh token 刷新 access token */
  async refreshAccessToken(refreshToken: string): Promise<ExchangeCodeResult> {
    if (!refreshToken) {
      throw new ValidationError('refreshToken 必填', ErrorCode.VALIDATION_REQUIRED);
    }
    const body = new URLSearchParams({
      refresh_token: refreshToken,
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      grant_type: 'refresh_token',
    });
    const result = await this.postToken(body, 'refreshAccessToken');
    /* refresh 通常不会返回新的 refresh_token；保留旧的 */
    return { ...result, refreshToken: result.refreshToken ?? refreshToken };
  }

  /** 撤销 token（access 或 refresh 都可作为参数）；失败不抛错以避免阻塞 */
  async revokeToken(token: string): Promise<boolean> {
    if (!token) return false;
    const res = await fetch(`${REVOKE_URL}?token=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    return res.ok;
  }

  private async postToken(body: URLSearchParams, op: string): Promise<ExchangeCodeResult> {
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      throw new StateError(
        `Google OAuth ${op} 失败 HTTP ${res.status}: ${errBody.slice(0, 200)}`,
        ErrorCode.STATE_INVALID_TRANSITION,
      );
    }
    const json = await res.json() as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      scope?: string;
      token_type?: string;
    };
    if (!json.access_token) {
      throw new StateError(`Google OAuth ${op} 响应缺少 access_token`, ErrorCode.STATE_INVALID_TRANSITION);
    }
    const expiresInSec = typeof json.expires_in === 'number' ? json.expires_in : 3600;
    return {
      accessToken: json.access_token,
      refreshToken: json.refresh_token ?? null,
      accessExpiresAt: Date.now() + expiresInSec * 1000,
      scope: json.scope ?? '',
      tokenType: json.token_type ?? 'Bearer',
    };
  }
}
