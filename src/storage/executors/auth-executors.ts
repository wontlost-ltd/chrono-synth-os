/**
 * 认证服务 SQL 执行器（AuthService + SsoUserService 共享）
 */

import { registerQuery, registerCommand } from '../legacy-sync-bridge.js';
import {
  AUTH_QUERY_USER_BY_EMAIL, AUTH_QUERY_USER_BY_ID,
  AUTH_QUERY_REFRESH_TOKEN, AUTH_QUERY_USER_BRIEF_BY_EMAIL,
  AUTH_QUERY_USER_COUNT_BY_TENANT, AUTH_QUERY_SUB_EXISTS,
  AUTH_CMD_CREATE_USER, AUTH_CMD_CREATE_SUBSCRIPTION,
  AUTH_CMD_CREATE_REFRESH_TOKEN, AUTH_CMD_REVOKE_TOKEN_BY_ID,
  AUTH_CMD_REVOKE_TOKEN_BY_HASH, AUTH_CMD_REVOKE_TOKENS_BY_USER,
  AUTH_CMD_CLEANUP_EXPIRED_TOKENS, AUTH_CMD_UPDATE_DISPLAY_NAME,
} from '@chrono/kernel';
import type {
  AuthUserRow, AuthUserBriefRow, AuthRefreshTokenRow,
  AuthSubExistsRow, AuthUserCountRow,
  AuthCreateUserParams, AuthCreateSubscriptionParams,
  AuthCreateRefreshTokenParams, AuthCleanupExpiredTokensParams,
  AuthUpdateDisplayNameParams,
} from '@chrono/kernel';

export function registerAuthExecutors(): void {
  /* ── Queries ── */

  registerQuery<AuthUserRow | null, string>(AUTH_QUERY_USER_BY_EMAIL, (db, email) => {
    return db.prepare<AuthUserRow>('SELECT * FROM users WHERE email = ?').get(email) ?? null;
  });

  registerQuery<AuthUserRow | null, string>(AUTH_QUERY_USER_BY_ID, (db, userId) => {
    return db.prepare<AuthUserRow>('SELECT * FROM users WHERE id = ?').get(userId) ?? null;
  });

  registerQuery<AuthRefreshTokenRow | null, string>(AUTH_QUERY_REFRESH_TOKEN, (db, tokenHash) => {
    return db.prepare<AuthRefreshTokenRow>(
      'SELECT * FROM refresh_tokens WHERE token_hash = ? AND is_revoked = 0',
    ).get(tokenHash) ?? null;
  });

  registerQuery<AuthUserBriefRow | null, string>(AUTH_QUERY_USER_BRIEF_BY_EMAIL, (db, email) => {
    return db.prepare<AuthUserBriefRow>(
      'SELECT id, tenant_id, role FROM users WHERE email = ? LIMIT 1',
    ).get(email) ?? null;
  });

  registerQuery<AuthUserCountRow | null, string>(AUTH_QUERY_USER_COUNT_BY_TENANT, (db, tenantId) => {
    const row = db.prepare<{ count: number | bigint }>(
      'SELECT COUNT(*) AS count FROM users WHERE tenant_id = ?',
    ).get(tenantId);
    if (!row) return null;
    return { count: Number(row.count) };
  });

  registerQuery<AuthSubExistsRow | null, string>(AUTH_QUERY_SUB_EXISTS, (db, tenantId) => {
    return db.prepare<AuthSubExistsRow>(
      'SELECT id FROM subscriptions WHERE tenant_id = ? LIMIT 1',
    ).get(tenantId) ?? null;
  });

  /* ── Commands ── */

  registerCommand<AuthCreateUserParams>(AUTH_CMD_CREATE_USER, (db, p) => {
    const result = db.prepare<void>(
      'INSERT INTO users (id, email, password_hash, role, tenant_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(p.id, p.email, p.passwordHash, p.role, p.tenantId, p.now, p.now);
    return { rowsAffected: result.changes };
  });

  registerCommand<AuthCreateSubscriptionParams>(AUTH_CMD_CREATE_SUBSCRIPTION, (db, p) => {
    const result = db.prepare<void>(
      `INSERT INTO subscriptions (id, tenant_id, stripe_customer_id, plan_id, status, current_period_start, current_period_end, created_at, updated_at)
       VALUES (?, ?, ?, 'free', 'active', ?, ?, ?, ?)`,
    ).run(p.id, p.tenantId, p.stripeCustomerId, p.periodStart, p.periodEnd, p.now, p.now);
    return { rowsAffected: result.changes };
  });

  registerCommand<AuthCreateRefreshTokenParams>(AUTH_CMD_CREATE_REFRESH_TOKEN, (db, p) => {
    const result = db.prepare<void>(
      'INSERT INTO refresh_tokens (id, user_id, token_hash, is_revoked, expires_at, created_at) VALUES (?, ?, ?, 0, ?, ?)',
    ).run(p.id, p.userId, p.tokenHash, p.expiresAt, p.now);
    return { rowsAffected: result.changes };
  });

  registerCommand<string>(AUTH_CMD_REVOKE_TOKEN_BY_ID, (db, id) => {
    const result = db.prepare<void>(
      'UPDATE refresh_tokens SET is_revoked = 1 WHERE id = ?',
    ).run(id);
    return { rowsAffected: result.changes };
  });

  registerCommand<string>(AUTH_CMD_REVOKE_TOKEN_BY_HASH, (db, tokenHash) => {
    const result = db.prepare<void>(
      'UPDATE refresh_tokens SET is_revoked = 1 WHERE token_hash = ?',
    ).run(tokenHash);
    return { rowsAffected: result.changes };
  });

  registerCommand<string>(AUTH_CMD_REVOKE_TOKENS_BY_USER, (db, userId) => {
    const result = db.prepare<void>(
      'UPDATE refresh_tokens SET is_revoked = 1 WHERE user_id = ?',
    ).run(userId);
    return { rowsAffected: result.changes };
  });

  registerCommand<AuthCleanupExpiredTokensParams>(AUTH_CMD_CLEANUP_EXPIRED_TOKENS, (db, p) => {
    const result = db.prepare<void>(
      'DELETE FROM refresh_tokens WHERE (is_revoked = 1 AND created_at < ?) OR (expires_at < ?)',
    ).run(p.cutoff, p.cutoff);
    return { rowsAffected: result.changes };
  });

  registerCommand<AuthUpdateDisplayNameParams>(AUTH_CMD_UPDATE_DISPLAY_NAME, (db, p) => {
    const result = db.prepare<void>(
      'UPDATE identities SET display_name = ?, updated_at = ? WHERE user_id = ?',
    ).run(p.displayName, p.now, p.userId);
    return { rowsAffected: result.changes };
  });
}
