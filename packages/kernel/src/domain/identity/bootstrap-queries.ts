/**
 * tenant_bootstrap 完成标记（shard 内表）Query/Command kind 常量与参数类型。
 *
 * 租户分片 Phase 0 · Plan 1c Task 3 —— 纯 SQL 工厂层：register 单事务在落 shard 用户后
 * 写一条 COMPLETE 标记，恢复 worker 据此判定「本次 operation 已确认落 shard」。
 *
 * 语义要点：
 *   - bootCmdMarkComplete 用 `ON CONFLICT(tenant_id, operation_id) DO NOTHING`：重复 mark
 *     幂等（rowsAffected=0 表示已 mark）。
 *   - bootQueryByOperation 按 (tenant_id, operation_id) 精确匹配 —— **per-operation 粒度**，
 *     非 tenant 级查：SCIM/OIDC 向已有 tenant 加用户是独立 operation，不能被旧 COMPLETE 误证。
 *   - status CHECK 只允许 'COMPLETE'（标记存在即完成，不存在即未完成，无中间态）。
 */

import type { Query, Command } from '../../ports/query.js';

/* ── Query Kinds ── */

/** 按 (tenant_id, operation_id) 查完成标记（per-operation 粒度）。 */
export const BOOT_QUERY_BY_OPERATION = 'bootstrap.byOperation' as const;

/* ── Command Kinds ── */

/** 写一条 COMPLETE 标记：INSERT ... ON CONFLICT(tenant_id, operation_id) DO NOTHING（幂等）。 */
export const BOOT_CMD_MARK_COMPLETE = 'bootstrap.markComplete' as const;

/* ── 行类型 ── */

export interface BootstrapRow {
  readonly tenant_id: string;
  readonly operation_id: string;
  readonly status: string;
}

/* ── 参数类型 ── */

/** markComplete 参数：per-operation 完成标记。 */
export interface BootMarkCompleteParams {
  tenantId: string;
  operationId: string;
  now: number;
}

/** 按 (tenant_id, operation_id) 查完成标记的参数。 */
export interface BootByOperationParams {
  tenantId: string;
  operationId: string;
}

/* ── Query 工厂 ── */

export function bootQueryByOperation(tenantId: string, operationId: string): Query<BootstrapRow | null, BootByOperationParams> {
  return { kind: BOOT_QUERY_BY_OPERATION, params: { tenantId, operationId } };
}

/* ── Command 工厂 ── */

export function bootCmdMarkComplete(params: BootMarkCompleteParams): Command<BootMarkCompleteParams> {
  return { kind: BOOT_CMD_MARK_COMPLETE, params };
}
