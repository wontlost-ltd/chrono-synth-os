/**
 * 用户资料 SQL 执行器 — 将内核 Query/Command kind 映射到 db.prepare 调用
 */

import { registerQuery, registerCommand } from '../legacy-sync-bridge.js';
import type {
  UserProfileSummaryRow, UserProfileRow, UserIdRow,
  UprofByTenantAndIdParams, UprofByEmailExcludeParams,
  UprofUpdateEmailParams, UprofUpdatePasswordParams,
} from '@chrono/kernel';
import {
  UPROF_QUERY_BY_ID, UPROF_QUERY_BY_ID_GLOBAL, UPROF_QUERY_BY_EMAIL_EXCLUDE, UPROF_QUERY_FULL_BY_ID,
  UPROF_CMD_UPDATE_EMAIL, UPROF_CMD_UPDATE_PASSWORD,
} from '@chrono/kernel';

export function registerUserProfileExecutors(): void {
  /* ── Queries ── */

  /* 分片 Plan 1b（Task 7）：tenant-scoped 摘要查询 → WHERE tenant_id=? AND id=? 防同库跨租户读。 */
  registerQuery<UserProfileSummaryRow | null, UprofByTenantAndIdParams>(UPROF_QUERY_BY_ID, (db, p) => {
    return db.prepare<UserProfileSummaryRow>(
      'SELECT id, email, role, tenant_id, created_at FROM users WHERE tenant_id = ? AND id = ?',
    ).get(p.tenantId, p.userId) ?? null;
  });

  /* 全局摘要查询（无 tenant predicate）：供 UserEmailDirectoryService 经 coordinatorDb 更新 email 后取回 profile。 */
  registerQuery<UserProfileSummaryRow | null, string>(UPROF_QUERY_BY_ID_GLOBAL, (db, userId) => {
    return db.prepare<UserProfileSummaryRow>(
      'SELECT id, email, role, tenant_id, created_at FROM users WHERE id = ?',
    ).get(userId) ?? null;
  });

  /* email 全局唯一性检查（无 tenant predicate——email 跨租户唯一）：供 UserEmailDirectoryService。 */
  registerQuery<UserIdRow | null, UprofByEmailExcludeParams>(UPROF_QUERY_BY_EMAIL_EXCLUDE, (db, p) => {
    return db.prepare<UserIdRow>(
      'SELECT id FROM users WHERE email = ? AND id != ?',
    ).get(p.email, p.excludeUserId) ?? null;
  });

  /* 分片 Plan 1b（Task 7）：tenant-scoped 完整行查询 → WHERE tenant_id=? AND id=?（changePassword 凭证验证）。 */
  registerQuery<UserProfileRow | null, UprofByTenantAndIdParams>(UPROF_QUERY_FULL_BY_ID, (db, p) => {
    return db.prepare<UserProfileRow>(
      'SELECT * FROM users WHERE tenant_id = ? AND id = ?',
    ).get(p.tenantId, p.userId) ?? null;
  });

  /* ── Commands ── */

  /* 分片 Plan 1c（Task 9）：tenant-scoped 改 email → WHERE tenant_id=? AND id=?（updateEmail 状态机
   * 步骤 3 落 shard，按 dbForTenant(tenantId) 取对 shard；tenant predicate 防同一 shard 多租户误改）。 */
  registerCommand<UprofUpdateEmailParams>(UPROF_CMD_UPDATE_EMAIL, (db, p) => {
    const result = db.prepare<void>(
      'UPDATE users SET email = ?, updated_at = ? WHERE tenant_id = ? AND id = ?',
    ).run(p.email, p.now, p.tenantId, p.userId);
    return { rowsAffected: result.changes };
  });

  /* 分片 Plan 1b（Task 7）：tenant-scoped 改密 → WHERE tenant_id=? AND id=? 防同库跨租户改密。 */
  registerCommand<UprofUpdatePasswordParams>(UPROF_CMD_UPDATE_PASSWORD, (db, p) => {
    const result = db.prepare<void>(
      'UPDATE users SET password_hash = ?, updated_at = ? WHERE tenant_id = ? AND id = ?',
    ).run(p.passwordHash, p.now, p.tenantId, p.userId);
    return { rowsAffected: result.changes };
  });
}
