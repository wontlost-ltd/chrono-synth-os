/**
 * 用户 OAuth2 token 执行器
 *
 * 注意：access_token / refresh_token 在到达此层之前已被 FieldEncryption 加密，
 *       SQL 层只负责密文落盘和读取，不涉及解密。
 */

import { registerQuery, registerCommand } from '../legacy-sync-bridge.js';
import {
  UOAUTH_QUERY_BY_USER_PROVIDER_SCOPE,
  UOAUTH_QUERY_LIST_BY_USER,
  UOAUTH_CMD_UPSERT,
  UOAUTH_CMD_REVOKE,
} from '@chrono/kernel';
import type {
  UserOauthTokenRow,
  UserOauthQueryParams,
  UserOauthUpsertParams,
  UserOauthRevokeParams,
  UserOauthListByUserParams,
} from '@chrono/kernel';

const UOAUTH_SELECT = `
  SELECT id, tenant_id, user_id, provider, scope,
         access_token_encrypted, refresh_token_encrypted,
         access_expires_at, granted_at, updated_at, revoked_at
    FROM user_oauth_tokens`;

export function registerUserOauthTokenExecutors(): void {
  registerQuery<UserOauthTokenRow | null, UserOauthQueryParams>(
    UOAUTH_QUERY_BY_USER_PROVIDER_SCOPE,
    (db, p) => {
      return db.prepare<UserOauthTokenRow>(
        `${UOAUTH_SELECT}
          WHERE tenant_id = ? AND user_id = ? AND provider = ? AND scope = ?
            AND revoked_at IS NULL
          LIMIT 1`,
      ).get(p.tenantId, p.userId, p.provider, p.scope) ?? null;
    },
  );

  registerQuery<readonly UserOauthTokenRow[], UserOauthListByUserParams>(
    UOAUTH_QUERY_LIST_BY_USER,
    (db, p) => {
      return db.prepare<UserOauthTokenRow>(
        `${UOAUTH_SELECT}
          WHERE tenant_id = ? AND user_id = ? AND revoked_at IS NULL
          ORDER BY granted_at DESC`,
      ).all(p.tenantId, p.userId);
    },
  );

  registerCommand<UserOauthUpsertParams>(UOAUTH_CMD_UPSERT, (db, p) => {
    const result = db.prepare<void>(
      `INSERT INTO user_oauth_tokens
         (id, tenant_id, user_id, provider, scope,
          access_token_encrypted, refresh_token_encrypted,
          access_expires_at, granted_at, updated_at, revoked_at, revocation_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
       ON CONFLICT(tenant_id, user_id, provider, scope) DO UPDATE SET
         access_token_encrypted = excluded.access_token_encrypted,
         refresh_token_encrypted = COALESCE(excluded.refresh_token_encrypted, user_oauth_tokens.refresh_token_encrypted),
         access_expires_at = excluded.access_expires_at,
         updated_at = excluded.updated_at,
         revoked_at = NULL,
         revocation_reason = NULL`,
    ).run(
      p.id, p.tenantId, p.userId, p.provider, p.scope,
      p.accessTokenEncrypted, p.refreshTokenEncrypted,
      p.accessExpiresAt, p.now, p.now,
    );
    return { rowsAffected: result.changes };
  });

  registerCommand<UserOauthRevokeParams>(UOAUTH_CMD_REVOKE, (db, p) => {
    const result = db.prepare<void>(
      `UPDATE user_oauth_tokens
          SET revoked_at = ?, updated_at = ?, revocation_reason = ?
        WHERE id = ? AND revoked_at IS NULL`,
    ).run(p.now, p.now, p.reason, p.id);
    return { rowsAffected: result.changes };
  });
}
