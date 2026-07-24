/**
 * tenant_bootstrap 完成标记 SQL 执行器。
 *
 * markComplete：INSERT ... ON CONFLICT(tenant_id, operation_id) DO NOTHING —— 双库通用
 *   upsert 写法（SQLite ≥3.24 / Postgres），重复 mark 幂等（rowsAffected=0 表示已 mark）。
 * byOperation：按 (tenant_id, operation_id) 精确匹配（per-operation 粒度），不同 operation_id
 *   即使同 tenant 也查不到，SCIM/OIDC 新 reservation 不被旧 COMPLETE 误证。
 */

import { registerQuery, registerCommand } from '../legacy-sync-bridge.js';
import {
  BOOT_QUERY_BY_OPERATION, BOOT_CMD_MARK_COMPLETE,
} from '@chrono/kernel';
import type {
  BootstrapRow, BootMarkCompleteParams, BootByOperationParams,
} from '@chrono/kernel';

export function registerBootstrapExecutors(): void {
  /* ── Query ── */

  registerQuery<BootstrapRow | null, BootByOperationParams>(BOOT_QUERY_BY_OPERATION, (db, p) => {
    return db.prepare<BootstrapRow>(
      `SELECT tenant_id, operation_id, status
       FROM tenant_bootstrap
       WHERE tenant_id = ? AND operation_id = ?
       LIMIT 1`,
    ).get(p.tenantId, p.operationId) ?? null;
  });

  /* ── Command ── */

  /* markComplete：ON CONFLICT DO NOTHING → 重复 mark rowsAffected=0（幂等）。 */
  registerCommand<BootMarkCompleteParams>(BOOT_CMD_MARK_COMPLETE, (db, p) => {
    const result = db.prepare<void>(
      `INSERT INTO tenant_bootstrap (tenant_id, operation_id, status, created_at)
       VALUES (?, ?, 'COMPLETE', ?)
       ON CONFLICT(tenant_id, operation_id) DO NOTHING`,
    ).run(p.tenantId, p.operationId, p.now);
    return { rowsAffected: result.changes };
  });
}
