/**
 * 用户资料 SQL 执行器 — 将内核 Query/Command kind 映射到 db.prepare 调用
 */

import { registerQuery, registerCommand } from '../legacy-sync-bridge.js';
import type {
  UserProfileSummaryRow, UserProfileRow, UserIdRow,
  UprofByEmailExcludeParams,
  UprofUpdateEmailParams, UprofUpdatePasswordParams,
} from '@chrono/kernel';
import {
  UPROF_QUERY_BY_ID, UPROF_QUERY_BY_EMAIL_EXCLUDE, UPROF_QUERY_FULL_BY_ID,
  UPROF_CMD_UPDATE_EMAIL, UPROF_CMD_UPDATE_PASSWORD,
} from '@chrono/kernel';

export function registerUserProfileExecutors(): void {
  /* ── Queries ── */

  registerQuery<UserProfileSummaryRow | null, string>(UPROF_QUERY_BY_ID, (db, userId) => {
    return db.prepare<UserProfileSummaryRow>(
      'SELECT id, email, role, tenant_id, created_at FROM users WHERE id = ?',
    ).get(userId) ?? null;
  });

  registerQuery<UserIdRow | null, UprofByEmailExcludeParams>(UPROF_QUERY_BY_EMAIL_EXCLUDE, (db, p) => {
    return db.prepare<UserIdRow>(
      'SELECT id FROM users WHERE email = ? AND id != ?',
    ).get(p.email, p.excludeUserId) ?? null;
  });

  registerQuery<UserProfileRow | null, string>(UPROF_QUERY_FULL_BY_ID, (db, userId) => {
    return db.prepare<UserProfileRow>(
      'SELECT * FROM users WHERE id = ?',
    ).get(userId) ?? null;
  });

  /* ── Commands ── */

  registerCommand<UprofUpdateEmailParams>(UPROF_CMD_UPDATE_EMAIL, (db, p) => {
    const result = db.prepare<void>(
      'UPDATE users SET email = ?, updated_at = ? WHERE id = ?',
    ).run(p.email, p.now, p.userId);
    return { rowsAffected: result.changes };
  });

  registerCommand<UprofUpdatePasswordParams>(UPROF_CMD_UPDATE_PASSWORD, (db, p) => {
    const result = db.prepare<void>(
      'UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?',
    ).run(p.passwordHash, p.now, p.userId);
    return { rowsAffected: result.changes };
  });
}
