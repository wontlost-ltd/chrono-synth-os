/**
 * 管理控制台 SQL 执行器（只读查询，含动态 WHERE）
 */

import { registerQuery } from '../legacy-sync-bridge.js';
import type { SqlValue } from '../database.js';
import {
  ACP_QUERY_PERSONA_COUNT, ACP_QUERY_PERSONA_LIST, ACP_QUERY_PERSONA_SUMMARY,
  ACP_QUERY_TASK_COUNT, ACP_QUERY_TASK_LIST, ACP_QUERY_TASK_SUMMARY,
  ACP_QUERY_WALLET_COUNT, ACP_QUERY_WALLET_LIST, ACP_QUERY_WALLET_SUMMARY,
  ACP_QUERY_GOV_COUNT, ACP_QUERY_GOV_LIST, ACP_QUERY_GOV_SUMMARY,
} from '@chrono/kernel';
import type {
  AcpCountRow, AcpPersonaRow, AcpPersonaSummaryRow,
  AcpTaskRow, AcpTaskSummaryRow,
  AcpWalletRow, AcpWalletSummaryRow,
  AcpGovRow, AcpGovSummaryRow,
  AcpFilterParams, AcpPagedParams,
} from '@chrono/kernel';

function buildWhere(alias: string, status: string | null): { clause: string; params: SqlValue[] } {
  if (status) return { clause: `WHERE ${alias}.tenant_id = ? AND ${alias}.status = ?`, params: [] };
  return { clause: `WHERE ${alias}.tenant_id = ?`, params: [] };
}

function filterParams(p: AcpFilterParams): SqlValue[] {
  return p.status ? [p.tenantId, p.status] : [p.tenantId];
}

export function registerAdminControlPlaneExecutors(): void {
  /* ── Persona ── */

  registerQuery<AcpCountRow | null, AcpFilterParams>(ACP_QUERY_PERSONA_COUNT, (db, p) => {
    const { clause } = buildWhere('pc', p.status);
    const row = db.prepare<{ count: number | bigint }>(
      `SELECT COUNT(*) AS count FROM persona_core pc ${clause}`,
    ).get(...filterParams(p));
    if (!row) return null;
    return { count: Number(row.count) };
  });

  registerQuery<readonly AcpPersonaRow[], AcpPagedParams>(ACP_QUERY_PERSONA_LIST, (db, p) => {
    const { clause } = buildWhere('pc', p.status);
    return db.prepare<AcpPersonaRow>(
      `SELECT
         pc.id, pc.owner_user_id, u.email AS owner_email, pc.display_name,
         pc.status, pc.visibility, pc.growth_index, pc.reputation,
         pw.id AS wallet_id, pw.balance AS wallet_balance,
         pw.token_balance AS wallet_token_balance,
         pc.created_at, pc.updated_at
       FROM persona_core pc
       LEFT JOIN users u ON u.id = pc.owner_user_id
       LEFT JOIN persona_wallets pw ON pw.tenant_id = pc.tenant_id AND pw.persona_id = pc.id
       ${clause}
       ORDER BY pc.created_at DESC
       LIMIT ? OFFSET ?`,
    ).all(...filterParams(p), p.limit, p.offset);
  });

  registerQuery<AcpPersonaSummaryRow | null, string>(ACP_QUERY_PERSONA_SUMMARY, (db, tenantId) => {
    const row = db.prepare<{ total: number | bigint; active_count: number | bigint; restricted_count: number | bigint; deceased_count: number | bigint }>(
      `SELECT COUNT(*) AS total,
         SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active_count,
         SUM(CASE WHEN status = 'restricted' THEN 1 ELSE 0 END) AS restricted_count,
         SUM(CASE WHEN status = 'deceased' THEN 1 ELSE 0 END) AS deceased_count
       FROM persona_core WHERE tenant_id = ?`,
    ).get(tenantId);
    if (!row) return null;
    return {
      total: Number(row.total),
      active_count: Number(row.active_count ?? 0),
      restricted_count: Number(row.restricted_count ?? 0),
      deceased_count: Number(row.deceased_count ?? 0),
    };
  });

  /* ── Task ── */

  registerQuery<AcpCountRow | null, AcpFilterParams>(ACP_QUERY_TASK_COUNT, (db, p) => {
    const { clause } = buildWhere('mt', p.status);
    const row = db.prepare<{ count: number | bigint }>(
      `SELECT COUNT(*) AS count FROM marketplace_tasks mt ${clause}`,
    ).get(...filterParams(p));
    if (!row) return null;
    return { count: Number(row.count) };
  });

  registerQuery<readonly AcpTaskRow[], AcpPagedParams>(ACP_QUERY_TASK_LIST, (db, p) => {
    const { clause } = buildWhere('mt', p.status);
    return db.prepare<AcpTaskRow>(
      `SELECT mt.id, mt.publisher_user_id, u.email AS publisher_email,
         mt.assignee_persona_id, mt.title, mt.category, mt.reward,
         mt.status, mt.quality_score, mt.created_at, mt.updated_at, mt.completed_at
       FROM marketplace_tasks mt
       LEFT JOIN users u ON u.id = mt.publisher_user_id
       ${clause}
       ORDER BY mt.created_at DESC
       LIMIT ? OFFSET ?`,
    ).all(...filterParams(p), p.limit, p.offset);
  });

  registerQuery<AcpTaskSummaryRow | null, string>(ACP_QUERY_TASK_SUMMARY, (db, tenantId) => {
    const row = db.prepare<{ total: number | bigint; open_count: number | bigint; accepted_count: number | bigint; completed_count: number | bigint; disputed_count: number | bigint }>(
      `SELECT COUNT(*) AS total,
         SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) AS open_count,
         SUM(CASE WHEN status = 'accepted' THEN 1 ELSE 0 END) AS accepted_count,
         SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed_count,
         SUM(CASE WHEN status = 'disputed' THEN 1 ELSE 0 END) AS disputed_count
       FROM marketplace_tasks WHERE tenant_id = ?`,
    ).get(tenantId);
    if (!row) return null;
    return {
      total: Number(row.total),
      open_count: Number(row.open_count ?? 0),
      accepted_count: Number(row.accepted_count ?? 0),
      completed_count: Number(row.completed_count ?? 0),
      disputed_count: Number(row.disputed_count ?? 0),
    };
  });

  /* ── Wallet ── */

  registerQuery<AcpCountRow | null, AcpFilterParams>(ACP_QUERY_WALLET_COUNT, (db, p) => {
    const { clause } = buildWhere('pw', p.status);
    const row = db.prepare<{ count: number | bigint }>(
      `SELECT COUNT(*) AS count FROM persona_wallets pw ${clause}`,
    ).get(...filterParams(p));
    if (!row) return null;
    return { count: Number(row.count) };
  });

  registerQuery<readonly AcpWalletRow[], AcpPagedParams>(ACP_QUERY_WALLET_LIST, (db, p) => {
    const { clause } = buildWhere('pw', p.status);
    return db.prepare<AcpWalletRow>(
      `SELECT pw.id, pw.persona_id, pc.display_name, pw.balance, pw.token_balance,
         pw.currency, pw.status, pw.last_settled_at, pw.created_at, pw.updated_at
       FROM persona_wallets pw
       LEFT JOIN persona_core pc ON pc.tenant_id = pw.tenant_id AND pc.id = pw.persona_id
       ${clause}
       ORDER BY pw.created_at DESC
       LIMIT ? OFFSET ?`,
    ).all(...filterParams(p), p.limit, p.offset);
  });

  registerQuery<AcpWalletSummaryRow | null, string>(ACP_QUERY_WALLET_SUMMARY, (db, tenantId) => {
    const row = db.prepare<{ total: number | bigint; active_count: number | bigint; total_balance: number | bigint; total_token_balance: number | bigint }>(
      `SELECT COUNT(*) AS total,
         SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active_count,
         COALESCE(SUM(balance), 0) AS total_balance,
         COALESCE(SUM(token_balance), 0) AS total_token_balance
       FROM persona_wallets WHERE tenant_id = ?`,
    ).get(tenantId);
    if (!row) return null;
    return {
      total: Number(row.total),
      active_count: Number(row.active_count ?? 0),
      total_balance: Number(row.total_balance),
      total_token_balance: Number(row.total_token_balance),
    };
  });

  /* ── Governance ── */

  registerQuery<AcpCountRow | null, AcpFilterParams>(ACP_QUERY_GOV_COUNT, (db, p) => {
    const { clause } = buildWhere('gc', p.status);
    const row = db.prepare<{ count: number | bigint }>(
      `SELECT COUNT(*) AS count FROM governance_cases gc ${clause}`,
    ).get(...filterParams(p));
    if (!row) return null;
    return { count: Number(row.count) };
  });

  registerQuery<readonly AcpGovRow[], AcpPagedParams>(ACP_QUERY_GOV_LIST, (db, p) => {
    const { clause } = buildWhere('gc', p.status);
    return db.prepare<AcpGovRow>(
      `SELECT gc.id, gc.persona_id, pc.display_name, gc.task_id, gc.trigger_type,
         gc.severity, gc.status, gc.opened_at, gc.resolved_at, gc.appealed_at
       FROM governance_cases gc
       LEFT JOIN persona_core pc ON pc.tenant_id = gc.tenant_id AND pc.id = gc.persona_id
       ${clause}
       ORDER BY gc.opened_at DESC
       LIMIT ? OFFSET ?`,
    ).all(...filterParams(p), p.limit, p.offset);
  });

  registerQuery<AcpGovSummaryRow | null, string>(ACP_QUERY_GOV_SUMMARY, (db, tenantId) => {
    const row = db.prepare<{ total: number | bigint; open_count: number | bigint; action_applied_count: number | bigint; appealed_count: number | bigint; resolved_count: number | bigint }>(
      `SELECT COUNT(*) AS total,
         SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) AS open_count,
         SUM(CASE WHEN status = 'action_applied' THEN 1 ELSE 0 END) AS action_applied_count,
         SUM(CASE WHEN status = 'appealed' THEN 1 ELSE 0 END) AS appealed_count,
         SUM(CASE WHEN status = 'resolved' THEN 1 ELSE 0 END) AS resolved_count
       FROM governance_cases WHERE tenant_id = ?`,
    ).get(tenantId);
    if (!row) return null;
    return {
      total: Number(row.total),
      open_count: Number(row.open_count ?? 0),
      action_applied_count: Number(row.action_applied_count ?? 0),
      appealed_count: Number(row.appealed_count ?? 0),
      resolved_count: Number(row.resolved_count ?? 0),
    };
  });
}
