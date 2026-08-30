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
import { dbNowMs } from './db-now.js';
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

  /* issue #395：收**宽限时长**而非截止时刻，截止点由数据库算。
   * `updated_at` 由发起预留的副本写、这里的判定跑在恢复 worker 副本上，
   * 两端不同源时钟差会平移判定——worker 钟快就会把**刚发起**的预留
   * 当成过期工单去回滚。
   *
   * ⚠️ 判据用 `<=` 而非 `<`：SQLite 的 `strftime('%s')` 只有**秒级**精度
   * （实测比 Date.now() 落后 0~999ms），同一秒内写入与判定拿到的是同一个值，
   * 严格小于恒不成立 —— `graceMs: 0`（「不留宽限」）会变成**永远扫不到**。
   * 实测：改 `<=` 前 auth-mixed-scope 的两条 graceMs=0 用例直接红。 */
  registerQuery<readonly DirectoryPendingRow[], number>(DIR_QUERY_PENDING_BEFORE, (db, graceMs) => {
    return db.prepare<DirectoryPendingRow>(
      `SELECT tenant_id, user_id, operation_id, operation_kind, previous_lookup_value, lookup_kind, lookup_value
       FROM tenant_identity_directory
       WHERE status = 'PENDING' AND updated_at <= ${dbNowMs(db)} - ?`,
    ).all(graceMs);
  });

  /* ── Commands ── */

  /* reserve：ON CONFLICT DO NOTHING → rowsAffected=0 表示查找键已被占（幂等，非撞错）。 */
  registerCommand<DirReserveParams>(DIR_CMD_RESERVE, (db, p) => {
    const result = db.prepare<void>(
      `INSERT INTO tenant_identity_directory (
        tenant_id, user_id, operation_id, operation_kind, previous_lookup_value,
        pending_password_hash, lookup_kind, lookup_value, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${dbNowMs(db)})
      ON CONFLICT(lookup_kind, lookup_value) DO NOTHING`,
    ).run(
      p.tenantId, p.userId, p.operationId, p.operationKind, p.previousLookupValue,
      p.pendingPasswordHash, p.lookupKind, p.lookupValue, p.status, p.now,
    );
    return { rowsAffected: result.changes };
  });

  /* activate CAS：只有匹配的 PENDING 项能被本 operation_id 激活。rowsAffected=1 成功，0 失败。 */
  registerCommand<DirActivateParams>(DIR_CMD_ACTIVATE, (db, p) => {
    const result = db.prepare<void>(
      `UPDATE tenant_identity_directory
       SET status = 'ACTIVE', updated_at = ${dbNowMs(db)}
       WHERE lookup_kind = ? AND lookup_value = ? AND operation_id = ? AND status = 'PENDING'`,
    ).run(p.lookupKind, p.lookupValue, p.operationId);
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
