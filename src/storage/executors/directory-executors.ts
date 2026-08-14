/**
 * Coordinator 身份目录（tenant_identity_directory）SQL 执行器。
 *
 * reserve：INSERT ... ON CONFLICT(lookup_kind, lookup_value) DO NOTHING —— 双库通用
 *   upsert 写法（SQLite ≥3.24 / Postgres），冲突静默无操作 → rowsAffected=0（幂等占位，
 *   canonical 身份由随后的 byLookup 读回）。
 * activate：CAS UPDATE，`WHERE lookup_kind AND lookup_value AND operation_id AND status='PENDING'`，
 *   rowsAffected=1 才算激活成功；错 operation_id / 已 ACTIVE → 0（防他人越权激活），
 *   靠 result.changes 判定，不额外查后判。
 */

import { registerQuery, registerCommand } from '../legacy-sync-bridge.js';
import {
  DIR_QUERY_BY_LOOKUP, DIR_QUERY_PENDING_BEFORE,
  DIR_CMD_RESERVE, DIR_CMD_ACTIVATE, DIR_CMD_DELETE_BY_LOOKUP, DIR_CMD_DELETE_BY_LOOKUP_OP,
} from '@chrono/kernel';
import type {
  DirectoryRow, DirectoryPendingRow,
  DirReserveParams, DirActivateParams, DirLookupParams, DirLookupOpParams,
} from '@chrono/kernel';

export function registerDirectoryExecutors(): void {
  /* ── Queries ── */

  registerQuery<DirectoryRow | null, DirLookupParams>(DIR_QUERY_BY_LOOKUP, (db, p) => {
    return db.prepare<DirectoryRow>(
      `SELECT tenant_id, user_id, status, operation_id, operation_kind, previous_lookup_value, pending_password_hash
       FROM tenant_identity_directory
       WHERE lookup_kind = ? AND lookup_value = ?
       LIMIT 1`,
    ).get(p.lookupKind, p.lookupValue) ?? null;
  });

  registerQuery<readonly DirectoryPendingRow[], number>(DIR_QUERY_PENDING_BEFORE, (db, cutoff) => {
    return db.prepare<DirectoryPendingRow>(
      `SELECT tenant_id, user_id, operation_id, operation_kind, previous_lookup_value, lookup_kind, lookup_value
       FROM tenant_identity_directory
       WHERE status = 'PENDING' AND updated_at < ?`,
    ).all(cutoff);
  });

  /* ── Commands ── */

  /* reserve：ON CONFLICT DO NOTHING → rowsAffected=0 表示查找键已被占（幂等，非撞错）。 */
  registerCommand<DirReserveParams>(DIR_CMD_RESERVE, (db, p) => {
    const result = db.prepare<void>(
      `INSERT INTO tenant_identity_directory (
        tenant_id, user_id, operation_id, operation_kind, previous_lookup_value,
        pending_password_hash, lookup_kind, lookup_value, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(lookup_kind, lookup_value) DO NOTHING`,
    ).run(
      p.tenantId, p.userId, p.operationId, p.operationKind, p.previousLookupValue,
      p.pendingPasswordHash, p.lookupKind, p.lookupValue, p.status, p.now, p.now,
    );
    return { rowsAffected: result.changes };
  });

  /* activate CAS：只有匹配的 PENDING 项能被本 operation_id 激活。rowsAffected=1 成功，0 失败。 */
  registerCommand<DirActivateParams>(DIR_CMD_ACTIVATE, (db, p) => {
    const result = db.prepare<void>(
      `UPDATE tenant_identity_directory
       SET status = 'ACTIVE', updated_at = ?
       WHERE lookup_kind = ? AND lookup_value = ? AND operation_id = ? AND status = 'PENDING'`,
    ).run(p.now, p.lookupKind, p.lookupValue, p.operationId);
    return { rowsAffected: result.changes };
  });

  /* 撤销时清目录（尽力而为，不带 operation/status 约束）。 */
  registerCommand<DirLookupParams>(DIR_CMD_DELETE_BY_LOOKUP, (db, p) => {
    const result = db.prepare<void>(
      'DELETE FROM tenant_identity_directory WHERE lookup_kind = ? AND lookup_value = ?',
    ).run(p.lookupKind, p.lookupValue);
    return { rowsAffected: result.changes };
  });

  /* EMAIL_CHANGE 回滚：只删自己的新 PENDING 项（按 operation_id 匹配），不误删他人 ACTIVE。 */
  registerCommand<DirLookupOpParams>(DIR_CMD_DELETE_BY_LOOKUP_OP, (db, p) => {
    const result = db.prepare<void>(
      `DELETE FROM tenant_identity_directory
       WHERE lookup_kind = ? AND lookup_value = ? AND operation_id = ? AND status = 'PENDING'`,
    ).run(p.lookupKind, p.lookupValue, p.operationId);
    return { rowsAffected: result.changes };
  });
}
