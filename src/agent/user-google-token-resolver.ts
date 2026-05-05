/**
 * 用户级 Google token 解析器
 *
 * 给 CalendarTool / EmailTool 注入：在调用前根据 (userId, scope) 解析出 access_token。
 * 若距过期 <60s 自动 refresh（要求有 refresh_token）。
 *
 * 由 ToolInvocationPipeline 每次调用前生成（短生命周期、不跨调用持有），所以 cache 仅在单次调用内有效。
 */

import type { Logger } from '../utils/logger.js';
import { GoogleOauthFlow } from './oauth-google-flow.js';
import type { UserOauthTokenService } from './user-oauth-token-service.js';
import { StateError, ErrorCode } from '../errors/index.js';

const REFRESH_BUFFER_MS = 60_000;

export interface UserGoogleTokenResolverDeps {
  readonly tenantId: string;
  readonly userId: string;
  readonly tokens: UserOauthTokenService;
  readonly oauth: GoogleOauthFlow;
  readonly logger: Logger;
}

/**
 * 返回 (scope) → Promise<accessToken | null>
 *  - null 表示该用户尚未授权该 scope；调用方应返回 401 + 引导 OAuth
 */
export function createUserGoogleTokenResolver(
  deps: UserGoogleTokenResolverDeps,
): (scope: string) => Promise<string | null> {
  return async (scope: string) => {
    const token = deps.tokens.get({
      tenantId: deps.tenantId,
      userId: deps.userId,
      provider: 'google',
      scope,
    });
    if (!token) return null;

    if (token.accessExpiresAt - REFRESH_BUFFER_MS > Date.now()) {
      return token.accessToken;
    }

    if (!token.refreshToken) {
      throw new StateError(
        `Google access token 已过期且无 refresh token: scope=${scope}`,
        ErrorCode.STATE_INVALID_TRANSITION,
      );
    }

    const refreshed = await deps.oauth.refreshAccessToken(token.refreshToken);
    deps.tokens.upsert({
      tenantId: deps.tenantId,
      userId: deps.userId,
      provider: 'google',
      scope,
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken,
      accessExpiresAt: refreshed.accessExpiresAt,
    });
    deps.logger.info('UserGoogleTokenResolver', `已刷新 google access token user=${deps.userId} scope=${scope}`);
    return refreshed.accessToken;
  };
}
