/**
 * 工具权限 Application Service
 *
 * 职责：
 *  1. grant：授予 (personaId, toolId) 权限，含 constraints + expiry
 *  2. revoke：通过 id 或 revocation_key 撤销
 *  3. check：在每次工具调用前判定是否允许（含 expiry / revocation 实时校验）
 *  4. recordInvocation：调用结束后写入 tool_invocations
 *  5. quotaUsed：查询当日已用配额（用于 enforceQuota）
 *
 * 不做：实际执行工具（由 ToolInvocationPipeline 协调），不直接发审计（由 pipeline 写）
 */

import { randomBytes, randomUUID } from 'node:crypto';
import type { SyncWriteUnitOfWork, ToolPermission, ToolPermissionRow, ToolConstraints, ToolPermissionCheckInput, ToolPermissionCheckResult, ToolScope, ToolInvocationRow, ToolInvocation, ToolInvocationStatus, InvokerType } from '@chrono/kernel';
import {
  tpermQueryByPersonaTool, tpermQueryListByPersona, tpermQueryListByTenant,
  tpermQueryByRevocationKey, tpermQueryDailyUsage, tpermQueryDailyCost,
  tpermCmdGrant, tpermCmdRevoke, tpermCmdRevokeByKey,
  tinvQueryById, tinvQueryListByPersona, tinvQueryDailyCount,
  tinvQueryPendingByUser, tinvQueryByConfirmationToken,
  tinvCmdRecord, tinvCmdUpdateStatus, tinvCmdPruneBefore,
} from '@chrono/kernel';
import { registerCoreSelfExecutors } from '../storage/executors/index.js';
import { ValidationError, NotFoundError, ErrorCode } from '../errors/index.js';
import { toolInvocationOutcomeTotal } from '../observability/metrics.js';

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

export interface GrantPermissionInput {
  readonly tenantId: string;
  readonly personaId: string;
  readonly toolId: string;
  readonly scope: ToolScope;
  readonly constraints: ToolConstraints;
  readonly grantedBy: string;
  readonly expiresAt?: number | null;
}

export interface GrantPermissionResult {
  readonly id: string;
  readonly revocationKey: string;
}

export class ToolPermissionService {
  constructor(private readonly tx: SyncWriteUnitOfWork) {
    registerCoreSelfExecutors();
  }

  grant(input: GrantPermissionInput): GrantPermissionResult {
    const id = `tperm_${randomUUID()}`;
    const revocationKey = `rk_${randomBytes(24).toString('base64url')}`;
    const now = Date.now();

    this.tx.execute(tpermCmdGrant({
      id,
      tenantId: input.tenantId,
      personaId: input.personaId,
      toolId: input.toolId,
      scope: input.scope,
      constraintsJson: JSON.stringify(input.constraints),
      grantedBy: input.grantedBy,
      now,
      expiresAt: input.expiresAt ?? null,
      revocationKey,
    }));

    return { id, revocationKey };
  }

  /** 撤销（按 id），返回是否成功 */
  revoke(id: string, reason: string): boolean {
    if (!reason || reason.trim().length === 0) {
      throw new ValidationError('撤销原因必填', ErrorCode.VALIDATION_REQUIRED);
    }
    const result = this.tx.execute(tpermCmdRevoke({ id, reason: reason.trim(), now: Date.now() }));
    return result.rowsAffected > 0;
  }

  /**
   * 通过 revocation_key 带外撤销（紧急情况）。租户隔离：须传 tenantId——「持有 key」的撤销
   * 能力仅在本租户内生效，防跨租户按 key 越权撤销。
   */
  revokeByKey(tenantId: string, revocationKey: string, reason: string): boolean {
    if (!reason || reason.trim().length === 0) {
      throw new ValidationError('撤销原因必填', ErrorCode.VALIDATION_REQUIRED);
    }
    const result = this.tx.execute(tpermCmdRevokeByKey({
      tenantId,
      revocationKey,
      reason: reason.trim(),
      now: Date.now(),
    }));
    return result.rowsAffected > 0;
  }

  /**
   * 检查权限是否允许调用。
   * 关键：每次都实时查询数据库，不缓存（撤销必须立即生效）。
   */
  check(input: ToolPermissionCheckInput): ToolPermissionCheckResult {
    const row = this.tx.queryOne(tpermQueryByPersonaTool({
      tenantId: input.tenantId,
      personaId: input.personaId,
      toolId: input.toolId,
    }));
    if (!row) return { allowed: false, reason: 'not_granted' };
    if (row.revoked_at !== null) return { allowed: false, reason: 'revoked' };
    if (row.expires_at !== null && row.expires_at < input.now) {
      return { allowed: false, reason: 'expired' };
    }
    return { allowed: true, permission: rowToPermission(row) };
  }

  /** 列出 persona 的所有权限（含已撤销） */
  listByPersona(tenantId: string, personaId: string): ToolPermission[] {
    const rows = this.tx.queryMany(tpermQueryListByPersona({ tenantId, personaId }));
    return rows.map(rowToPermission);
  }

  /** 列出 tenant 所有权限（admin 用） */
  listByTenant(tenantId: string): ToolPermission[] {
    const rows = this.tx.queryMany(tpermQueryListByTenant(tenantId));
    return rows.map(rowToPermission);
  }

  /** 通过 revocation_key 查找权限（用于校验 key 是否有效）。租户隔离：须传 tenantId 限定查询。 */
  findByRevocationKey(tenantId: string, key: string): ToolPermission | null {
    const row = this.tx.queryOne(tpermQueryByRevocationKey({ tenantId, revocationKey: key }));
    return row ? rowToPermission(row) : null;
  }

  /** 查询当日已用配额（成功调用次数） */
  dailyUsageCount(tenantId: string, personaId: string, toolId: string, now = Date.now()): number {
    const sinceMs = now - ONE_DAY_MS;
    const row = this.tx.queryOne(tpermQueryDailyUsage({ tenantId, personaId, toolId, sinceMs }));
    return row?.count ?? 0;
  }

  /** 查询当日累计成本（分）——用于 budget gate */
  dailyCostCents(tenantId: string, personaId: string, toolId: string, now = Date.now()): number {
    const sinceMs = now - ONE_DAY_MS;
    const row = this.tx.queryOne(tpermQueryDailyCost({ tenantId, personaId, toolId, sinceMs }));
    return row?.cost_cents ?? 0;
  }

  /** 写入 invocation 记录 */
  recordInvocation(input: {
    tenantId: string;
    personaId: string;
    toolId: string;
    invokerType: InvokerType;
    invokerId: string;
    invokerUserId?: string | null;
    status: ToolInvocationStatus;
    inputHash: string;
    outputSizeBytes: number;
    errorMessage: string | null;
    costCents: number;
    durationMs: number;
    confirmationTokenId: string | null;
    invokedAt?: number;
    completedAt?: number | null;
  }): string {
    const id = `tinv_${randomUUID()}`;
    const invokedAt = input.invokedAt ?? Date.now();
    this.tx.execute(tinvCmdRecord({
      id,
      tenantId: input.tenantId,
      personaId: input.personaId,
      toolId: input.toolId,
      invokerType: input.invokerType,
      invokerId: input.invokerId,
      invokerUserId: input.invokerUserId ?? null,
      status: input.status,
      inputHash: input.inputHash,
      outputSizeBytes: input.outputSizeBytes,
      errorMessage: input.errorMessage,
      costCents: input.costCents,
      durationMs: input.durationMs,
      invokedAt,
      completedAt: input.completedAt ?? invokedAt,
      confirmationTokenId: input.confirmationTokenId,
    }));
    /* 不带 tenant_id label（全维评审 F2）：tenant_id 是无界基数，× tool × outcome 会让 OTel 后端时序爆炸/成本失控。
     * 项目约定 metrics 默认不带租户维度（与 requestsTotal 一致）；租户级归因走 DB/审计/rollup，不进指标标签。 */
    toolInvocationOutcomeTotal.add(1, {
      tool_id: input.toolId,
      outcome: input.status,
    });
    return id;
  }

  /** 更新 invocation 状态（异步工具用，先 record pending，完成后 update） */
  updateInvocationStatus(input: {
    id: string;
    status: ToolInvocationStatus;
    outputSizeBytes: number;
    errorMessage: string | null;
    costCents: number;
    durationMs: number;
    completedAt?: number;
  }): void {
    this.tx.execute(tinvCmdUpdateStatus({
      id: input.id,
      status: input.status,
      outputSizeBytes: input.outputSizeBytes,
      errorMessage: input.errorMessage,
      costCents: input.costCents,
      durationMs: input.durationMs,
      completedAt: input.completedAt ?? Date.now(),
    }));
  }

  /** 查询单条 invocation */
  getInvocation(tenantId: string, id: string): ToolInvocation | null {
    const row = this.tx.queryOne(tinvQueryById({ tenantId, id }));
    return row ? rowToInvocation(row) : null;
  }

  /** 列出 persona 历史调用 */
  listInvocations(tenantId: string, personaId: string, limit = 50, offset = 0): ToolInvocation[] {
    const rows = this.tx.queryMany(tinvQueryListByPersona({ tenantId, personaId, limit, offset }));
    return rows.map(rowToInvocation);
  }

  /** 当日各种状态统计（监控用） */
  dailyInvocationCount(tenantId: string, personaId: string, toolId: string, successOnly = false, now = Date.now()): number {
    const sinceMs = now - ONE_DAY_MS;
    const row = this.tx.queryOne(tinvQueryDailyCount({ tenantId, personaId, toolId, sinceMs, successOnly }));
    return row?.count ?? 0;
  }

  /** 列出当前用户待确认的高风险调用（F3） */
  listPendingByUser(tenantId: string, userId: string, limit = 50): ToolInvocation[] {
    const rows = this.tx.queryMany(tinvQueryPendingByUser({ tenantId, userId, limit }));
    return rows.map(rowToInvocation);
  }

  /** 通过 confirmation token id 反查 invocation（F3） */
  getByConfirmationToken(tenantId: string, confirmationTokenId: string): ToolInvocation | null {
    const row = this.tx.queryOne(tinvQueryByConfirmationToken({ tenantId, confirmationTokenId }));
    return row ? rowToInvocation(row) : null;
  }

  /**
   * 删除截止时间之前的 invocation 记录（保留 pending_confirmation）
   * @returns 实际删除行数
   */
  pruneInvocationsBefore(cutoff: number, batchSize = 1000): number {
    const result = this.tx.execute(tinvCmdPruneBefore({ cutoff, batchSize }));
    return result.rowsAffected;
  }
}

function rowToPermission(row: ToolPermissionRow): ToolPermission {
  let constraints: ToolConstraints = {};
  try {
    constraints = JSON.parse(row.constraints_json) as ToolConstraints;
  } catch { /* 默认空 constraints */ }
  return {
    id: row.id,
    tenantId: row.tenant_id,
    personaId: row.persona_id,
    toolId: row.tool_id,
    scope: row.scope as ToolScope,
    constraints,
    grantedBy: row.granted_by,
    grantedAt: row.granted_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    revocationReason: row.revocation_reason,
    revocationKey: row.revocation_key,
  };
}

function rowToInvocation(row: ToolInvocationRow): ToolInvocation {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    personaId: row.persona_id,
    toolId: row.tool_id,
    invokerType: row.invoker_type as InvokerType,
    invokerId: row.invoker_id,
    invokerUserId: row.invoker_user_id,
    status: row.status as ToolInvocationStatus,
    inputHash: row.input_hash,
    outputSizeBytes: row.output_size_bytes,
    errorMessage: row.error_message,
    costCents: row.cost_cents,
    durationMs: row.duration_ms,
    invokedAt: row.invoked_at,
    completedAt: row.completed_at,
    confirmationTokenId: row.confirmation_token_id,
  };
}

export function notFoundIfNull<T>(value: T | null, message: string): T {
  if (value === null) throw new NotFoundError(message, ErrorCode.NOT_FOUND_VALUE);
  return value;
}
