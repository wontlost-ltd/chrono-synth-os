/**
 * Admin Control Plane Application Service
 * 封装管理后台的分页查询与聚合逻辑
 */

import type { IDatabase, SqlValue } from '../storage/database.js';

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
  constructor(private readonly db: IDatabase) {}

  listPersonas(tenantId: string, pagination: PaginationInput, status?: string) {
    const offset = (pagination.page - 1) * pagination.pageSize;
    const where = status ? 'WHERE pc.tenant_id = ? AND pc.status = ?' : 'WHERE pc.tenant_id = ?';
    const params: SqlValue[] = status ? [tenantId, status] : [tenantId];

    const total = this.db.prepare<{ count: number }>(
      `SELECT COUNT(*) AS count FROM persona_core pc ${where}`,
    ).get(...params)?.count ?? 0;

    const rows = this.db.prepare<{
      id: string;
      owner_user_id: string;
      owner_email: string | null;
      display_name: string;
      status: string;
      visibility: string;
      growth_index: number;
      reputation: number;
      wallet_id: string | null;
      wallet_balance: number | null;
      wallet_token_balance: number | null;
      created_at: number;
      updated_at: number;
    }>(
      `SELECT
         pc.id, pc.owner_user_id, u.email AS owner_email, pc.display_name,
         pc.status, pc.visibility, pc.growth_index, pc.reputation,
         pw.id AS wallet_id, pw.balance AS wallet_balance,
         pw.token_balance AS wallet_token_balance,
         pc.created_at, pc.updated_at
       FROM persona_core pc
       LEFT JOIN users u ON u.id = pc.owner_user_id
       LEFT JOIN persona_wallets pw ON pw.tenant_id = pc.tenant_id AND pw.persona_id = pc.id
       ${where}
       ORDER BY pc.created_at DESC
       LIMIT ? OFFSET ?`,
    ).all(...params, pagination.pageSize, offset);

    const summary = this.db.prepare<{
      total: number; active_count: number; restricted_count: number; deceased_count: number;
    }>(
      `SELECT COUNT(*) AS total,
         SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active_count,
         SUM(CASE WHEN status = 'restricted' THEN 1 ELSE 0 END) AS restricted_count,
         SUM(CASE WHEN status = 'deceased' THEN 1 ELSE 0 END) AS deceased_count
       FROM persona_core WHERE tenant_id = ?`,
    ).get(tenantId);

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
    const offset = (pagination.page - 1) * pagination.pageSize;
    const where = status ? 'WHERE mt.tenant_id = ? AND mt.status = ?' : 'WHERE mt.tenant_id = ?';
    const params: SqlValue[] = status ? [tenantId, status] : [tenantId];

    const total = this.db.prepare<{ count: number }>(
      `SELECT COUNT(*) AS count FROM marketplace_tasks mt ${where}`,
    ).get(...params)?.count ?? 0;

    const rows = this.db.prepare<{
      id: string; publisher_user_id: string; publisher_email: string | null;
      assignee_persona_id: string | null; title: string; category: string;
      reward: number; status: string; quality_score: number | null;
      created_at: number; updated_at: number; completed_at: number | null;
    }>(
      `SELECT mt.id, mt.publisher_user_id, u.email AS publisher_email,
         mt.assignee_persona_id, mt.title, mt.category, mt.reward,
         mt.status, mt.quality_score, mt.created_at, mt.updated_at, mt.completed_at
       FROM marketplace_tasks mt
       LEFT JOIN users u ON u.id = mt.publisher_user_id
       ${where}
       ORDER BY mt.created_at DESC
       LIMIT ? OFFSET ?`,
    ).all(...params, pagination.pageSize, offset);

    const summary = this.db.prepare<{
      total: number; open_count: number; accepted_count: number;
      completed_count: number; disputed_count: number;
    }>(
      `SELECT COUNT(*) AS total,
         SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) AS open_count,
         SUM(CASE WHEN status = 'accepted' THEN 1 ELSE 0 END) AS accepted_count,
         SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed_count,
         SUM(CASE WHEN status = 'disputed' THEN 1 ELSE 0 END) AS disputed_count
       FROM marketplace_tasks WHERE tenant_id = ?`,
    ).get(tenantId);

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
    const offset = (pagination.page - 1) * pagination.pageSize;
    const where = status ? 'WHERE pw.tenant_id = ? AND pw.status = ?' : 'WHERE pw.tenant_id = ?';
    const params: SqlValue[] = status ? [tenantId, status] : [tenantId];

    const total = this.db.prepare<{ count: number }>(
      `SELECT COUNT(*) AS count FROM persona_wallets pw ${where}`,
    ).get(...params)?.count ?? 0;

    const rows = this.db.prepare<{
      id: string; persona_id: string; display_name: string | null;
      balance: number; token_balance: number; currency: string;
      status: string; last_settled_at: number | null;
      created_at: number; updated_at: number;
    }>(
      `SELECT pw.id, pw.persona_id, pc.display_name, pw.balance, pw.token_balance,
         pw.currency, pw.status, pw.last_settled_at, pw.created_at, pw.updated_at
       FROM persona_wallets pw
       LEFT JOIN persona_core pc ON pc.tenant_id = pw.tenant_id AND pc.id = pw.persona_id
       ${where}
       ORDER BY pw.created_at DESC
       LIMIT ? OFFSET ?`,
    ).all(...params, pagination.pageSize, offset);

    const summary = this.db.prepare<{
      total: number; active_count: number; total_balance: number; total_token_balance: number;
    }>(
      `SELECT COUNT(*) AS total,
         SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active_count,
         COALESCE(SUM(balance), 0) AS total_balance,
         COALESCE(SUM(token_balance), 0) AS total_token_balance
       FROM persona_wallets WHERE tenant_id = ?`,
    ).get(tenantId);

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
    const offset = (pagination.page - 1) * pagination.pageSize;
    const where = status ? 'WHERE gc.tenant_id = ? AND gc.status = ?' : 'WHERE gc.tenant_id = ?';
    const params: SqlValue[] = status ? [tenantId, status] : [tenantId];

    const total = this.db.prepare<{ count: number }>(
      `SELECT COUNT(*) AS count FROM governance_cases gc ${where}`,
    ).get(...params)?.count ?? 0;

    const rows = this.db.prepare<{
      id: string; persona_id: string; display_name: string | null;
      task_id: string | null; trigger_type: string; severity: string;
      status: string; opened_at: number; resolved_at: number | null; appealed_at: number | null;
    }>(
      `SELECT gc.id, gc.persona_id, pc.display_name, gc.task_id, gc.trigger_type,
         gc.severity, gc.status, gc.opened_at, gc.resolved_at, gc.appealed_at
       FROM governance_cases gc
       LEFT JOIN persona_core pc ON pc.tenant_id = gc.tenant_id AND pc.id = gc.persona_id
       ${where}
       ORDER BY gc.opened_at DESC
       LIMIT ? OFFSET ?`,
    ).all(...params, pagination.pageSize, offset);

    const summary = this.db.prepare<{
      total: number; open_count: number; action_applied_count: number;
      appealed_count: number; resolved_count: number;
    }>(
      `SELECT COUNT(*) AS total,
         SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) AS open_count,
         SUM(CASE WHEN status = 'action_applied' THEN 1 ELSE 0 END) AS action_applied_count,
         SUM(CASE WHEN status = 'appealed' THEN 1 ELSE 0 END) AS appealed_count,
         SUM(CASE WHEN status = 'resolved' THEN 1 ELSE 0 END) AS resolved_count
       FROM governance_cases WHERE tenant_id = ?`,
    ).get(tenantId);

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
