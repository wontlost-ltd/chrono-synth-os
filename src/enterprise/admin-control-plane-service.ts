/**
 * Admin Control Plane Application Service
 * 封装管理后台的分页查询与聚合逻辑
 *
 * 分片 Phase 0 · Plan 1b（Task 5）：
 * - persona_core/marketplace_tasks/persona_wallets/governance_cases 全**有 tenant_id 列**，
 *   故租户约束直接在 query/executor 层 `WHERE <alias>.tenant_id=? [AND status=?]`（本 Task 前 executor 已全含）。
 * - 4 个 list 方法**已普遍带 tenantId**，本 Task 仅 ctor `(tx)`→`(resolver)` +
 *   每方法 `const tx = this.txFor(tenantId)`（dbForTenant 选对 shard）。
 * - 双重约束：`dbForTenant(tenantId)` 选对 shard + SQL tenant predicate 防同库跨租户读。只读查询，无 writer seam。
 */

import type { SyncWriteUnitOfWork } from '@chrono/kernel';
import {
  acpQueryPersonaCount, acpQueryPersonaList, acpQueryPersonaSummary,
  acpQueryTaskCount, acpQueryTaskList, acpQueryTaskSummary,
  acpQueryWalletCount, acpQueryWalletList, acpQueryWalletSummary,
  acpQueryGovCount, acpQueryGovList, acpQueryGovSummary,
} from '@chrono/kernel';
import type { TenantDbResolver } from '../storage/tenant-db-resolver.js';
import { registerCoreSelfExecutors } from '../storage/executors/index.js';

function toIso(value: number | null): string | null {
  return value === null ? null : new Date(Number(value)).toISOString();
}

export interface PaginationInput {
  page: number;
  pageSize: number;
}

export interface PaginationResult {
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

function buildPagination(total: number, page: number, pageSize: number): PaginationResult {
  return {
    total,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  };
}

export class AdminControlPlaneService {
  constructor(private readonly resolver: TenantDbResolver) {
    registerCoreSelfExecutors();
  }

  /** 每 tenant-scoped 调用现取该租户 shard 的 tx（dbForTenant 选 shard），不跨请求缓存。 */
  private txFor(tenantId: string): SyncWriteUnitOfWork {
    return this.resolver.dbForTenant(tenantId);
  }

  listPersonas(tenantId: string, pagination: PaginationInput, status?: string) {
    const tx = this.txFor(tenantId);
    const offset = (pagination.page - 1) * pagination.pageSize;
    const filterStatus = status ?? null;

    const total = tx.queryOne(acpQueryPersonaCount({ tenantId, status: filterStatus }))?.count ?? 0;
    const rows = tx.queryMany(acpQueryPersonaList({ tenantId, status: filterStatus, limit: pagination.pageSize, offset }));
    const summary = tx.queryOne(acpQueryPersonaSummary(tenantId));

    return {
      data: rows.map((row) => ({
        personaId: row.id,
        ownerUserId: row.owner_user_id,
        ownerEmail: row.owner_email,
        displayName: row.display_name,
        status: row.status,
        visibility: row.visibility,
        growthIndex: Number(row.growth_index),
        reputation: Number(row.reputation),
        walletId: row.wallet_id,
        walletBalance: row.wallet_balance === null ? null : Number(row.wallet_balance),
        walletTokenBalance: row.wallet_token_balance === null ? null : Number(row.wallet_token_balance),
        createdAt: toIso(row.created_at),
        updatedAt: toIso(row.updated_at),
      })),
      pagination: buildPagination(total, pagination.page, pagination.pageSize),
      summary: {
        total: Number(summary?.total ?? 0),
        active: Number(summary?.active_count ?? 0),
        restricted: Number(summary?.restricted_count ?? 0),
        deceased: Number(summary?.deceased_count ?? 0),
      },
    };
  }

  listTasks(tenantId: string, pagination: PaginationInput, status?: string) {
    const tx = this.txFor(tenantId);
    const offset = (pagination.page - 1) * pagination.pageSize;
    const filterStatus = status ?? null;

    const total = tx.queryOne(acpQueryTaskCount({ tenantId, status: filterStatus }))?.count ?? 0;
    const rows = tx.queryMany(acpQueryTaskList({ tenantId, status: filterStatus, limit: pagination.pageSize, offset }));
    const summary = tx.queryOne(acpQueryTaskSummary(tenantId));

    return {
      data: rows.map((row) => ({
        taskId: row.id,
        publisherUserId: row.publisher_user_id,
        publisherEmail: row.publisher_email,
        assigneePersonaId: row.assignee_persona_id,
        title: row.title,
        category: row.category,
        reward: Number(row.reward),
        status: row.status,
        qualityScore: row.quality_score === null ? null : Number(row.quality_score),
        createdAt: toIso(row.created_at),
        updatedAt: toIso(row.updated_at),
        completedAt: toIso(row.completed_at),
      })),
      pagination: buildPagination(total, pagination.page, pagination.pageSize),
      summary: {
        total: Number(summary?.total ?? 0),
        open: Number(summary?.open_count ?? 0),
        accepted: Number(summary?.accepted_count ?? 0),
        completed: Number(summary?.completed_count ?? 0),
        disputed: Number(summary?.disputed_count ?? 0),
      },
    };
  }

  listWallets(tenantId: string, pagination: PaginationInput, status?: string) {
    const tx = this.txFor(tenantId);
    const offset = (pagination.page - 1) * pagination.pageSize;
    const filterStatus = status ?? null;

    const total = tx.queryOne(acpQueryWalletCount({ tenantId, status: filterStatus }))?.count ?? 0;
    const rows = tx.queryMany(acpQueryWalletList({ tenantId, status: filterStatus, limit: pagination.pageSize, offset }));
    const summary = tx.queryOne(acpQueryWalletSummary(tenantId));

    return {
      data: rows.map((row) => ({
        walletId: row.id,
        personaId: row.persona_id,
        displayName: row.display_name,
        balance: Number(row.balance),
        tokenBalance: Number(row.token_balance),
        currency: row.currency,
        status: row.status,
        lastSettledAt: toIso(row.last_settled_at),
        createdAt: toIso(row.created_at),
        updatedAt: toIso(row.updated_at),
      })),
      pagination: buildPagination(total, pagination.page, pagination.pageSize),
      summary: {
        total: Number(summary?.total ?? 0),
        active: Number(summary?.active_count ?? 0),
        totalBalance: Number(summary?.total_balance ?? 0),
        totalTokenBalance: Number(summary?.total_token_balance ?? 0),
      },
    };
  }

  listGovernanceCases(tenantId: string, pagination: PaginationInput, status?: string) {
    const tx = this.txFor(tenantId);
    const offset = (pagination.page - 1) * pagination.pageSize;
    const filterStatus = status ?? null;

    const total = tx.queryOne(acpQueryGovCount({ tenantId, status: filterStatus }))?.count ?? 0;
    const rows = tx.queryMany(acpQueryGovList({ tenantId, status: filterStatus, limit: pagination.pageSize, offset }));
    const summary = tx.queryOne(acpQueryGovSummary(tenantId));

    return {
      data: rows.map((row) => ({
        caseId: row.id,
        personaId: row.persona_id,
        displayName: row.display_name,
        taskId: row.task_id,
        triggerType: row.trigger_type,
        severity: row.severity,
        status: row.status,
        openedAt: toIso(row.opened_at),
        resolvedAt: toIso(row.resolved_at),
        appealedAt: toIso(row.appealed_at),
      })),
      pagination: buildPagination(total, pagination.page, pagination.pageSize),
      summary: {
        total: Number(summary?.total ?? 0),
        open: Number(summary?.open_count ?? 0),
        actionApplied: Number(summary?.action_applied_count ?? 0),
        appealed: Number(summary?.appealed_count ?? 0),
        resolved: Number(summary?.resolved_count ?? 0),
      },
    };
  }
}
