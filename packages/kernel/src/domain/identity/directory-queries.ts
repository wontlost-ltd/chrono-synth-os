/**
 * Coordinator 身份目录（tenant_identity_directory）Query/Command kind 常量与参数类型。
 *
 * 租户分片 Phase 0 · Plan 1c Task 3 —— 纯 SQL 工厂层：把 v123 建的 coordinator 目录表
 * 的 reserve / activate（CAS）/ 查找 / 回收工单 / 删除操作封装成 kind + 工厂，供后续
 * Auth mixed-scope 状态机（reserve → 落 shard → activate）与恢复 worker 调用。
 *
 * 语义要点：
 *   - reserve（dirCmdReserve）用 `ON CONFLICT(lookup_kind, lookup_value) DO NOTHING`：
 *     同一查找键全局唯一，并发/重试 reserve 静默无操作（rowsAffected=0），canonical 身份
 *     由随后的 dirQueryByLookup 读回，故重复 reserve 不是撞错而是幂等。
 *   - activate（dirCmdActivate）是 CAS：`WHERE lookup_kind AND lookup_value AND operation_id
 *     AND status='PENDING'`，rowsAffected=1 才算激活成功；错 operation_id / 已 ACTIVE → 0，
 *     防他人（旧/并发 reservation）越权激活。
 *   - dirQueryByLookup 返全元数据（tenant/user/status/operation/kind/previous/hash），供
 *     reserve 读回 canonical 身份、续做校验与恢复 worker 按 operation_kind 选分支。
 */

import type { Query, Command } from '../../ports/query.js';

/* ── Query Kinds ── */

/** 按 (lookup_kind, lookup_value) 查目录项（全局唯一键，返全元数据）。 */
export const DIR_QUERY_BY_LOOKUP = 'directory.byLookup' as const;
/** 列出 updated_at 早于 cutoff 的 PENDING 项（恢复 worker 扫描过期未确认工单）。 */
export const DIR_QUERY_PENDING_BEFORE = 'directory.pendingBefore' as const;

/* ── Command Kinds ── */

/** reserve：INSERT ... ON CONFLICT(lookup_kind, lookup_value) DO NOTHING（幂等占位）。 */
export const DIR_CMD_RESERVE = 'directory.reserve' as const;
/** activate：CAS UPDATE status PENDING→ACTIVE，按 operation_id 匹配。 */
export const DIR_CMD_ACTIVATE = 'directory.activate' as const;
/** 按 (lookup_kind, lookup_value) 删除目录项（撤销时清目录，尽力而为）。 */
export const DIR_CMD_DELETE_BY_LOOKUP = 'directory.deleteByLookup' as const;
/** 按 (lookup_kind, lookup_value, operation_id) 删除自己的 PENDING 项（EMAIL_CHANGE 回滚，不误删他人）。 */
export const DIR_CMD_DELETE_BY_LOOKUP_OP = 'directory.deleteByLookupOp' as const;

/* ── 行类型 ── */

/** dirQueryByLookup 返回的全元数据行（供读回 canonical 身份 + 续做校验 + worker 分支）。 */
export interface DirectoryRow {
  readonly tenant_id: string;
  readonly user_id: string | null;
  readonly status: string;
  readonly operation_id: string;
  readonly operation_kind: string;
  readonly previous_lookup_value: string | null;
  readonly pending_password_hash: string | null;
}

/** dirQueryPendingBefore 返回的过期 PENDING 工单行（恢复 worker 据 operation_kind 选分支）。 */
export interface DirectoryPendingRow {
  readonly tenant_id: string;
  readonly user_id: string | null;
  readonly operation_id: string;
  readonly operation_kind: string;
  readonly previous_lookup_value: string | null;
  readonly lookup_kind: string;
  readonly lookup_value: string;
}

/* ── 参数类型 ── */

/**
 * reserve 参数：reserve 用 status='PENDING'；record token/key 用 'ACTIVE'、
 * operation_kind='TOKEN'/'API_KEY'，userId / pendingPasswordHash 可 NULL。
 */
export interface DirReserveParams {
  tenantId: string;
  userId: string | null;
  operationId: string;
  operationKind: string;
  previousLookupValue: string | null;
  pendingPasswordHash: string | null;
  lookupKind: string;
  lookupValue: string;
  status: string;
  now: number;
}

/** activate CAS 参数：按 (lookup_kind, lookup_value, operation_id) 且 status='PENDING' 匹配。 */
export interface DirActivateParams {
  operationId: string;
  lookupKind: string;
  lookupValue: string;
  now: number;
}

/** 按 (lookup_kind, lookup_value) 定位目录项的参数。 */
export interface DirLookupParams {
  lookupKind: string;
  lookupValue: string;
}

/** 按 (lookup_kind, lookup_value, operation_id) 删除自己 PENDING 项的参数。 */
export interface DirLookupOpParams {
  lookupKind: string;
  lookupValue: string;
  operationId: string;
}

/* ── Query 工厂 ── */

export function dirQueryByLookup(lookupKind: string, lookupValue: string): Query<DirectoryRow | null, DirLookupParams> {
  return { kind: DIR_QUERY_BY_LOOKUP, params: { lookupKind, lookupValue } };
}

export function dirQueryPendingBefore(cutoff: number): Query<DirectoryPendingRow, number> {
  return { kind: DIR_QUERY_PENDING_BEFORE, params: cutoff };
}

/* ── Command 工厂 ── */

export function dirCmdReserve(params: DirReserveParams): Command<DirReserveParams> {
  return { kind: DIR_CMD_RESERVE, params };
}

export function dirCmdActivate(params: DirActivateParams): Command<DirActivateParams> {
  return { kind: DIR_CMD_ACTIVATE, params };
}

export function dirCmdDeleteByLookup(lookupKind: string, lookupValue: string): Command<DirLookupParams> {
  return { kind: DIR_CMD_DELETE_BY_LOOKUP, params: { lookupKind, lookupValue } };
}

export function dirCmdDeleteByLookupOp(lookupKind: string, lookupValue: string, operationId: string): Command<DirLookupOpParams> {
  return { kind: DIR_CMD_DELETE_BY_LOOKUP_OP, params: { lookupKind, lookupValue, operationId } };
}
