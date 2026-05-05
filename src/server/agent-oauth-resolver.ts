/**
 * 用户级 OAuth resolver 工厂
 *
 * HTTP 层在每次请求时根据 (tenantId, userId) 创建一个 resolver，注入到 MCP/pipeline。
 * 这样每个请求的 resolver 只能访问当前用户的 token，避免跨用户泄漏。
 */

import type { GoogleOauthFlow } from '../agent/oauth-google-flow.js';
import type { UserOauthTokenService } from '../agent/user-oauth-token-service.js';
import type { UserOauthTokenResolver } from '../agent/tool-adapter.js';
import type { Logger } from '../utils/logger.js';
import { createUserGoogleTokenResolver } from '../agent/user-google-token-resolver.js';

export interface UserOauthTokenResolverFactoryDeps {
  readonly tokens: UserOauthTokenService;
  readonly googleFlow: GoogleOauthFlow | null;
  readonly logger: Logger;
}

export type UserOauthTokenResolverFactory = (tenantId: string, userId: string) => UserOauthTokenResolver | undefined;

export function createUserOauthTokenResolverFactory(deps: UserOauthTokenResolverFactoryDeps): UserOauthTokenResolverFactory {
  return (tenantId: string, userId: string) => {
    if (!deps.googleFlow) return undefined;
    return createUserGoogleTokenResolver({
      tenantId,
      userId,
      tokens: deps.tokens,
      oauth: deps.googleFlow,
      logger: deps.logger,
    });
  };
}
