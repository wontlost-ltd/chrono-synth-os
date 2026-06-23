/**
 * Persona Core SQL executors.
 */

import { registerQuery, registerCommand } from '../legacy-sync-bridge.js';
import {
  PCORE_QUERY_SUMMARIES_BY_OWNER,
  PCORE_QUERY_SUMMARY_BY_OWNER,
  PCORE_QUERY_FORKS_BY_PERSONA,
  PCORE_QUERY_RECENT_MEMORIES,
  PCORE_QUERY_RECENT_KNOWLEDGE,
  PCORE_QUERY_RECENT_GROWTH_EVENTS,
  PCORE_QUERY_RECENT_GOVERNANCE_EVENTS,
  PCORE_QUERY_RECENT_MARKETPLACE_TASKS,
  PCORE_QUERY_PENDING_TRANSFER,
  PCORE_QUERY_TRANSFER_BY_PERSONA_ID,
  PCORE_QUERY_TRANSFER_BY_ID,
  PCORE_QUERY_TRANSFERS_BY_PERSONA,
  PCORE_QUERY_COMPLETED_TASK_COUNT,
  PCORE_QUERY_GOVERNANCE_PENALTY_COUNT,
  PCORE_QUERY_REPUTATION_HISTORY,
  PCORE_QUERY_ACTIVE_PERSONAS_FOR_RANKING,
  PCORE_QUERY_MEMORY_COUNT,
  PCORE_QUERY_GOVERNANCE_EVENT_COUNT,
  PCORE_QUERY_MARKETPLACE_ANALYTICS,
  PCORE_QUERY_DAILY_PERSONAS,
  PCORE_QUERY_DAILY_COMPLETED_TASK_COUNT,
  PCORE_QUERY_DAILY_PERSONA_REVENUE,
  PCORE_QUERY_DAILY_MARKETPLACE_ANALYTICS,
  PCORE_QUERY_ECONOMY_ANALYTICS,
  PCORE_QUERY_PERSONA_MEMORIES,
  PCORE_QUERY_MEMORY_KIND_COUNTS,
  PCORE_QUERY_MEMORY_RELATION_COUNTS,
  PCORE_QUERY_MEMORY_NODE_IDS,
  PCORE_QUERY_MEMORY_EDGES,
  PCORE_QUERY_WALLET_BY_PERSONA,
  PCORE_QUERY_WALLET_BY_ID_FOR_OWNER,
  PCORE_QUERY_WALLET_TRANSACTIONS,
  PCORE_QUERY_TASK_APPLICATION,
  PCORE_QUERY_RUNTIME_SESSION,
  PCORE_QUERY_TIMED_OUT_RUNTIME_SESSIONS,
  PCORE_QUERY_GOVERNANCE_CASES_BY_PERSONA,
  PCORE_CMD_CREATE_PERSONA,
  PCORE_CMD_CREATE_WALLET,
  PCORE_CMD_CREATE_KNOWLEDGE_ITEM,
  PCORE_CMD_ACTIVATE_PERSONA,
  PCORE_CMD_DEACTIVATE_PERSONA,
  PCORE_CMD_CREATE_TRANSFER,
  PCORE_CMD_APPROVE_TRANSFER,
  PCORE_CMD_TRANSFER_PERSONA_OWNER,
  PCORE_CMD_COMPLETE_TRANSFER,
  PCORE_CMD_UPSERT_PERSONA_DAILY_METRIC,
  PCORE_CMD_UPSERT_MARKETPLACE_DAILY_METRIC,
  PCORE_CMD_CREATE_FORK,
  PCORE_CMD_UPDATE_PERSONA_KNOWLEDGE_SYNC,
  PCORE_CMD_APPLY_GOVERNANCE_EVENT,
  PCORE_CMD_CREATE_WALLET_PAYOUT_REQUEST,
  PCORE_CMD_UPDATE_WALLET_BALANCE,
  PCORE_CMD_CREATE_WALLET_SETTLEMENT,
  PCORE_CMD_SETTLE_PERSONA_WALLET,
  PCORE_CMD_CREATE_TASK_APPLICATION,
  PCORE_CMD_CREATE_TASK_ASSIGNMENT,
  PCORE_CMD_MARK_TASK_APPLICATIONS_ASSIGNED,
  PCORE_CMD_ACCEPT_MARKETPLACE_TASK_ASSIGNMENT,
  PCORE_CMD_CREATE_RUNTIME_SESSION,
  PCORE_CMD_LINK_TASK_ASSIGNMENT_RUNTIME_SESSION,
  PCORE_CMD_PLAN_RUNTIME_SESSION,
  PCORE_CMD_EXECUTE_RUNTIME_SESSION,
  PCORE_CMD_START_TASK_ASSIGNMENT,
  PCORE_CMD_EVALUATE_RUNTIME_SESSION,
  PCORE_CMD_COMPLETE_RUNTIME_SESSION,
  PCORE_CMD_RETRY_RUNTIME_SESSION,
  PCORE_CMD_TIMEOUT_RUNTIME_SESSION,
  PCORE_CMD_CREATE_TASK_RESULT,
  PCORE_CMD_SUBMIT_TASK_ASSIGNMENT,
  PCORE_CMD_TOUCH_MARKETPLACE_TASK,
  PCORE_CMD_ACCEPT_TASK_RESULT,
  PCORE_CMD_ACCEPT_TASK_ASSIGNMENT,
  PCORE_CMD_COMPLETE_MARKETPLACE_TASK,
  PCORE_CMD_UPDATE_PERSONA_TASK_ACCEPTED,
  PCORE_CMD_REJECT_TASK_RESULT,
  PCORE_CMD_REJECT_TASK_ASSIGNMENT,
  PCORE_CMD_REJECT_TASK_APPLICATION,
  PCORE_CMD_REOPEN_MARKETPLACE_TASK,
  PCORE_CMD_DISPUTE_TASK_ASSIGNMENT,
  PCORE_CMD_DISPUTE_TASK_RESULT,
  PCORE_CMD_CREATE_GOVERNANCE_CASE,
  PCORE_CMD_CREATE_GOVERNANCE_ACTION,
  PCORE_CMD_UPDATE_GOVERNANCE_CASE_ACTION,
  PCORE_CMD_APPLY_GOVERNANCE_ACTION_TO_PERSONA,
  PCORE_CMD_APPEAL_GOVERNANCE_CASE,
  PCORE_QUERY_MARKETPLACE_TASKS_BY_TENANT,
  PCORE_QUERY_TASK_APPLICATIONS_BY_TASK,
  PCORE_QUERY_MARKETPLACE_TASK_BY_ID,
  PCORE_QUERY_PERSONA_EXISTS,
  PCORE_QUERY_FORK_EXISTS,
  PCORE_QUERY_TASK_ASSIGNMENT_BY_ID,
  PCORE_QUERY_LATEST_TASK_ASSIGNMENT_BY_TASK,
  PCORE_QUERY_LATEST_TASK_ASSIGNMENT_FOR_PERSONA_TASK,
  PCORE_QUERY_LATEST_TASK_RESULT_BY_ASSIGNMENT,
  PCORE_QUERY_GOVERNANCE_CASE_BY_ID,
  PCORE_QUERY_GOVERNANCE_ACTION_BY_ID,
  PCORE_QUERY_PERSONA_BY_ID,
  PCORE_QUERY_WALLET_BY_PERSONA_ID,
  PCORE_QUERY_WALLET_PAYOUT_REQUEST_BY_ID,
  PCORE_QUERY_WALLET_SETTLEMENT_BY_ASSIGNMENT_ID,
  PCORE_QUERY_TRANSFER_ACCESS,
  PCORE_QUERY_USER_EXISTS,
  PCORE_QUERY_RANKING_TASK_STATS,
  PCORE_QUERY_RANKING_TASK_STATS_UNCATEGORIZED,
  PCORE_QUERY_LAST_ACTIVE_AT,
  PCORE_CMD_PUBLISH_MARKETPLACE_TASK,
  PCORE_CMD_ACCEPT_MARKETPLACE_TASK_LEGACY,
  PCORE_CMD_COMPLETE_TASK_WALLET_UPDATE,
  PCORE_CMD_COMPLETE_TASK_PERSONA_UPDATE,
  PCORE_CMD_INSERT_WALLET_TRANSACTION,
  PCORE_CMD_INSERT_REPUTATION_HISTORY,
  PCORE_CMD_INSERT_GROWTH_EVENT,
  PCORE_CMD_INSERT_GOVERNANCE_EVENT,
  PCORE_CMD_INSERT_MEMORY,
} from '@chrono/kernel';
import type {
  PcorePersonaRow,
  PcorePersonaSummaryRow,
  PcoreForkRow,
  PcoreMemoryRow,
  PcoreKnowledgeRow,
  PcoreGrowthEventRow,
  PcoreGovernanceEventRow,
  PcoreMarketplaceTaskRow,
  PcoreTransferRow,
  PcoreReputationHistoryRow,
  PcoreCountRow,
  PcoreTotalRow,
  PcoreDailyPersonaRow,
  PcoreMarketplaceAnalyticsRow,
  PcoreDailyMarketplaceAnalyticsRow,
  PcoreEconomyAnalyticsRow,
  PcoreMemoryCountByKindRow,
  PcoreMemoryCountByRelationRow,
  PcoreMemoryNodeIdRow,
  PcoreMemoryEdgeRow,
  PcoreWalletRow,
  PcoreWalletForOwnerRow,
  PcoreWalletTransactionRow,
  PcoreTaskApplicationRow,
  PcoreTaskApplicantRow,
  PcoreTaskApplicationsByTaskParams,
  PcoreRuntimeSessionRow,
  PcoreGovernanceCaseRow,
  PcoreTaskAssignmentRow,
  PcoreTaskResultRow,
  PcoreGovernanceActionRow,
  PcoreWalletPayoutRequestRow,
  PcoreWalletSettlementRow,
  PcoreRankingTaskStatsRow,
  PcoreLastActiveAtRow,
  PcoreExistsRow,
  PcoreTenantOwnerParams,
  PcoreTenantPersonaParams,
  PcoreSummaryByOwnerParams,
  PcoreRecentMarketplaceTasksParams,
  PcoreTransferByPersonaIdParams,
  PcoreTransferByIdParams,
  PcoreCreatePersonaParams,
  PcoreCreateWalletParams,
  PcoreCreateKnowledgeItemParams,
  PcoreSetPersonaStatusParams,
  PcoreCreateTransferParams,
  PcoreApproveTransferParams,
  PcoreTransferPersonaOwnerParams,
  PcoreTaskCountByDateParams,
  PcoreRevenueByDateParams,
  PcoreDailyMarketplaceAnalyticsParams,
  PcoreUpsertPersonaDailyMetricParams,
  PcoreUpsertMarketplaceDailyMetricParams,
  PcoreCreateForkParams,
  PcorePersonaMemoriesParams,
  PcoreMemoryNodeIdsParams,
  PcoreMemoryEdgesParams,
  PcoreUpdatePersonaKnowledgeSyncParams,
  PcoreApplyGovernanceEventParams,
  PcoreWalletByIdParams,
  PcoreCreateWalletPayoutRequestParams,
  PcoreUpdateWalletBalanceParams,
  PcoreCreateWalletSettlementParams,
  PcoreSettlePersonaWalletParams,
  PcoreTaskApplicationParams,
  PcoreCreateTaskApplicationParams,
  PcoreCreateTaskAssignmentParams,
  PcoreMarkTaskApplicationsAssignedParams,
  PcoreAcceptMarketplaceTaskAssignmentParams,
  PcoreCreateRuntimeSessionParams,
  PcoreAssignmentRuntimeSessionParams,
  PcoreRuntimeSessionParams,
  PcorePlanRuntimeSessionParams,
  PcoreExecuteRuntimeSessionParams,
  PcoreStartTaskAssignmentParams,
  PcoreEvaluateRuntimeSessionParams,
  PcoreCompleteRuntimeSessionParams,
  PcoreTimedOutRuntimeSessionsParams,
  PcoreRetryRuntimeSessionParams,
  PcoreTimeoutRuntimeSessionParams,
  PcoreCreateTaskResultParams,
  PcoreTaskAssignmentIdParams,
  PcoreTouchMarketplaceTaskParams,
  PcoreAcceptTaskResultParams,
  PcoreCompleteMarketplaceTaskParams,
  PcoreUpdatePersonaTaskAcceptedParams,
  PcoreRejectTaskResultParams,
  PcoreRejectTaskApplicationParams,
  PcoreReopenMarketplaceTaskParams,
  PcoreDisputeTaskResultParams,
  PcoreCreateGovernanceCaseParams,
  PcoreCreateGovernanceActionParams,
  PcoreUpdateGovernanceCaseActionParams,
  PcoreApplyGovernanceActionToPersonaParams,
  PcoreAppealGovernanceCaseParams,
  PcoreMarketplaceTasksByTenantParams,
  PcoreMarketplaceTaskByIdParams,
  PcorePersonaExistsParams,
  PcoreForkExistsParams,
  PcoreTaskAssignmentByIdParams,
  PcoreLatestTaskAssignmentByTaskParams,
  PcoreLatestTaskAssignmentForPersonaTaskParams,
  PcoreLatestTaskResultByAssignmentParams,
  PcoreGovernanceCaseByIdParams,
  PcoreGovernanceActionByIdParams,
  PcorePersonaByIdParams,
  PcoreWalletPayoutRequestByIdParams,
  PcoreWalletSettlementByAssignmentIdParams,
  PcoreTransferAccessParams,
  PcoreUserExistsParams,
  PcoreRankingTaskStatsParams,
  PcoreLastActiveAtParams,
  PcorePublishMarketplaceTaskParams,
  PcoreAcceptMarketplaceTaskLegacyParams,
  PcoreCompleteTaskWalletUpdateParams,
  PcoreCompleteTaskPersonaUpdateParams,
  PcoreInsertWalletTransactionParams,
  PcoreInsertReputationHistoryParams,
  PcoreInsertGrowthEventParams,
  PcoreInsertGovernanceEventParams,
  PcoreInsertMemoryParams,
} from '@chrono/kernel';

const PERSONA_SUMMARY_SELECT = `SELECT
  pc.*,
  pw.id AS wallet_id,
  pw.wallet_address,
  pw.balance,
  pw.token_balance,
  pw.last_settled_at,
  pw.created_at AS wallet_created_at,
  pw.updated_at AS wallet_updated_at,
  (
    SELECT COUNT(*)
    FROM persona_forks pf
    WHERE pf.persona_id = pc.id AND pf.status = 'active'
  ) AS active_fork_count,
  (
    SELECT COUNT(*)
    FROM persona_memories pm
    WHERE pm.persona_id = pc.id
  ) AS memory_count,
  (
    SELECT COUNT(*)
    FROM persona_knowledge_items pk
    WHERE pk.persona_id = pc.id
  ) AS knowledge_count,
  (
    SELECT COUNT(*)
    FROM marketplace_tasks mt
    WHERE mt.assignee_persona_id = pc.id AND mt.status = 'accepted'
  ) AS active_task_count
FROM persona_core pc
INNER JOIN persona_wallets pw ON pw.persona_id = pc.id`;

function countRow(row: { count: number | bigint } | undefined): PcoreCountRow {
  return { count: Number(row?.count ?? 0) };
}

function totalRow(row: { total: number | bigint | null } | undefined): PcoreTotalRow {
  return { total: Number(row?.total ?? 0) };
}

export function registerPersonaCoreExecutors(): void {
  registerQuery<readonly PcorePersonaSummaryRow[], PcoreTenantOwnerParams>(PCORE_QUERY_SUMMARIES_BY_OWNER, (db, p) => {
    return db.prepare<PcorePersonaSummaryRow>(
      `${PERSONA_SUMMARY_SELECT}
       WHERE pc.tenant_id = ? AND pc.owner_user_id = ?
       ORDER BY pc.created_at DESC`,
    ).all(p.tenantId, p.ownerUserId).map((row) => ({
      ...row,
      active_fork_count: Number(row.active_fork_count),
      memory_count: Number(row.memory_count),
      knowledge_count: Number(row.knowledge_count),
      active_task_count: Number(row.active_task_count),
    }));
  });

  registerQuery<PcorePersonaSummaryRow | null, PcoreSummaryByOwnerParams>(PCORE_QUERY_SUMMARY_BY_OWNER, (db, p) => {
    const row = db.prepare<PcorePersonaSummaryRow>(
      `${PERSONA_SUMMARY_SELECT}
       WHERE pc.tenant_id = ? AND pc.owner_user_id = ? AND pc.id = ?
       LIMIT 1`,
    ).get(p.tenantId, p.ownerUserId, p.personaId);
    return row ? {
      ...row,
      active_fork_count: Number(row.active_fork_count),
      memory_count: Number(row.memory_count),
      knowledge_count: Number(row.knowledge_count),
      active_task_count: Number(row.active_task_count),
    } : null;
  });

  registerQuery<readonly PcoreForkRow[], PcoreTenantPersonaParams>(PCORE_QUERY_FORKS_BY_PERSONA, (db, p) => {
    return db.prepare<PcoreForkRow>(
      `SELECT * FROM persona_forks
       WHERE tenant_id = ? AND persona_id = ?
       ORDER BY created_at DESC`,
    ).all(p.tenantId, p.personaId);
  });

  registerQuery<readonly PcoreMemoryRow[], PcoreTenantPersonaParams>(PCORE_QUERY_RECENT_MEMORIES, (db, p) => {
    return db.prepare<PcoreMemoryRow>(
      `SELECT * FROM persona_memories
       WHERE tenant_id = ? AND persona_id = ?
       ORDER BY created_at DESC
       LIMIT 8`,
    ).all(p.tenantId, p.personaId);
  });

  registerQuery<readonly PcoreKnowledgeRow[], PcoreTenantPersonaParams>(PCORE_QUERY_RECENT_KNOWLEDGE, (db, p) => {
    return db.prepare<PcoreKnowledgeRow>(
      `SELECT * FROM persona_knowledge_items
       WHERE tenant_id = ? AND persona_id = ?
       ORDER BY updated_at DESC
       LIMIT 8`,
    ).all(p.tenantId, p.personaId);
  });

  registerQuery<readonly PcoreGrowthEventRow[], PcoreTenantPersonaParams>(PCORE_QUERY_RECENT_GROWTH_EVENTS, (db, p) => {
    return db.prepare<PcoreGrowthEventRow>(
      `SELECT * FROM persona_growth_events
       WHERE tenant_id = ? AND persona_id = ?
       ORDER BY created_at DESC
       LIMIT 8`,
    ).all(p.tenantId, p.personaId);
  });

  registerQuery<readonly PcoreGovernanceEventRow[], PcoreTenantPersonaParams>(PCORE_QUERY_RECENT_GOVERNANCE_EVENTS, (db, p) => {
    return db.prepare<PcoreGovernanceEventRow>(
      `SELECT * FROM persona_governance_events
       WHERE tenant_id = ? AND persona_id = ?
       ORDER BY created_at DESC
       LIMIT 8`,
    ).all(p.tenantId, p.personaId);
  });

  registerQuery<readonly PcoreMarketplaceTaskRow[], PcoreRecentMarketplaceTasksParams>(PCORE_QUERY_RECENT_MARKETPLACE_TASKS, (db, p) => {
    return db.prepare<PcoreMarketplaceTaskRow>(
      `SELECT
        mt.*,
        pc.display_name AS assignee_persona_name
      FROM marketplace_tasks mt
      LEFT JOIN persona_core pc ON pc.id = mt.assignee_persona_id
      WHERE mt.tenant_id = ? AND (mt.publisher_user_id = ? OR mt.assignee_persona_id = ?)
      ORDER BY mt.updated_at DESC
      LIMIT 12`,
    ).all(p.tenantId, p.ownerUserId, p.personaId);
  });

  registerQuery<PcoreTransferRow | null, PcoreTenantPersonaParams>(PCORE_QUERY_PENDING_TRANSFER, (db, p) => {
    return db.prepare<PcoreTransferRow>(
      `SELECT * FROM persona_transfers
       WHERE tenant_id = ? AND persona_id = ? AND status = 'pending_review'
       ORDER BY requested_at DESC
       LIMIT 1`,
    ).get(p.tenantId, p.personaId) ?? null;
  });

  registerQuery<PcoreTransferRow | null, PcoreTransferByPersonaIdParams>(PCORE_QUERY_TRANSFER_BY_PERSONA_ID, (db, p) => {
    return db.prepare<PcoreTransferRow>(
      `SELECT * FROM persona_transfers
       WHERE tenant_id = ? AND persona_id = ? AND id = ?
       LIMIT 1`,
    ).get(p.tenantId, p.personaId, p.transferId) ?? null;
  });

  registerQuery<PcoreTransferRow | null, PcoreTransferByIdParams>(PCORE_QUERY_TRANSFER_BY_ID, (db, p) => {
    return db.prepare<PcoreTransferRow>(
      'SELECT * FROM persona_transfers WHERE tenant_id = ? AND id = ? LIMIT 1',
    ).get(p.tenantId, p.transferId) ?? null;
  });

  registerQuery<readonly PcoreTransferRow[], PcoreTenantPersonaParams>(PCORE_QUERY_TRANSFERS_BY_PERSONA, (db, p) => {
    return db.prepare<PcoreTransferRow>(
      `SELECT * FROM persona_transfers
       WHERE tenant_id = ? AND persona_id = ?
       ORDER BY requested_at DESC`,
    ).all(p.tenantId, p.personaId);
  });

  registerQuery<PcoreCountRow | null, PcoreTenantPersonaParams>(PCORE_QUERY_COMPLETED_TASK_COUNT, (db, p) => {
    return countRow(db.prepare<{ count: number | bigint }>(
      `SELECT COUNT(*) AS count
       FROM marketplace_tasks
       WHERE tenant_id = ? AND assignee_persona_id = ? AND status = 'completed'`,
    ).get(p.tenantId, p.personaId));
  });

  registerQuery<PcoreCountRow | null, PcoreTenantPersonaParams>(PCORE_QUERY_GOVERNANCE_PENALTY_COUNT, (db, p) => {
    return countRow(db.prepare<{ count: number | bigint }>(
      `SELECT COUNT(*) AS count
       FROM persona_governance_events
       WHERE tenant_id = ? AND persona_id = ? AND event_type IN ('warning','restriction','death')`,
    ).get(p.tenantId, p.personaId));
  });

  registerQuery<readonly PcoreReputationHistoryRow[], PcoreTenantPersonaParams>(PCORE_QUERY_REPUTATION_HISTORY, (db, p) => {
    return db.prepare<PcoreReputationHistoryRow>(
      `SELECT * FROM reputation_history
       WHERE tenant_id = ? AND persona_id = ?
       ORDER BY created_at DESC
       LIMIT 50`,
    ).all(p.tenantId, p.personaId);
  });

  registerQuery<readonly PcorePersonaSummaryRow[], string>(PCORE_QUERY_ACTIVE_PERSONAS_FOR_RANKING, (db, tenantId) => {
    return db.prepare<PcorePersonaSummaryRow>(
      `SELECT
        pc.*,
        pw.id AS wallet_id,
        pw.wallet_address,
        pw.balance,
        pw.token_balance,
        pw.last_settled_at,
        pw.created_at AS wallet_created_at,
        pw.updated_at AS wallet_updated_at,
        0 AS active_fork_count,
        0 AS memory_count,
        0 AS knowledge_count,
        0 AS active_task_count
      FROM persona_core pc
      INNER JOIN persona_wallets pw ON pw.persona_id = pc.id
      WHERE pc.tenant_id = ? AND COALESCE(pc.lifecycle_status, pc.status) = 'active'
      ORDER BY pc.updated_at DESC`,
    ).all(tenantId).map((row) => ({
      ...row,
      active_fork_count: Number(row.active_fork_count),
      memory_count: Number(row.memory_count),
      knowledge_count: Number(row.knowledge_count),
      active_task_count: Number(row.active_task_count),
    }));
  });

  registerQuery<PcoreCountRow | null, PcoreTenantPersonaParams>(PCORE_QUERY_MEMORY_COUNT, (db, p) => {
    return countRow(db.prepare<{ count: number | bigint }>(
      'SELECT COUNT(*) AS count FROM persona_memories WHERE tenant_id = ? AND persona_id = ?',
    ).get(p.tenantId, p.personaId));
  });

  registerQuery<PcoreCountRow | null, PcoreTenantPersonaParams>(PCORE_QUERY_GOVERNANCE_EVENT_COUNT, (db, p) => {
    return countRow(db.prepare<{ count: number | bigint }>(
      'SELECT COUNT(*) AS count FROM persona_governance_events WHERE tenant_id = ? AND persona_id = ?',
    ).get(p.tenantId, p.personaId));
  });

  registerQuery<PcoreMarketplaceAnalyticsRow | null, string>(PCORE_QUERY_MARKETPLACE_ANALYTICS, (db, tenantId) => {
    const completedSinceMs = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const openTasks = countRow(db.prepare<{ count: number | bigint }>(
      `SELECT COUNT(*) AS count
       FROM marketplace_tasks
       WHERE tenant_id = ? AND status = 'open'`,
    ).get(tenantId)).count;
    const activePersonas = countRow(db.prepare<{ count: number | bigint }>(
      `SELECT COUNT(*) AS count
       FROM persona_core
       WHERE tenant_id = ? AND COALESCE(lifecycle_status, status) = 'active'`,
    ).get(tenantId)).count;
    const completedTasks7d = countRow(db.prepare<{ count: number | bigint }>(
      `SELECT COUNT(*) AS count
       FROM marketplace_tasks
       WHERE tenant_id = ? AND status = 'completed' AND completed_at >= ?`,
    ).get(tenantId, completedSinceMs)).count;
    const grossVolume = totalRow(db.prepare<{ total: number | bigint | null }>(
      `SELECT SUM(reward) AS total
       FROM marketplace_tasks
       WHERE tenant_id = ? AND status = 'completed'`,
    ).get(tenantId)).total;
    return {
      open_tasks: openTasks,
      active_personas: activePersonas,
      completed_tasks_7d: completedTasks7d,
      gross_volume: grossVolume,
    };
  });

  registerQuery<readonly PcoreDailyPersonaRow[], string>(PCORE_QUERY_DAILY_PERSONAS, (db, tenantId) => {
    return db.prepare<PcoreDailyPersonaRow>(
      `SELECT id, reputation, growth_index
       FROM persona_core
       WHERE tenant_id = ?`,
    ).all(tenantId);
  });

  registerQuery<PcoreCountRow | null, PcoreTaskCountByDateParams>(PCORE_QUERY_DAILY_COMPLETED_TASK_COUNT, (db, p) => {
    return countRow(db.prepare<{ count: number | bigint }>(
      `SELECT COUNT(*) AS count
       FROM marketplace_tasks
       WHERE tenant_id = ? AND assignee_persona_id = ? AND status = 'completed' AND completed_at >= ? AND completed_at < ?`,
    ).get(p.tenantId, p.personaId, p.startMs, p.endMs));
  });

  registerQuery<PcoreTotalRow | null, PcoreRevenueByDateParams>(PCORE_QUERY_DAILY_PERSONA_REVENUE, (db, p) => {
    return totalRow(db.prepare<{ total: number | bigint | null }>(
      `SELECT SUM(ws.owner_amount_minor) AS total
       FROM wallet_settlements ws
       INNER JOIN persona_wallets pw ON pw.id = ws.wallet_id
       WHERE ws.tenant_id = ? AND pw.persona_id = ? AND ws.completed_at >= ? AND ws.completed_at < ?`,
    ).get(p.tenantId, p.personaId, p.startMs, p.endMs));
  });

  registerQuery<PcoreDailyMarketplaceAnalyticsRow | null, PcoreDailyMarketplaceAnalyticsParams>(PCORE_QUERY_DAILY_MARKETPLACE_ANALYTICS, (db, p) => {
    const openTasks = countRow(db.prepare<{ count: number | bigint }>(
      `SELECT COUNT(*) AS count
       FROM marketplace_tasks
       WHERE tenant_id = ? AND status = 'open'`,
    ).get(p.tenantId)).count;
    const completedTasks = countRow(db.prepare<{ count: number | bigint }>(
      `SELECT COUNT(*) AS count
       FROM marketplace_tasks
       WHERE tenant_id = ? AND status = 'completed' AND completed_at >= ? AND completed_at < ?`,
    ).get(p.tenantId, p.startMs, p.endMs)).count;
    const grossVolume = totalRow(db.prepare<{ total: number | bigint | null }>(
      `SELECT SUM(total_amount_minor) AS total
       FROM wallet_settlements
       WHERE tenant_id = ? AND completed_at >= ? AND completed_at < ?`,
    ).get(p.tenantId, p.startMs, p.endMs)).total;
    const activePersonas = countRow(db.prepare<{ count: number | bigint }>(
      `SELECT COUNT(*) AS count
       FROM persona_core
       WHERE tenant_id = ? AND COALESCE(lifecycle_status, status) = 'active'`,
    ).get(p.tenantId)).count;
    return {
      open_tasks: openTasks,
      completed_tasks: completedTasks,
      gross_volume: grossVolume,
      active_personas: activePersonas,
    };
  });

  registerQuery<PcoreEconomyAnalyticsRow | null, string>(PCORE_QUERY_ECONOMY_ANALYTICS, (db, tenantId) => {
    const grossRevenueMinor = totalRow(db.prepare<{ total: number | bigint | null }>(
      'SELECT SUM(total_amount_minor) AS total FROM wallet_settlements WHERE tenant_id = ?',
    ).get(tenantId)).total;
    const ownerPayoutsMinor = totalRow(db.prepare<{ total: number | bigint | null }>(
      `SELECT ABS(SUM(amount_minor)) AS total
       FROM wallet_transactions
       WHERE tenant_id = ? AND transaction_type = 'owner_payout'`,
    ).get(tenantId)).total;
    const platformFeesMinor = totalRow(db.prepare<{ total: number | bigint | null }>(
      `SELECT ABS(SUM(amount_minor)) AS total
       FROM wallet_transactions
       WHERE tenant_id = ? AND transaction_type = 'platform_fee'`,
    ).get(tenantId)).total;
    const personaReservesMinor = totalRow(db.prepare<{ total: number | bigint | null }>(
      `SELECT ABS(SUM(amount_minor)) AS total
       FROM wallet_transactions
       WHERE tenant_id = ? AND transaction_type = 'persona_reserve'`,
    ).get(tenantId)).total;
    const payoutRequests = countRow(db.prepare<{ count: number | bigint }>(
      'SELECT COUNT(*) AS count FROM wallet_payout_requests WHERE tenant_id = ?',
    ).get(tenantId)).count;
    const settlementCount = countRow(db.prepare<{ count: number | bigint }>(
      'SELECT COUNT(*) AS count FROM wallet_settlements WHERE tenant_id = ?',
    ).get(tenantId)).count;
    const transactionCount = countRow(db.prepare<{ count: number | bigint }>(
      'SELECT COUNT(*) AS count FROM wallet_transactions WHERE tenant_id = ?',
    ).get(tenantId)).count;
    return {
      gross_revenue_minor: grossRevenueMinor,
      owner_payouts_minor: ownerPayoutsMinor,
      platform_fees_minor: platformFeesMinor,
      persona_reserves_minor: personaReservesMinor,
      payout_requests: payoutRequests,
      settlement_count: settlementCount,
      transaction_count: transactionCount,
    };
  });

  registerQuery<readonly PcoreMemoryRow[], PcorePersonaMemoriesParams>(PCORE_QUERY_PERSONA_MEMORIES, (db, p) => {
    const whereParts = ['tenant_id = ?', 'persona_id = ?'];
    const params: Array<string | number> = [p.tenantId, p.personaId];
    if (p.kind) {
      whereParts.push('kind = ?');
      params.push(p.kind);
    }
    if (p.cursor) {
      whereParts.push('created_at < ?');
      params.push(p.cursor);
    }
    params.push(p.limit);
    return db.prepare<PcoreMemoryRow>(
      `SELECT * FROM persona_memories
       WHERE ${whereParts.join(' AND ')}
       ORDER BY created_at DESC
       LIMIT ?`,
    ).all(...params);
  });

  registerQuery<readonly PcoreMemoryCountByKindRow[], PcoreTenantPersonaParams>(PCORE_QUERY_MEMORY_KIND_COUNTS, (db, p) => {
    return db.prepare<PcoreMemoryCountByKindRow>(
      `SELECT kind, COUNT(*) AS count
       FROM persona_memory_nodes
       WHERE tenant_id = ? AND persona_id = ?
       GROUP BY kind`,
    ).all(p.tenantId, p.personaId).map((row) => ({ ...row, count: Number(row.count) }));
  });

  registerQuery<readonly PcoreMemoryCountByRelationRow[], PcoreTenantPersonaParams>(PCORE_QUERY_MEMORY_RELATION_COUNTS, (db, p) => {
    return db.prepare<PcoreMemoryCountByRelationRow>(
      `SELECT relation, COUNT(*) AS count
       FROM persona_memory_edges
       WHERE tenant_id = ? AND persona_id = ?
       GROUP BY relation`,
    ).all(p.tenantId, p.personaId).map((row) => ({ ...row, count: Number(row.count) }));
  });

  registerQuery<readonly PcoreMemoryNodeIdRow[], PcoreMemoryNodeIdsParams>(PCORE_QUERY_MEMORY_NODE_IDS, (db, p) => {
    const whereParts = ['tenant_id = ?', 'persona_id = ?'];
    const params: Array<string | number> = [p.tenantId, p.personaId];
    if (p.memoryId) {
      whereParts.push('id = ?');
      params.push(p.memoryId);
    }
    if (p.kind) {
      whereParts.push('kind = ?');
      params.push(p.kind);
    }
    params.push(p.limit);
    return db.prepare<PcoreMemoryNodeIdRow>(
      `SELECT id FROM persona_memory_nodes
       WHERE ${whereParts.join(' AND ')}
       ORDER BY created_at DESC
       LIMIT ?`,
    ).all(...params);
  });

  registerQuery<readonly PcoreMemoryEdgeRow[], PcoreMemoryEdgesParams>(PCORE_QUERY_MEMORY_EDGES, (db, p) => {
    if (p.nodeIds.length === 0) return [];
    const placeholders = p.nodeIds.map(() => '?').join(',');
    const whereParts = [
      'tenant_id = ?',
      'persona_id = ?',
      `(source IN (${placeholders}) OR target IN (${placeholders}))`,
    ];
    const params: Array<string | number> = [p.tenantId, p.personaId, ...p.nodeIds, ...p.nodeIds];
    if (p.relation) {
      whereParts.push('relation = ?');
      params.push(p.relation);
    }
    return db.prepare<PcoreMemoryEdgeRow>(
      `SELECT * FROM persona_memory_edges
       WHERE ${whereParts.join(' AND ')}
       ORDER BY strength DESC`,
    ).all(...params).map((row) => ({ ...row, strength: Number(row.strength) }));
  });

  registerQuery<PcoreWalletRow | null, PcoreTenantPersonaParams>(PCORE_QUERY_WALLET_BY_PERSONA, (db, p) => {
    return db.prepare<PcoreWalletRow>(
      `SELECT * FROM persona_wallets WHERE tenant_id = ? AND persona_id = ? LIMIT 1`,
    ).get(p.tenantId, p.personaId) ?? null;
  });

  registerQuery<PcoreWalletForOwnerRow | null, PcoreWalletByIdParams>(PCORE_QUERY_WALLET_BY_ID_FOR_OWNER, (db, p) => {
    return db.prepare<PcoreWalletForOwnerRow>(
      `SELECT pw.*, pc.owner_user_id
       FROM persona_wallets pw
       INNER JOIN persona_core pc ON pc.id = pw.persona_id
       WHERE pw.tenant_id = ? AND pw.id = ?
       LIMIT 1`,
    ).get(p.tenantId, p.walletId) ?? null;
  });

  registerQuery<readonly PcoreWalletTransactionRow[], PcoreWalletByIdParams>(PCORE_QUERY_WALLET_TRANSACTIONS, (db, p) => {
    return db.prepare<PcoreWalletTransactionRow>(
      `SELECT * FROM wallet_transactions
       WHERE tenant_id = ? AND wallet_id = ?
       ORDER BY created_at DESC`,
    ).all(p.tenantId, p.walletId);
  });

  registerQuery<PcoreTaskApplicationRow | null, PcoreTaskApplicationParams>(PCORE_QUERY_TASK_APPLICATION, (db, p) => {
    return db.prepare<PcoreTaskApplicationRow>(
      `SELECT * FROM task_applications
       WHERE tenant_id = ? AND task_id = ? AND persona_id = ?
       LIMIT 1`,
    ).get(p.tenantId, p.taskId, p.personaId) ?? null;
  });

  /* 列某工单的全部 persona 申请者（含 persona display_name）——发布者看名字选委派给谁。确定性排序：分降序、创建升序。 */
  registerQuery<readonly PcoreTaskApplicantRow[], PcoreTaskApplicationsByTaskParams>(PCORE_QUERY_TASK_APPLICATIONS_BY_TASK, (db, p) => {
    return db.prepare<PcoreTaskApplicantRow>(
      `SELECT ta.*, pc.display_name AS persona_name
       FROM task_applications ta
       LEFT JOIN persona_core pc ON pc.id = ta.persona_id
       WHERE ta.tenant_id = ? AND ta.task_id = ?
       ORDER BY ta.ranking_score DESC, ta.created_at ASC, ta.id ASC`,
    ).all(p.tenantId, p.taskId);
  });

  registerQuery<PcoreRuntimeSessionRow | null, PcoreRuntimeSessionParams>(PCORE_QUERY_RUNTIME_SESSION, (db, p) => {
    return db.prepare<PcoreRuntimeSessionRow>(
      'SELECT * FROM runtime_sessions WHERE tenant_id = ? AND id = ? LIMIT 1',
    ).get(p.tenantId, p.sessionId) ?? null;
  });

  registerQuery<readonly PcoreRuntimeSessionRow[], PcoreTimedOutRuntimeSessionsParams>(PCORE_QUERY_TIMED_OUT_RUNTIME_SESSIONS, (db, p) => {
    return db.prepare<PcoreRuntimeSessionRow>(
      `SELECT * FROM runtime_sessions
       WHERE timeout_at IS NOT NULL
         AND timeout_at <= ?
         AND completed_at IS NULL
       ORDER BY timeout_at ASC
       LIMIT ?`,
    ).all(p.now, p.limit);
  });

  registerQuery<readonly PcoreGovernanceCaseRow[], PcoreTenantPersonaParams>(PCORE_QUERY_GOVERNANCE_CASES_BY_PERSONA, (db, p) => {
    return db.prepare<PcoreGovernanceCaseRow>(
      `SELECT * FROM governance_cases
       WHERE tenant_id = ? AND persona_id = ?
       ORDER BY opened_at DESC`,
    ).all(p.tenantId, p.personaId);
  });

  registerCommand<PcoreCreatePersonaParams>(PCORE_CMD_CREATE_PERSONA, (db, p) => {
    const result = db.prepare<void>(
      `INSERT INTO persona_core (
        id, tenant_id, owner_user_id, display_name, profile_json, status, visibility,
        growth_index, reputation, training_investment, created_at, updated_at, deceased_at, transferred_at, lifecycle_status
      ) VALUES (?, ?, ?, ?, ?, 'active', ?, 0, ?, 0, ?, ?, NULL, NULL, 'active')`,
    ).run(p.id, p.tenantId, p.ownerUserId, p.displayName, p.profileJson, p.visibility, p.reputation, p.now, p.now);
    return { rowsAffected: result.changes };
  });

  registerCommand<PcoreCreateWalletParams>(PCORE_CMD_CREATE_WALLET, (db, p) => {
    const result = db.prepare<void>(
      `INSERT INTO persona_wallets (
        id, tenant_id, persona_id, wallet_address, balance, token_balance, last_settled_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 0, 0, NULL, ?, ?)`,
    ).run(p.id, p.tenantId, p.personaId, p.walletAddress, p.now, p.now);
    return { rowsAffected: result.changes };
  });

  registerCommand<PcoreCreateKnowledgeItemParams>(PCORE_CMD_CREATE_KNOWLEDGE_ITEM, (db, p) => {
    const result = db.prepare<void>(
      `INSERT INTO persona_knowledge_items (
        id, tenant_id, persona_id, title, content, source, tags_json, confidence, fingerprint, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(p.id, p.tenantId, p.personaId, p.title, p.content, p.source, p.tagsJson, p.confidence, p.fingerprint ?? null, p.now, p.now);
    return { rowsAffected: result.changes };
  });

  registerCommand<PcoreSetPersonaStatusParams>(PCORE_CMD_ACTIVATE_PERSONA, (db, p) => {
    const result = db.prepare<void>(
      `UPDATE persona_core
       SET lifecycle_status = 'active', status = CASE WHEN status = 'transferred' THEN 'active' ELSE status END, updated_at = ?
       WHERE tenant_id = ? AND id = ?`,
    ).run(p.now, p.tenantId, p.personaId);
    return { rowsAffected: result.changes };
  });

  registerCommand<PcoreSetPersonaStatusParams>(PCORE_CMD_DEACTIVATE_PERSONA, (db, p) => {
    const result = db.prepare<void>(
      `UPDATE persona_core
       SET lifecycle_status = 'dormant', updated_at = ?
       WHERE tenant_id = ? AND id = ?`,
    ).run(p.now, p.tenantId, p.personaId);
    return { rowsAffected: result.changes };
  });

  registerCommand<PcoreCreateTransferParams>(PCORE_CMD_CREATE_TRANSFER, (db, p) => {
    const result = db.prepare<void>(
      `INSERT INTO persona_transfers (
        id, tenant_id, persona_id, from_owner_user_id, to_owner_user_id, status, reason, requested_at, approved_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, 'pending_review', ?, ?, NULL, NULL)`,
    ).run(p.id, p.tenantId, p.personaId, p.fromOwnerUserId, p.toOwnerUserId, p.reason, p.now);
    return { rowsAffected: result.changes };
  });

  registerCommand<PcoreApproveTransferParams>(PCORE_CMD_APPROVE_TRANSFER, (db, p) => {
    const result = db.prepare<void>(
      `UPDATE persona_transfers
       SET status = 'approved', approved_at = ?
       WHERE tenant_id = ? AND id = ? AND status = 'pending_review'`,
    ).run(p.now, p.tenantId, p.transferId);
    return { rowsAffected: result.changes };
  });

  registerCommand<PcoreTransferPersonaOwnerParams>(PCORE_CMD_TRANSFER_PERSONA_OWNER, (db, p) => {
    const result = db.prepare<void>(
      `UPDATE persona_core
       SET owner_user_id = ?, status = 'active', lifecycle_status = 'active', transferred_at = ?, updated_at = ?
       WHERE tenant_id = ? AND id = ?`,
    ).run(p.ownerUserId, p.now, p.now, p.tenantId, p.personaId);
    return { rowsAffected: result.changes };
  });

  registerCommand<PcoreApproveTransferParams>(PCORE_CMD_COMPLETE_TRANSFER, (db, p) => {
    const result = db.prepare<void>(
      `UPDATE persona_transfers
       SET status = 'completed', completed_at = ?
       WHERE tenant_id = ? AND id = ?`,
    ).run(p.now, p.tenantId, p.transferId);
    return { rowsAffected: result.changes };
  });

  registerCommand<PcoreUpsertPersonaDailyMetricParams>(PCORE_CMD_UPSERT_PERSONA_DAILY_METRIC, (db, p) => {
    const result = db.prepare<void>(
      `INSERT INTO persona_daily_metrics (
        tenant_id, persona_id, metric_date, tasks_completed, revenue, reputation_score, growth_index
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(tenant_id, persona_id, metric_date) DO UPDATE SET
        tasks_completed = excluded.tasks_completed,
        revenue = excluded.revenue,
        reputation_score = excluded.reputation_score,
        growth_index = excluded.growth_index`,
    ).run(p.tenantId, p.personaId, p.metricDate, p.tasksCompleted, p.revenue, p.reputationScore, p.growthIndex);
    return { rowsAffected: result.changes };
  });

  registerCommand<PcoreUpsertMarketplaceDailyMetricParams>(PCORE_CMD_UPSERT_MARKETPLACE_DAILY_METRIC, (db, p) => {
    const result = db.prepare<void>(
      `INSERT INTO marketplace_daily_metrics (
        tenant_id, metric_date, open_tasks, completed_tasks, gross_volume, active_personas
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(tenant_id, metric_date) DO UPDATE SET
        open_tasks = excluded.open_tasks,
        completed_tasks = excluded.completed_tasks,
        gross_volume = excluded.gross_volume,
        active_personas = excluded.active_personas`,
    ).run(p.tenantId, p.metricDate, p.openTasks, p.completedTasks, p.grossVolume, p.activePersonas);
    return { rowsAffected: result.changes };
  });

  registerCommand<PcoreCreateForkParams>(PCORE_CMD_CREATE_FORK, (db, p) => {
    const result = db.prepare<void>(
      `INSERT INTO persona_forks (
        id, tenant_id, persona_id, label, fork_type, status, sync_mode, experience_factor, created_at, updated_at, recycled_at
      ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, NULL)`,
    ).run(p.id, p.tenantId, p.personaId, p.label, p.forkType, p.syncMode, p.experienceFactor, p.now, p.now);
    return { rowsAffected: result.changes };
  });

  registerCommand<PcoreUpdatePersonaKnowledgeSyncParams>(PCORE_CMD_UPDATE_PERSONA_KNOWLEDGE_SYNC, (db, p) => {
    const result = db.prepare<void>(
      `UPDATE persona_core
       SET growth_index = growth_index + ?, reputation = reputation + ?, updated_at = ?
       WHERE tenant_id = ? AND id = ?`,
    ).run(p.growthDelta, p.reputationDelta, p.now, p.tenantId, p.personaId);
    return { rowsAffected: result.changes };
  });

  registerCommand<PcoreApplyGovernanceEventParams>(PCORE_CMD_APPLY_GOVERNANCE_EVENT, (db, p) => {
    const sets = ['reputation = reputation + ?', 'growth_index = growth_index + ?', 'updated_at = ?'];
    const params: Array<string | number | null> = [p.reputationDelta, p.growthDelta, p.now];
    if (p.nextStatus && p.legacyStatus) {
      sets.push('lifecycle_status = ?', 'status = ?');
      params.push(p.nextStatus, p.legacyStatus);
      if (p.nextStatus === 'deceased') {
        sets.push('deceased_at = ?');
        params.push(p.now);
      }
      if (p.nextStatus === 'transferred') {
        sets.push('transferred_at = ?');
        params.push(p.now);
      }
    }
    params.push(p.tenantId, p.personaId);
    const result = db.prepare<void>(
      `UPDATE persona_core SET ${sets.join(', ')} WHERE tenant_id = ? AND id = ?`,
    ).run(...params);
    return { rowsAffected: result.changes };
  });

  registerCommand<PcoreCreateWalletPayoutRequestParams>(PCORE_CMD_CREATE_WALLET_PAYOUT_REQUEST, (db, p) => {
    const result = db.prepare<void>(
      `INSERT INTO wallet_payout_requests (
        id, tenant_id, wallet_id, amount_minor, currency, status,
        requested_by_user_id, created_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, 'completed', ?, ?, ?)`,
    ).run(p.id, p.tenantId, p.walletId, p.amountMinor, p.currency, p.requestedByUserId, p.now, p.now);
    return { rowsAffected: result.changes };
  });

  registerCommand<PcoreUpdateWalletBalanceParams>(PCORE_CMD_UPDATE_WALLET_BALANCE, (db, p) => {
    const result = db.prepare<void>(
      `UPDATE persona_wallets
       SET balance = ?, updated_at = ?
       WHERE tenant_id = ? AND id = ?`,
    ).run(p.balance, p.now, p.tenantId, p.walletId);
    return { rowsAffected: result.changes };
  });

  registerCommand<PcoreCreateWalletSettlementParams>(PCORE_CMD_CREATE_WALLET_SETTLEMENT, (db, p) => {
    const result = db.prepare<void>(
      `INSERT INTO wallet_settlements (
        id, tenant_id, wallet_id, task_id, assignment_id, total_amount_minor, currency,
        owner_pct, persona_pct, platform_pct,
        owner_amount_minor, persona_amount_minor, platform_amount_minor,
        status, created_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'completed', ?, ?)`,
    ).run(
      p.id,
      p.tenantId,
      p.walletId,
      p.taskId,
      p.assignmentId,
      p.totalAmountMinor,
      p.currency,
      p.ownerPct,
      p.personaPct,
      p.platformPct,
      p.ownerAmountMinor,
      p.personaAmountMinor,
      p.platformAmountMinor,
      p.now,
      p.now,
    );
    return { rowsAffected: result.changes };
  });

  registerCommand<PcoreSettlePersonaWalletParams>(PCORE_CMD_SETTLE_PERSONA_WALLET, (db, p) => {
    const result = db.prepare<void>(
      `UPDATE persona_wallets
       SET balance = balance + ?, token_balance = token_balance + ?, currency = ?, last_settled_at = ?, updated_at = ?
       WHERE tenant_id = ? AND id = ?`,
    ).run(p.ownerAmount, p.personaAmount, p.currency, p.now, p.now, p.tenantId, p.walletId);
    return { rowsAffected: result.changes };
  });

  registerCommand<PcoreCreateTaskApplicationParams>(PCORE_CMD_CREATE_TASK_APPLICATION, (db, p) => {
    const result = db.prepare<void>(
      `INSERT INTO task_applications (
        id, tenant_id, task_id, persona_id, ranking_score, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'submitted', ?, ?)`,
    ).run(p.id, p.tenantId, p.taskId, p.personaId, p.rankingScore, p.now, p.now);
    return { rowsAffected: result.changes };
  });

  registerCommand<PcoreCreateTaskAssignmentParams>(PCORE_CMD_CREATE_TASK_ASSIGNMENT, (db, p) => {
    const result = db.prepare<void>(
      `INSERT INTO task_assignments (
        id, tenant_id, task_id, persona_id, application_id, runtime_session_id, status,
        assigned_at, started_at, submitted_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, NULL, 'assigned', ?, NULL, NULL, NULL)`,
    ).run(p.id, p.tenantId, p.taskId, p.personaId, p.applicationId, p.now);
    return { rowsAffected: result.changes };
  });

  registerCommand<PcoreMarkTaskApplicationsAssignedParams>(PCORE_CMD_MARK_TASK_APPLICATIONS_ASSIGNED, (db, p) => {
    const result = db.prepare<void>(
      `UPDATE task_applications
       SET status = CASE WHEN id = ? THEN 'assigned' ELSE status END,
           updated_at = ?
       WHERE tenant_id = ? AND task_id = ?`,
    ).run(p.applicationId, p.now, p.tenantId, p.taskId);
    return { rowsAffected: result.changes };
  });

  registerCommand<PcoreAcceptMarketplaceTaskAssignmentParams>(PCORE_CMD_ACCEPT_MARKETPLACE_TASK_ASSIGNMENT, (db, p) => {
    const result = db.prepare<void>(
      `UPDATE marketplace_tasks
       SET status = 'accepted', assignee_persona_id = ?, accepted_at = ?, updated_at = ?
       WHERE tenant_id = ? AND id = ? AND status = 'open'`,
    ).run(p.personaId, p.now, p.now, p.tenantId, p.taskId);
    return { rowsAffected: result.changes };
  });

  registerCommand<PcoreCreateRuntimeSessionParams>(PCORE_CMD_CREATE_RUNTIME_SESSION, (db, p) => {
    const result = db.prepare<void>(
      `INSERT INTO runtime_sessions (
        id, tenant_id, persona_id, task_id, assignment_id, state, retry_count, timeout_at,
        plan_json, artifacts_json, evaluation_json, result_summary_json, error_json,
        created_at, updated_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, 'PLAN', 0, ?, NULL, '[]', NULL, NULL, NULL, ?, ?, NULL)`,
    ).run(p.id, p.tenantId, p.personaId, p.taskId, p.assignmentId, p.timeoutAt, p.now, p.now);
    return { rowsAffected: result.changes };
  });

  registerCommand<PcoreAssignmentRuntimeSessionParams>(PCORE_CMD_LINK_TASK_ASSIGNMENT_RUNTIME_SESSION, (db, p) => {
    const result = db.prepare<void>(
      `UPDATE task_assignments
       SET runtime_session_id = ?
       WHERE tenant_id = ? AND id = ?`,
    ).run(p.sessionId, p.tenantId, p.assignmentId);
    return { rowsAffected: result.changes };
  });

  registerCommand<PcorePlanRuntimeSessionParams>(PCORE_CMD_PLAN_RUNTIME_SESSION, (db, p) => {
    const result = db.prepare<void>(
      `UPDATE runtime_sessions
       SET state = 'EXECUTE', plan_json = ?, updated_at = ?, timeout_at = ?
       WHERE tenant_id = ? AND id = ?`,
    ).run(p.planJson, p.now, p.timeoutAt, p.tenantId, p.sessionId);
    return { rowsAffected: result.changes };
  });

  registerCommand<PcoreExecuteRuntimeSessionParams>(PCORE_CMD_EXECUTE_RUNTIME_SESSION, (db, p) => {
    const result = db.prepare<void>(
      `UPDATE runtime_sessions
       SET state = 'EVALUATE', artifacts_json = ?, updated_at = ?, timeout_at = ?
       WHERE tenant_id = ? AND id = ?`,
    ).run(p.artifactsJson, p.now, p.timeoutAt, p.tenantId, p.sessionId);
    return { rowsAffected: result.changes };
  });

  registerCommand<PcoreStartTaskAssignmentParams>(PCORE_CMD_START_TASK_ASSIGNMENT, (db, p) => {
    const result = db.prepare<void>(
      `UPDATE task_assignments
       SET status = 'in_progress',
           started_at = COALESCE(started_at, ?)
       WHERE tenant_id = ? AND id = ? AND status IN ('assigned','in_progress')`,
    ).run(p.now, p.tenantId, p.assignmentId);
    return { rowsAffected: result.changes };
  });

  registerCommand<PcoreEvaluateRuntimeSessionParams>(PCORE_CMD_EVALUATE_RUNTIME_SESSION, (db, p) => {
    const result = db.prepare<void>(
      `UPDATE runtime_sessions
       SET state = 'MEMORY_UPDATE', evaluation_json = ?, updated_at = ?, timeout_at = ?
       WHERE tenant_id = ? AND id = ?`,
    ).run(p.evaluationJson, p.now, p.timeoutAt, p.tenantId, p.sessionId);
    return { rowsAffected: result.changes };
  });

  registerCommand<PcoreCompleteRuntimeSessionParams>(PCORE_CMD_COMPLETE_RUNTIME_SESSION, (db, p) => {
    const result = db.prepare<void>(
      `UPDATE runtime_sessions
       SET state = 'COMPLETED', result_summary_json = ?, updated_at = ?, completed_at = ?, timeout_at = NULL
       WHERE tenant_id = ? AND id = ?`,
    ).run(p.resultSummaryJson, p.now, p.now, p.tenantId, p.sessionId);
    return { rowsAffected: result.changes };
  });

  registerCommand<PcoreRetryRuntimeSessionParams>(PCORE_CMD_RETRY_RUNTIME_SESSION, (db, p) => {
    const result = db.prepare<void>(
      `UPDATE runtime_sessions
       SET state = ?, retry_count = retry_count + 1, timeout_at = ?, updated_at = ?, error_json = ?
       WHERE tenant_id = ? AND id = ?`,
    ).run(p.state, p.timeoutAt, p.now, p.errorJson, p.tenantId, p.sessionId);
    return { rowsAffected: result.changes };
  });

  registerCommand<PcoreTimeoutRuntimeSessionParams>(PCORE_CMD_TIMEOUT_RUNTIME_SESSION, (db, p) => {
    const result = db.prepare<void>(
      `UPDATE runtime_sessions
       SET state = 'TIMEOUT', timeout_at = NULL, updated_at = ?, completed_at = ?, error_json = ?
       WHERE tenant_id = ? AND id = ?`,
    ).run(p.now, p.now, p.errorJson, p.tenantId, p.sessionId);
    return { rowsAffected: result.changes };
  });

  registerCommand<PcoreCreateTaskResultParams>(PCORE_CMD_CREATE_TASK_RESULT, (db, p) => {
    const result = db.prepare<void>(
      `INSERT INTO task_results (
        id, tenant_id, task_id, assignment_id, result_uri, evaluation_json,
        quality_score, client_rating, status, rejection_reason,
        created_at, updated_at, accepted_at, rejected_at, disputed_at
      ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, 'submitted', NULL, ?, ?, NULL, NULL, NULL)`,
    ).run(p.id, p.tenantId, p.taskId, p.assignmentId, p.resultUri, p.evaluationJson, p.now, p.now);
    return { rowsAffected: result.changes };
  });

  registerCommand<PcoreTaskAssignmentIdParams>(PCORE_CMD_SUBMIT_TASK_ASSIGNMENT, (db, p) => {
    const result = db.prepare<void>(
      `UPDATE task_assignments
       SET status = 'submitted', submitted_at = ?
       WHERE tenant_id = ? AND id = ?`,
    ).run(p.now, p.tenantId, p.assignmentId);
    return { rowsAffected: result.changes };
  });

  registerCommand<PcoreTouchMarketplaceTaskParams>(PCORE_CMD_TOUCH_MARKETPLACE_TASK, (db, p) => {
    const result = db.prepare<void>(
      `UPDATE marketplace_tasks
       SET updated_at = ?
       WHERE tenant_id = ? AND id = ?`,
    ).run(p.now, p.tenantId, p.taskId);
    return { rowsAffected: result.changes };
  });

  registerCommand<PcoreAcceptTaskResultParams>(PCORE_CMD_ACCEPT_TASK_RESULT, (db, p) => {
    const result = db.prepare<void>(
      `UPDATE task_results
       SET status = 'accepted', quality_score = ?, client_rating = ?, accepted_at = ?, updated_at = ?
       WHERE tenant_id = ? AND id = ?`,
    ).run(p.qualityScore, p.clientRating, p.now, p.now, p.tenantId, p.resultId);
    return { rowsAffected: result.changes };
  });

  registerCommand<PcoreTaskAssignmentIdParams>(PCORE_CMD_ACCEPT_TASK_ASSIGNMENT, (db, p) => {
    const result = db.prepare<void>(
      `UPDATE task_assignments
       SET status = 'accepted', completed_at = ?
       WHERE tenant_id = ? AND id = ?`,
    ).run(p.now, p.tenantId, p.assignmentId);
    return { rowsAffected: result.changes };
  });

  registerCommand<PcoreCompleteMarketplaceTaskParams>(PCORE_CMD_COMPLETE_MARKETPLACE_TASK, (db, p) => {
    const result = db.prepare<void>(
      `UPDATE marketplace_tasks
       SET status = 'completed', quality_score = ?, growth_delta = ?, completed_at = ?, updated_at = ?
       WHERE tenant_id = ? AND id = ?`,
    ).run(p.qualityScore, p.growthDelta, p.now, p.now, p.tenantId, p.taskId);
    return { rowsAffected: result.changes };
  });

  registerCommand<PcoreUpdatePersonaTaskAcceptedParams>(PCORE_CMD_UPDATE_PERSONA_TASK_ACCEPTED, (db, p) => {
    const result = db.prepare<void>(
      `UPDATE persona_core
       SET growth_index = growth_index + ?, reputation = reputation + ?, lifecycle_status = 'active', updated_at = ?
       WHERE tenant_id = ? AND id = ?`,
    ).run(p.growthDelta, p.reputationDelta, p.now, p.tenantId, p.personaId);
    return { rowsAffected: result.changes };
  });

  registerCommand<PcoreRejectTaskResultParams>(PCORE_CMD_REJECT_TASK_RESULT, (db, p) => {
    const result = db.prepare<void>(
      `UPDATE task_results
       SET status = 'rejected', rejection_reason = ?, rejected_at = ?, updated_at = ?
       WHERE tenant_id = ? AND id = ?`,
    ).run(p.reason, p.now, p.now, p.tenantId, p.resultId);
    return { rowsAffected: result.changes };
  });

  registerCommand<PcoreTaskAssignmentIdParams>(PCORE_CMD_REJECT_TASK_ASSIGNMENT, (db, p) => {
    const result = db.prepare<void>(
      `UPDATE task_assignments
       SET status = 'rejected'
       WHERE tenant_id = ? AND id = ?`,
    ).run(p.tenantId, p.assignmentId);
    return { rowsAffected: result.changes };
  });

  registerCommand<PcoreRejectTaskApplicationParams>(PCORE_CMD_REJECT_TASK_APPLICATION, (db, p) => {
    if (!p.applicationId) return { rowsAffected: 0 };
    const result = db.prepare<void>(
      `UPDATE task_applications
       SET status = 'rejected', updated_at = ?
       WHERE tenant_id = ? AND id = ?`,
    ).run(p.now, p.tenantId, p.applicationId);
    return { rowsAffected: result.changes };
  });

  registerCommand<PcoreReopenMarketplaceTaskParams>(PCORE_CMD_REOPEN_MARKETPLACE_TASK, (db, p) => {
    const result = db.prepare<void>(
      `UPDATE marketplace_tasks
       SET status = 'open', assignee_persona_id = NULL, assignee_fork_id = NULL, accepted_at = NULL, updated_at = ?
       WHERE tenant_id = ? AND id = ?`,
    ).run(p.now, p.tenantId, p.taskId);
    return { rowsAffected: result.changes };
  });

  registerCommand<PcoreTaskAssignmentIdParams>(PCORE_CMD_DISPUTE_TASK_ASSIGNMENT, (db, p) => {
    const result = db.prepare<void>(
      `UPDATE task_assignments
       SET status = 'disputed'
       WHERE tenant_id = ? AND id = ?`,
    ).run(p.tenantId, p.assignmentId);
    return { rowsAffected: result.changes };
  });

  registerCommand<PcoreDisputeTaskResultParams>(PCORE_CMD_DISPUTE_TASK_RESULT, (db, p) => {
    const result = db.prepare<void>(
      `UPDATE task_results
       SET status = 'disputed', disputed_at = ?, updated_at = ?
       WHERE tenant_id = ? AND id = ?`,
    ).run(p.now, p.now, p.tenantId, p.resultId);
    return { rowsAffected: result.changes };
  });

  registerCommand<PcoreCreateGovernanceCaseParams>(PCORE_CMD_CREATE_GOVERNANCE_CASE, (db, p) => {
    const result = db.prepare<void>(
      `INSERT INTO governance_cases (
        id, tenant_id, persona_id, task_id, trigger_type, severity, status,
        details_json, appeal_json, opened_at, resolved_at, appealed_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'open', ?, NULL, ?, NULL, NULL)`,
    ).run(p.id, p.tenantId, p.personaId, p.taskId, p.triggerType, p.severity, p.detailsJson, p.now);
    return { rowsAffected: result.changes };
  });

  registerCommand<PcoreCreateGovernanceActionParams>(PCORE_CMD_CREATE_GOVERNANCE_ACTION, (db, p) => {
    const result = db.prepare<void>(
      `INSERT INTO governance_actions (
        id, tenant_id, case_id, action_type, duration_seconds, details_json, actor_user_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(p.id, p.tenantId, p.caseId, p.actionType, p.durationSeconds, p.detailsJson, p.actorUserId, p.now);
    return { rowsAffected: result.changes };
  });

  registerCommand<PcoreUpdateGovernanceCaseActionParams>(PCORE_CMD_UPDATE_GOVERNANCE_CASE_ACTION, (db, p) => {
    const result = db.prepare<void>(
      `UPDATE governance_cases
       SET status = ?, resolved_at = ?
       WHERE tenant_id = ? AND id = ?`,
    ).run(p.status, p.resolvedAt, p.tenantId, p.caseId);
    return { rowsAffected: result.changes };
  });

  registerCommand<PcoreApplyGovernanceActionToPersonaParams>(PCORE_CMD_APPLY_GOVERNANCE_ACTION_TO_PERSONA, (db, p) => {
    const sets = ['reputation = reputation + ?', 'updated_at = ?', 'lifecycle_status = ?', 'status = ?'];
    const params: Array<string | number | null> = [p.reputationDelta, p.now, p.nextStatus, p.legacyStatus];
    if (p.nextStatus === 'deceased') {
      sets.push('deceased_at = ?');
      params.push(p.now);
    }
    params.push(p.tenantId, p.personaId);
    const result = db.prepare<void>(
      `UPDATE persona_core SET ${sets.join(', ')} WHERE tenant_id = ? AND id = ?`,
    ).run(...params);
    return { rowsAffected: result.changes };
  });

  registerCommand<PcoreAppealGovernanceCaseParams>(PCORE_CMD_APPEAL_GOVERNANCE_CASE, (db, p) => {
    const result = db.prepare<void>(
      `UPDATE governance_cases
       SET status = 'appealed', appeal_json = ?, appealed_at = ?
       WHERE tenant_id = ? AND id = ?`,
    ).run(p.appealJson, p.now, p.tenantId, p.caseId);
    return { rowsAffected: result.changes };
  });

  /* Wave-23 executors */

  registerQuery<readonly PcoreMarketplaceTaskRow[], PcoreMarketplaceTasksByTenantParams>(PCORE_QUERY_MARKETPLACE_TASKS_BY_TENANT, (db, p) => {
    if (p.status) {
      return db.prepare<PcoreMarketplaceTaskRow>(
        `SELECT mt.*, pc.display_name AS assignee_persona_name
         FROM marketplace_tasks mt
         LEFT JOIN persona_core pc ON pc.id = mt.assignee_persona_id
         WHERE mt.tenant_id = ? AND mt.status = ?
         ORDER BY mt.updated_at DESC, mt.created_at DESC`,
      ).all(p.tenantId, p.status);
    }
    return db.prepare<PcoreMarketplaceTaskRow>(
      `SELECT mt.*, pc.display_name AS assignee_persona_name
       FROM marketplace_tasks mt
       LEFT JOIN persona_core pc ON pc.id = mt.assignee_persona_id
       WHERE mt.tenant_id = ?
       ORDER BY mt.updated_at DESC, mt.created_at DESC`,
    ).all(p.tenantId);
  });

  registerQuery<PcoreMarketplaceTaskRow | null, PcoreMarketplaceTaskByIdParams>(PCORE_QUERY_MARKETPLACE_TASK_BY_ID, (db, p) => {
    return db.prepare<PcoreMarketplaceTaskRow>(
      `SELECT mt.*, pc.display_name AS assignee_persona_name
       FROM marketplace_tasks mt
       LEFT JOIN persona_core pc ON pc.id = mt.assignee_persona_id
       WHERE mt.tenant_id = ? AND mt.id = ?
       LIMIT 1`,
    ).get(p.tenantId, p.taskId) ?? null;
  });

  registerQuery<PcoreExistsRow | null, PcorePersonaExistsParams>(PCORE_QUERY_PERSONA_EXISTS, (db, p) => {
    return db.prepare<PcoreExistsRow>(
      'SELECT id FROM persona_core WHERE tenant_id = ? AND owner_user_id = ? AND id = ? LIMIT 1',
    ).get(p.tenantId, p.ownerUserId, p.personaId) ?? null;
  });

  registerQuery<PcoreExistsRow | null, PcoreForkExistsParams>(PCORE_QUERY_FORK_EXISTS, (db, p) => {
    return db.prepare<PcoreExistsRow>(
      'SELECT id FROM persona_forks WHERE tenant_id = ? AND persona_id = ? AND id = ? LIMIT 1',
    ).get(p.tenantId, p.personaId, p.forkId) ?? null;
  });

  registerQuery<PcoreTaskAssignmentRow | null, PcoreTaskAssignmentByIdParams>(PCORE_QUERY_TASK_ASSIGNMENT_BY_ID, (db, p) => {
    return db.prepare<PcoreTaskAssignmentRow>(
      'SELECT * FROM task_assignments WHERE tenant_id = ? AND id = ? LIMIT 1',
    ).get(p.tenantId, p.assignmentId) ?? null;
  });

  registerQuery<PcoreTaskAssignmentRow | null, PcoreLatestTaskAssignmentByTaskParams>(PCORE_QUERY_LATEST_TASK_ASSIGNMENT_BY_TASK, (db, p) => {
    return db.prepare<PcoreTaskAssignmentRow>(
      `SELECT * FROM task_assignments
       WHERE tenant_id = ? AND task_id = ?
       ORDER BY assigned_at DESC
       LIMIT 1`,
    ).get(p.tenantId, p.taskId) ?? null;
  });

  registerQuery<PcoreTaskAssignmentRow | null, PcoreLatestTaskAssignmentForPersonaTaskParams>(PCORE_QUERY_LATEST_TASK_ASSIGNMENT_FOR_PERSONA_TASK, (db, p) => {
    return db.prepare<PcoreTaskAssignmentRow>(
      `SELECT * FROM task_assignments
       WHERE tenant_id = ? AND persona_id = ? AND task_id = ?
       ORDER BY assigned_at DESC
       LIMIT 1`,
    ).get(p.tenantId, p.personaId, p.taskId) ?? null;
  });

  registerQuery<PcoreTaskResultRow | null, PcoreLatestTaskResultByAssignmentParams>(PCORE_QUERY_LATEST_TASK_RESULT_BY_ASSIGNMENT, (db, p) => {
    return db.prepare<PcoreTaskResultRow>(
      `SELECT * FROM task_results
       WHERE tenant_id = ? AND assignment_id = ?
       ORDER BY created_at DESC
       LIMIT 1`,
    ).get(p.tenantId, p.assignmentId) ?? null;
  });

  registerQuery<PcoreGovernanceCaseRow | null, PcoreGovernanceCaseByIdParams>(PCORE_QUERY_GOVERNANCE_CASE_BY_ID, (db, p) => {
    return db.prepare<PcoreGovernanceCaseRow>(
      'SELECT * FROM governance_cases WHERE tenant_id = ? AND id = ? LIMIT 1',
    ).get(p.tenantId, p.caseId) ?? null;
  });

  registerQuery<PcoreGovernanceActionRow | null, PcoreGovernanceActionByIdParams>(PCORE_QUERY_GOVERNANCE_ACTION_BY_ID, (db, p) => {
    return db.prepare<PcoreGovernanceActionRow>(
      'SELECT * FROM governance_actions WHERE tenant_id = ? AND id = ? LIMIT 1',
    ).get(p.tenantId, p.actionId) ?? null;
  });

  registerQuery<PcorePersonaRow | null, PcorePersonaByIdParams>(PCORE_QUERY_PERSONA_BY_ID, (db, p) => {
    return db.prepare<PcorePersonaRow>(
      'SELECT * FROM persona_core WHERE tenant_id = ? AND id = ? LIMIT 1',
    ).get(p.tenantId, p.personaId) ?? null;
  });

  registerQuery<PcoreWalletRow | null, PcoreTenantPersonaParams>(PCORE_QUERY_WALLET_BY_PERSONA_ID, (db, p) => {
    return db.prepare<PcoreWalletRow>(
      'SELECT * FROM persona_wallets WHERE tenant_id = ? AND persona_id = ? LIMIT 1',
    ).get(p.tenantId, p.personaId) ?? null;
  });

  registerQuery<PcoreWalletPayoutRequestRow | null, PcoreWalletPayoutRequestByIdParams>(PCORE_QUERY_WALLET_PAYOUT_REQUEST_BY_ID, (db, p) => {
    return db.prepare<PcoreWalletPayoutRequestRow>(
      'SELECT * FROM wallet_payout_requests WHERE tenant_id = ? AND id = ? LIMIT 1',
    ).get(p.tenantId, p.payoutId) ?? null;
  });

  registerQuery<PcoreWalletSettlementRow | null, PcoreWalletSettlementByAssignmentIdParams>(PCORE_QUERY_WALLET_SETTLEMENT_BY_ASSIGNMENT_ID, (db, p) => {
    return db.prepare<PcoreWalletSettlementRow>(
      'SELECT * FROM wallet_settlements WHERE tenant_id = ? AND assignment_id = ? LIMIT 1',
    ).get(p.tenantId, p.assignmentId) ?? null;
  });

  registerQuery<PcoreExistsRow | null, PcoreTransferAccessParams>(PCORE_QUERY_TRANSFER_ACCESS, (db, p) => {
    return db.prepare<PcoreExistsRow>(
      `SELECT id FROM persona_transfers
       WHERE tenant_id = ? AND persona_id = ? AND (from_owner_user_id = ? OR to_owner_user_id = ?)
       LIMIT 1`,
    ).get(p.tenantId, p.personaId, p.userId, p.userId) ?? null;
  });

  registerQuery<PcoreExistsRow | null, PcoreUserExistsParams>(PCORE_QUERY_USER_EXISTS, (db, p) => {
    return db.prepare<PcoreExistsRow>(
      'SELECT id FROM users WHERE tenant_id = ? AND id = ? LIMIT 1',
    ).get(p.tenantId, p.userId) ?? null;
  });

  registerQuery<PcoreRankingTaskStatsRow | null, PcoreRankingTaskStatsParams>(PCORE_QUERY_RANKING_TASK_STATS, (db, p) => {
    return db.prepare<PcoreRankingTaskStatsRow>(
      `SELECT
        COUNT(*) AS completed_tasks,
        AVG(COALESCE(quality_score, 0)) AS avg_quality,
        AVG(
          CASE
            WHEN accepted_at IS NOT NULL AND completed_at IS NOT NULL AND completed_at > accepted_at
            THEN (completed_at - accepted_at) / 3600000.0
            ELSE NULL
          END
        ) AS avg_hours
       FROM marketplace_tasks
       WHERE tenant_id = ? AND assignee_persona_id = ? AND status = 'completed' AND category = ?`,
    ).get(p.tenantId, p.personaId, p.category) ?? null;
  });

  registerQuery<PcoreRankingTaskStatsRow | null, PcoreTenantPersonaParams>(PCORE_QUERY_RANKING_TASK_STATS_UNCATEGORIZED, (db, p) => {
    return db.prepare<PcoreRankingTaskStatsRow>(
      `SELECT
        COUNT(*) AS completed_tasks,
        AVG(COALESCE(quality_score, 0)) AS avg_quality,
        AVG(
          CASE
            WHEN accepted_at IS NOT NULL AND completed_at IS NOT NULL AND completed_at > accepted_at
            THEN (completed_at - accepted_at) / 3600000.0
            ELSE NULL
          END
        ) AS avg_hours
       FROM marketplace_tasks
       WHERE tenant_id = ? AND assignee_persona_id = ? AND status = 'completed'`,
    ).get(p.tenantId, p.personaId) ?? null;
  });

  registerQuery<PcoreLastActiveAtRow | null, PcoreLastActiveAtParams>(PCORE_QUERY_LAST_ACTIVE_AT, (db, p) => {
    const walletRow = db.prepare<{ value: number | null }>(
      `SELECT MAX(COALESCE(last_settled_at, created_at)) AS value
       FROM persona_wallets WHERE tenant_id = ? AND persona_id = ?`,
    ).get(p.tenantId, p.personaId);
    const memoryRow = db.prepare<{ value: number | null }>(
      `SELECT MAX(created_at) AS value
       FROM persona_memories WHERE tenant_id = ? AND persona_id = ?`,
    ).get(p.tenantId, p.personaId);
    const taskRow = db.prepare<{ value: number | null }>(
      `SELECT MAX(COALESCE(completed_at, updated_at, accepted_at, published_at)) AS value
       FROM marketplace_tasks WHERE tenant_id = ? AND assignee_persona_id = ?`,
    ).get(p.tenantId, p.personaId);
    return {
      wallet_value: walletRow?.value ?? null,
      memory_value: memoryRow?.value ?? null,
      task_value: taskRow?.value ?? null,
    };
  });

  registerCommand<PcorePublishMarketplaceTaskParams>(PCORE_CMD_PUBLISH_MARKETPLACE_TASK, (db, p) => {
    const result = db.prepare<void>(
      `INSERT INTO marketplace_tasks (
        id, tenant_id, publisher_user_id, assignee_persona_id, assignee_fork_id,
        title, description, category, reward, currency, status, quality_score, growth_delta,
        published_at, accepted_at, completed_at, created_at, updated_at
      ) VALUES (?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, 'open', NULL, NULL, ?, NULL, NULL, ?, ?)`,
    ).run(
      p.id, p.tenantId, p.publisherUserId,
      p.title, p.description, p.category, p.reward, p.currency,
      p.now, p.now, p.now,
    );
    return { rowsAffected: result.changes };
  });

  registerCommand<PcoreAcceptMarketplaceTaskLegacyParams>(PCORE_CMD_ACCEPT_MARKETPLACE_TASK_LEGACY, (db, p) => {
    const result = db.prepare<void>(
      `UPDATE marketplace_tasks
       SET status = 'accepted', assignee_persona_id = ?, assignee_fork_id = ?, accepted_at = ?, updated_at = ?
       WHERE tenant_id = ? AND id = ? AND status = 'open'`,
    ).run(p.personaId, p.forkId, p.now, p.now, p.tenantId, p.taskId);
    return { rowsAffected: result.changes };
  });

  registerCommand<PcoreCompleteTaskWalletUpdateParams>(PCORE_CMD_COMPLETE_TASK_WALLET_UPDATE, (db, p) => {
    const result = db.prepare<void>(
      `UPDATE persona_wallets
       SET balance = balance + ?, token_balance = token_balance + ?, last_settled_at = ?, updated_at = ?
       WHERE tenant_id = ? AND persona_id = ?`,
    ).run(p.payout, p.tokenReward, p.now, p.now, p.tenantId, p.personaId);
    return { rowsAffected: result.changes };
  });

  registerCommand<PcoreCompleteTaskPersonaUpdateParams>(PCORE_CMD_COMPLETE_TASK_PERSONA_UPDATE, (db, p) => {
    const result = db.prepare<void>(
      `UPDATE persona_core
       SET growth_index = growth_index + ?, reputation = reputation + ?, training_investment = training_investment + ?, lifecycle_status = 'active', updated_at = ?
       WHERE tenant_id = ? AND id = ?`,
    ).run(p.growthDelta, p.reputationDelta, p.ownerTrainingHours, p.now, p.tenantId, p.personaId);
    return { rowsAffected: result.changes };
  });

  registerCommand<PcoreInsertWalletTransactionParams>(PCORE_CMD_INSERT_WALLET_TRANSACTION, (db, p) => {
    const result = db.prepare<void>(
      `INSERT INTO wallet_transactions (
        id, tenant_id, wallet_id, transaction_type, amount_minor, currency, reference_type, reference_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(p.id, p.tenantId, p.walletId, p.transactionType, p.amountMinor, p.currency, p.referenceType, p.referenceId, p.now);
    return { rowsAffected: result.changes };
  });

  registerCommand<PcoreInsertReputationHistoryParams>(PCORE_CMD_INSERT_REPUTATION_HISTORY, (db, p) => {
    const result = db.prepare<void>(
      `INSERT INTO reputation_history (
        id, tenant_id, persona_id, old_score, new_score, reason, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(p.id, p.tenantId, p.personaId, p.oldScore, p.newScore, p.reason, p.now);
    return { rowsAffected: result.changes };
  });

  registerCommand<PcoreInsertGrowthEventParams>(PCORE_CMD_INSERT_GROWTH_EVENT, (db, p) => {
    const result = db.prepare<void>(
      `INSERT INTO persona_growth_events (
        id, tenant_id, persona_id, task_id, event_type, growth_delta, reputation_delta, training_delta, payload_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(p.id, p.tenantId, p.personaId, p.taskId, p.eventType, p.growthDelta, p.reputationDelta, p.trainingDelta, p.payloadJson, p.now);
    return { rowsAffected: result.changes };
  });

  registerCommand<PcoreInsertGovernanceEventParams>(PCORE_CMD_INSERT_GOVERNANCE_EVENT, (db, p) => {
    const result = db.prepare<void>(
      `INSERT INTO persona_governance_events (
        id, tenant_id, persona_id, event_type, severity, summary, payload_json, actor_user_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(p.id, p.tenantId, p.personaId, p.eventType, p.severity, p.summary, p.payloadJson, p.actorUserId, p.now);
    return { rowsAffected: result.changes };
  });

  registerCommand<PcoreInsertMemoryParams>(PCORE_CMD_INSERT_MEMORY, (db, p) => {
    const result = db.prepare<void>(
      `INSERT INTO persona_memories (
        id, tenant_id, persona_id, fork_id, kind, sensitivity, is_encrypted, owner_restricted,
        summary, content_json, importance, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      p.id, p.tenantId, p.personaId, p.forkId,
      p.kind, p.sensitivity, p.isEncrypted, p.ownerRestricted,
      p.summary, p.contentJson, p.importance, p.now, p.now,
    );
    return { rowsAffected: result.changes };
  });
}
