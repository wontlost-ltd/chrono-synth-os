/**
 * Persona Core Query/Command kind constants and parameter types.
 */

import type { Query, Command } from '../../ports/query.js';

/* Query Kinds */

export const PCORE_QUERY_SUMMARIES_BY_OWNER = 'pcore.summariesByOwner' as const;
export const PCORE_QUERY_SUMMARY_BY_OWNER = 'pcore.summaryByOwner' as const;
export const PCORE_QUERY_FORKS_BY_PERSONA = 'pcore.forksByPersona' as const;
export const PCORE_QUERY_RECENT_MEMORIES = 'pcore.recentMemories' as const;
export const PCORE_QUERY_RECENT_KNOWLEDGE = 'pcore.recentKnowledge' as const;
export const PCORE_QUERY_RECENT_GROWTH_EVENTS = 'pcore.recentGrowthEvents' as const;
export const PCORE_QUERY_RECENT_GOVERNANCE_EVENTS = 'pcore.recentGovernanceEvents' as const;
export const PCORE_QUERY_RECENT_MARKETPLACE_TASKS = 'pcore.recentMarketplaceTasks' as const;
export const PCORE_QUERY_PENDING_TRANSFER = 'pcore.pendingTransfer' as const;
export const PCORE_QUERY_TRANSFER_BY_PERSONA_ID = 'pcore.transferByPersonaId' as const;
export const PCORE_QUERY_TRANSFER_BY_ID = 'pcore.transferById' as const;
export const PCORE_QUERY_TRANSFERS_BY_PERSONA = 'pcore.transfersByPersona' as const;
export const PCORE_QUERY_COMPLETED_TASK_COUNT = 'pcore.completedTaskCount' as const;
export const PCORE_QUERY_GOVERNANCE_PENALTY_COUNT = 'pcore.governancePenaltyCount' as const;
export const PCORE_QUERY_REPUTATION_HISTORY = 'pcore.reputationHistory' as const;
export const PCORE_QUERY_ACTIVE_PERSONAS_FOR_RANKING = 'pcore.activePersonasForRanking' as const;
export const PCORE_QUERY_MEMORY_COUNT = 'pcore.memoryCount' as const;
export const PCORE_QUERY_GOVERNANCE_EVENT_COUNT = 'pcore.governanceEventCount' as const;
export const PCORE_QUERY_MARKETPLACE_ANALYTICS = 'pcore.marketplaceAnalytics' as const;
export const PCORE_QUERY_DAILY_PERSONAS = 'pcore.dailyPersonas' as const;
export const PCORE_QUERY_DAILY_COMPLETED_TASK_COUNT = 'pcore.dailyCompletedTaskCount' as const;
export const PCORE_QUERY_DAILY_PERSONA_REVENUE = 'pcore.dailyPersonaRevenue' as const;
/** 批量（消 materializeDailyAnalytics 的 N+1）：整租户按 persona 分组的当日完成数 / 收益 */
export const PCORE_QUERY_DAILY_COMPLETED_TASK_COUNT_BY_PERSONA = 'pcore.dailyCompletedTaskCountByPersona' as const;
export const PCORE_QUERY_DAILY_PERSONA_REVENUE_BY_PERSONA = 'pcore.dailyPersonaRevenueByPersona' as const;
export const PCORE_QUERY_DAILY_MARKETPLACE_ANALYTICS = 'pcore.dailyMarketplaceAnalytics' as const;
export const PCORE_QUERY_ECONOMY_ANALYTICS = 'pcore.economyAnalytics' as const;
export const PCORE_QUERY_PERSONA_MEMORIES = 'pcore.personaMemories' as const;
export const PCORE_QUERY_MEMORY_KIND_COUNTS = 'pcore.memoryKindCounts' as const;
export const PCORE_QUERY_MEMORY_RELATION_COUNTS = 'pcore.memoryRelationCounts' as const;
export const PCORE_QUERY_MEMORY_NODE_IDS = 'pcore.memoryNodeIds' as const;
export const PCORE_QUERY_MEMORY_EDGES = 'pcore.memoryEdges' as const;
export const PCORE_QUERY_WALLET_BY_PERSONA = 'pcore.walletByPersona' as const;
export const PCORE_QUERY_WALLET_BY_ID_FOR_OWNER = 'pcore.walletByIdForOwner' as const;
export const PCORE_QUERY_WALLET_TRANSACTIONS = 'pcore.walletTransactions' as const;
export const PCORE_QUERY_TASK_APPLICATION = 'pcore.taskApplication' as const;
/** 列某工单的全部 persona 申请者（含 persona display_name，发布者据此选委派给谁）。 */
export const PCORE_QUERY_TASK_APPLICATIONS_BY_TASK = 'pcore.taskApplicationsByTask' as const;
export const PCORE_QUERY_RUNTIME_SESSION = 'pcore.runtimeSession' as const;
export const PCORE_QUERY_TIMED_OUT_RUNTIME_SESSIONS = 'pcore.timedOutRuntimeSessions' as const;
export const PCORE_QUERY_GOVERNANCE_CASES_BY_PERSONA = 'pcore.governanceCasesByPersona' as const;

/* Command Kinds */

export const PCORE_CMD_CREATE_PERSONA = 'pcore.createPersona' as const;
export const PCORE_CMD_CREATE_WALLET = 'pcore.createWallet' as const;
export const PCORE_CMD_CREATE_KNOWLEDGE_ITEM = 'pcore.createKnowledgeItem' as const;
export const PCORE_CMD_ACTIVATE_PERSONA = 'pcore.activatePersona' as const;
export const PCORE_CMD_DEACTIVATE_PERSONA = 'pcore.deactivatePersona' as const;
export const PCORE_CMD_CREATE_TRANSFER = 'pcore.createTransfer' as const;
export const PCORE_CMD_APPROVE_TRANSFER = 'pcore.approveTransfer' as const;
export const PCORE_CMD_TRANSFER_PERSONA_OWNER = 'pcore.transferPersonaOwner' as const;
export const PCORE_CMD_COMPLETE_TRANSFER = 'pcore.completeTransfer' as const;
export const PCORE_CMD_UPSERT_PERSONA_DAILY_METRIC = 'pcore.upsertPersonaDailyMetric' as const;
export const PCORE_CMD_UPSERT_MARKETPLACE_DAILY_METRIC = 'pcore.upsertMarketplaceDailyMetric' as const;
export const PCORE_CMD_CREATE_FORK = 'pcore.createFork' as const;
export const PCORE_CMD_UPDATE_PERSONA_KNOWLEDGE_SYNC = 'pcore.updatePersonaKnowledgeSync' as const;
export const PCORE_CMD_APPLY_GOVERNANCE_EVENT = 'pcore.applyGovernanceEvent' as const;
export const PCORE_CMD_CREATE_WALLET_PAYOUT_REQUEST = 'pcore.createWalletPayoutRequest' as const;
export const PCORE_CMD_UPDATE_WALLET_BALANCE = 'pcore.updateWalletBalance' as const;
export const PCORE_CMD_CREATE_WALLET_SETTLEMENT = 'pcore.createWalletSettlement' as const;
export const PCORE_CMD_SETTLE_PERSONA_WALLET = 'pcore.settlePersonaWallet' as const;
export const PCORE_CMD_CREATE_TASK_APPLICATION = 'pcore.createTaskApplication' as const;
export const PCORE_CMD_CREATE_TASK_ASSIGNMENT = 'pcore.createTaskAssignment' as const;
export const PCORE_CMD_MARK_TASK_APPLICATIONS_ASSIGNED = 'pcore.markTaskApplicationsAssigned' as const;
export const PCORE_CMD_ACCEPT_MARKETPLACE_TASK_ASSIGNMENT = 'pcore.acceptMarketplaceTaskAssignment' as const;
export const PCORE_CMD_CREATE_RUNTIME_SESSION = 'pcore.createRuntimeSession' as const;
export const PCORE_CMD_LINK_TASK_ASSIGNMENT_RUNTIME_SESSION = 'pcore.linkTaskAssignmentRuntimeSession' as const;
export const PCORE_CMD_PLAN_RUNTIME_SESSION = 'pcore.planRuntimeSession' as const;
export const PCORE_CMD_EXECUTE_RUNTIME_SESSION = 'pcore.executeRuntimeSession' as const;
export const PCORE_CMD_START_TASK_ASSIGNMENT = 'pcore.startTaskAssignment' as const;
export const PCORE_CMD_EVALUATE_RUNTIME_SESSION = 'pcore.evaluateRuntimeSession' as const;
export const PCORE_CMD_COMPLETE_RUNTIME_SESSION = 'pcore.completeRuntimeSession' as const;
export const PCORE_CMD_RETRY_RUNTIME_SESSION = 'pcore.retryRuntimeSession' as const;
export const PCORE_CMD_TIMEOUT_RUNTIME_SESSION = 'pcore.timeoutRuntimeSession' as const;
export const PCORE_CMD_CREATE_TASK_RESULT = 'pcore.createTaskResult' as const;
export const PCORE_CMD_SUBMIT_TASK_ASSIGNMENT = 'pcore.submitTaskAssignment' as const;
export const PCORE_CMD_TOUCH_MARKETPLACE_TASK = 'pcore.touchMarketplaceTask' as const;
export const PCORE_CMD_ACCEPT_TASK_RESULT = 'pcore.acceptTaskResult' as const;
export const PCORE_CMD_ACCEPT_TASK_ASSIGNMENT = 'pcore.acceptTaskAssignment' as const;
export const PCORE_CMD_COMPLETE_MARKETPLACE_TASK = 'pcore.completeMarketplaceTask' as const;
export const PCORE_CMD_UPDATE_PERSONA_TASK_ACCEPTED = 'pcore.updatePersonaTaskAccepted' as const;
export const PCORE_CMD_REJECT_TASK_RESULT = 'pcore.rejectTaskResult' as const;
export const PCORE_CMD_REJECT_TASK_ASSIGNMENT = 'pcore.rejectTaskAssignment' as const;
export const PCORE_CMD_REJECT_TASK_APPLICATION = 'pcore.rejectTaskApplication' as const;
export const PCORE_CMD_REOPEN_MARKETPLACE_TASK = 'pcore.reopenMarketplaceTask' as const;
export const PCORE_CMD_DISPUTE_TASK_ASSIGNMENT = 'pcore.disputeTaskAssignment' as const;
export const PCORE_CMD_DISPUTE_TASK_RESULT = 'pcore.disputeTaskResult' as const;
export const PCORE_CMD_CREATE_GOVERNANCE_CASE = 'pcore.createGovernanceCase' as const;
export const PCORE_CMD_CREATE_GOVERNANCE_ACTION = 'pcore.createGovernanceAction' as const;
export const PCORE_CMD_UPDATE_GOVERNANCE_CASE_ACTION = 'pcore.updateGovernanceCaseAction' as const;
export const PCORE_CMD_APPLY_GOVERNANCE_ACTION_TO_PERSONA = 'pcore.applyGovernanceActionToPersona' as const;
export const PCORE_CMD_APPEAL_GOVERNANCE_CASE = 'pcore.appealGovernanceCase' as const;

/* Wave-23 Query Kinds */
export const PCORE_QUERY_MARKETPLACE_TASKS_BY_TENANT = 'pcore.marketplaceTasksByTenant' as const;
export const PCORE_QUERY_MARKETPLACE_TASK_BY_ID = 'pcore.marketplaceTaskById' as const;
export const PCORE_QUERY_PERSONA_EXISTS = 'pcore.personaExists' as const;
export const PCORE_QUERY_FORK_EXISTS = 'pcore.forkExists' as const;
export const PCORE_QUERY_TASK_ASSIGNMENT_BY_ID = 'pcore.taskAssignmentById' as const;
export const PCORE_QUERY_LATEST_TASK_ASSIGNMENT_BY_TASK = 'pcore.latestTaskAssignmentByTask' as const;
export const PCORE_QUERY_LATEST_TASK_ASSIGNMENT_FOR_PERSONA_TASK = 'pcore.latestTaskAssignmentForPersonaTask' as const;
export const PCORE_QUERY_LATEST_TASK_RESULT_BY_ASSIGNMENT = 'pcore.latestTaskResultByAssignment' as const;
export const PCORE_QUERY_GOVERNANCE_CASE_BY_ID = 'pcore.governanceCaseById' as const;
export const PCORE_QUERY_GOVERNANCE_ACTION_BY_ID = 'pcore.governanceActionById' as const;
export const PCORE_QUERY_PERSONA_BY_ID = 'pcore.personaById' as const;
export const PCORE_QUERY_WALLET_BY_PERSONA_ID = 'pcore.walletByPersonaId' as const;
export const PCORE_QUERY_WALLET_PAYOUT_REQUEST_BY_ID = 'pcore.walletPayoutRequestById' as const;
export const PCORE_QUERY_WALLET_SETTLEMENT_BY_ASSIGNMENT_ID = 'pcore.walletSettlementByAssignmentId' as const;
export const PCORE_QUERY_TRANSFER_ACCESS = 'pcore.transferAccess' as const;
export const PCORE_QUERY_USER_EXISTS = 'pcore.userExists' as const;
export const PCORE_QUERY_RANKING_TASK_STATS = 'pcore.rankingTaskStats' as const;
export const PCORE_QUERY_RANKING_TASK_STATS_UNCATEGORIZED = 'pcore.rankingTaskStatsUncategorized' as const;
export const PCORE_QUERY_LAST_ACTIVE_AT = 'pcore.lastActiveAt' as const;

/* Wave-23 Command Kinds */
export const PCORE_CMD_PUBLISH_MARKETPLACE_TASK = 'pcore.publishMarketplaceTask' as const;
export const PCORE_CMD_ACCEPT_MARKETPLACE_TASK_LEGACY = 'pcore.acceptMarketplaceTaskLegacy' as const;
export const PCORE_CMD_COMPLETE_TASK_WALLET_UPDATE = 'pcore.completeTaskWalletUpdate' as const;
export const PCORE_CMD_COMPLETE_TASK_PERSONA_UPDATE = 'pcore.completeTaskPersonaUpdate' as const;
export const PCORE_CMD_INSERT_WALLET_TRANSACTION = 'pcore.insertWalletTransaction' as const;
export const PCORE_CMD_INSERT_REPUTATION_HISTORY = 'pcore.insertReputationHistory' as const;
export const PCORE_CMD_INSERT_GROWTH_EVENT = 'pcore.insertGrowthEvent' as const;
export const PCORE_CMD_INSERT_GOVERNANCE_EVENT = 'pcore.insertGovernanceEvent' as const;
export const PCORE_CMD_INSERT_MEMORY = 'pcore.insertMemory' as const;

/* Rows */

export interface PcorePersonaRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly owner_user_id: string;
  readonly display_name: string;
  readonly profile_json: string;
  readonly status: string;
  readonly lifecycle_status?: string;
  readonly visibility: string;
  readonly growth_index: number;
  readonly reputation: number;
  readonly training_investment: number;
  readonly created_at: number;
  readonly updated_at: number;
  readonly deceased_at: number | null;
  readonly transferred_at: number | null;
}

export interface PcorePersonaSummaryRow extends PcorePersonaRow {
  readonly wallet_id: string;
  readonly wallet_address: string;
  readonly balance: number;
  readonly token_balance: number;
  readonly last_settled_at: number | null;
  readonly wallet_created_at: number;
  readonly wallet_updated_at: number;
  readonly active_fork_count: number;
  readonly memory_count: number;
  readonly knowledge_count: number;
  readonly active_task_count: number;
}

export interface PcoreForkRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly persona_id: string;
  readonly label: string;
  readonly fork_type: string;
  readonly status: string;
  readonly sync_mode: string;
  readonly experience_factor: number;
  readonly created_at: number;
  readonly updated_at: number;
  readonly recycled_at: number | null;
}

export interface PcoreMemoryRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly persona_id: string;
  readonly fork_id: string | null;
  readonly kind: string;
  readonly sensitivity?: string | null;
  readonly is_encrypted?: number | null;
  readonly owner_restricted?: number | null;
  readonly summary: string;
  readonly content_json: string;
  readonly importance: number;
  readonly created_at: number;
  readonly updated_at: number;
}

export interface PcoreKnowledgeRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly persona_id: string;
  readonly title: string;
  readonly content: string;
  readonly source: string;
  readonly tags_json: string;
  readonly confidence: number;
  readonly created_at: number;
  readonly updated_at: number;
}

export interface PcoreGrowthEventRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly persona_id: string;
  readonly task_id: string | null;
  readonly event_type: string;
  readonly growth_delta: number;
  readonly reputation_delta: number;
  readonly training_delta: number;
  readonly payload_json: string;
  readonly created_at: number;
}

export interface PcoreGovernanceEventRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly persona_id: string;
  readonly event_type: string;
  readonly severity: number;
  readonly summary: string;
  readonly payload_json: string;
  readonly actor_user_id: string | null;
  readonly created_at: number;
}

export interface PcoreMarketplaceTaskRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly publisher_user_id: string;
  readonly assignee_persona_id: string | null;
  readonly assignee_fork_id: string | null;
  readonly assignee_persona_name?: string | null;
  readonly title: string;
  readonly description: string;
  readonly category: string;
  readonly reward: number;
  readonly currency: string;
  readonly status: string;
  readonly quality_score: number | null;
  readonly growth_delta: number | null;
  readonly published_at: number;
  readonly accepted_at: number | null;
  readonly completed_at: number | null;
  readonly created_at: number;
  readonly updated_at: number;
}

export interface PcoreTransferRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly persona_id: string;
  readonly from_owner_user_id: string;
  readonly to_owner_user_id: string;
  readonly status: string;
  readonly reason: string;
  readonly requested_at: number;
  readonly approved_at: number | null;
  readonly completed_at: number | null;
}

export interface PcoreReputationHistoryRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly persona_id: string;
  readonly old_score: number;
  readonly new_score: number;
  readonly reason: string;
  readonly created_at: number;
}

export interface PcoreCountRow {
  readonly count: number;
}

export interface PcoreTotalRow {
  readonly total: number;
}

export interface PcoreDailyPersonaRow {
  readonly id: string;
  readonly reputation: number;
  readonly growth_index: number;
}

export interface PcoreMarketplaceAnalyticsRow {
  readonly open_tasks: number;
  readonly active_personas: number;
  readonly completed_tasks_7d: number;
  readonly gross_volume: number;
}

export interface PcoreDailyMarketplaceAnalyticsRow {
  readonly open_tasks: number;
  readonly completed_tasks: number;
  readonly gross_volume: number;
  readonly active_personas: number;
}

export interface PcoreEconomyAnalyticsRow {
  readonly gross_revenue_minor: number;
  readonly owner_payouts_minor: number;
  readonly platform_fees_minor: number;
  readonly persona_reserves_minor: number;
  readonly payout_requests: number;
  readonly settlement_count: number;
  readonly transaction_count: number;
}

export interface PcoreMemoryCountByKindRow {
  readonly kind: string;
  readonly count: number;
}

export interface PcoreMemoryCountByRelationRow {
  readonly relation: string;
  readonly count: number;
}

export interface PcoreMemoryNodeIdRow {
  readonly id: string;
}

export interface PcoreMemoryEdgeRow {
  readonly tenant_id: string;
  readonly persona_id: string;
  readonly source: string;
  readonly target: string;
  readonly strength: number;
  readonly relation: string;
}

export interface PcoreWalletRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly persona_id: string;
  readonly wallet_address: string;
  readonly balance: number;
  readonly token_balance: number;
  readonly currency?: string;
  readonly status?: string;
  readonly last_settled_at: number | null;
  readonly created_at: number;
  readonly updated_at: number;
}

export interface PcoreWalletForOwnerRow extends PcoreWalletRow {
  readonly owner_user_id: string;
}

export interface PcoreWalletTransactionRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly wallet_id: string;
  readonly transaction_type: string;
  readonly amount_minor: number;
  readonly currency: string;
  readonly reference_type: string | null;
  readonly reference_id: string | null;
  readonly created_at: number;
}

export interface PcoreTaskApplicationRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly task_id: string;
  readonly persona_id: string;
  readonly ranking_score: number;
  readonly status: string;
  readonly created_at: number;
  readonly updated_at: number;
}

/** 申请者行 + persona display_name（列工单申请者用，发布者看名字选委派）。 */
export interface PcoreTaskApplicantRow extends PcoreTaskApplicationRow {
  readonly persona_name: string | null;
}

export interface PcoreRuntimeSessionRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly persona_id: string;
  readonly task_id: string;
  readonly assignment_id: string | null;
  readonly state: string;
  readonly retry_count: number;
  readonly timeout_at: number | null;
  readonly plan_json: string | null;
  readonly artifacts_json: string;
  readonly evaluation_json: string | null;
  readonly result_summary_json: string | null;
  readonly error_json: string | null;
  readonly created_at: number;
  readonly updated_at: number;
  readonly completed_at: number | null;
}

export interface PcoreGovernanceCaseRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly persona_id: string;
  readonly task_id: string | null;
  readonly trigger_type: string;
  readonly severity: string;
  readonly status: string;
  readonly details_json: string;
  readonly appeal_json: string | null;
  readonly opened_at: number;
  readonly resolved_at: number | null;
  readonly appealed_at: number | null;
}

export interface PcoreTaskAssignmentRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly task_id: string;
  readonly persona_id: string;
  readonly application_id: string | null;
  readonly runtime_session_id: string | null;
  readonly status: string;
  readonly assigned_at: number;
  readonly started_at: number | null;
  readonly submitted_at: number | null;
  readonly completed_at: number | null;
}

export interface PcoreTaskResultRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly task_id: string;
  readonly assignment_id: string;
  readonly result_uri: string;
  readonly evaluation_json: string;
  readonly quality_score: number | null;
  readonly client_rating: number | null;
  readonly status: string;
  readonly rejection_reason: string | null;
  readonly created_at: number;
  readonly updated_at: number;
  readonly accepted_at: number | null;
  readonly rejected_at: number | null;
  readonly disputed_at: number | null;
}

export interface PcoreGovernanceActionRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly case_id: string;
  readonly action_type: string;
  readonly duration_seconds: number | null;
  readonly details_json: string;
  readonly actor_user_id: string | null;
  readonly created_at: number;
}

export interface PcoreWalletPayoutRequestRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly wallet_id: string;
  readonly amount_minor: number;
  readonly currency: string;
  readonly status: string;
  readonly requested_by_user_id: string;
  readonly created_at: number;
  readonly completed_at: number | null;
}

export interface PcoreWalletSettlementRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly wallet_id: string;
  readonly task_id: string;
  readonly assignment_id: string;
  readonly total_amount_minor: number;
  readonly currency: string;
  readonly owner_pct: number;
  readonly persona_pct: number;
  readonly platform_pct: number;
  readonly owner_amount_minor: number;
  readonly persona_amount_minor: number;
  readonly platform_amount_minor: number;
  readonly status: string;
  readonly created_at: number;
  readonly completed_at: number | null;
}

export interface PcoreWalletTransactionInsertedRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly wallet_id: string;
  readonly transaction_type: string;
  readonly amount_minor: number;
  readonly currency: string;
  readonly reference_type: string | null;
  readonly reference_id: string | null;
  readonly created_at: number;
}

export interface PcoreRankingTaskStatsRow {
  readonly completed_tasks: number;
  readonly avg_quality: number | null;
  readonly avg_hours: number | null;
}

export interface PcoreLastActiveAtRow {
  readonly wallet_value: number | null;
  readonly memory_value: number | null;
  readonly task_value: number | null;
}

export interface PcoreExistsRow {
  readonly id: string;
}

/* Params */

export interface PcoreTenantOwnerParams {
  tenantId: string;
  ownerUserId: string;
}

export interface PcoreTenantPersonaParams {
  tenantId: string;
  personaId: string;
}

export interface PcoreSummaryByOwnerParams extends PcoreTenantOwnerParams {
  personaId: string;
}

export interface PcoreRecentMarketplaceTasksParams extends PcoreTenantPersonaParams {
  ownerUserId: string;
}

export interface PcoreTransferByPersonaIdParams extends PcoreTenantPersonaParams {
  transferId: string;
}

export interface PcoreTransferByIdParams {
  tenantId: string;
  transferId: string;
}

export interface PcoreCreatePersonaParams {
  id: string;
  tenantId: string;
  ownerUserId: string;
  displayName: string;
  profileJson: string;
  visibility: string;
  reputation: number;
  now: number;
}

export interface PcoreCreateWalletParams {
  id: string;
  tenantId: string;
  personaId: string;
  walletAddress: string;
  now: number;
}

export interface PcoreCreateKnowledgeItemParams {
  id: string;
  tenantId: string;
  personaId: string;
  title: string;
  content: string;
  source: string;
  tagsJson: string;
  confidence: number;
  now: number;
  fingerprint?: string | null;
}

export interface PcoreSetPersonaStatusParams extends PcoreTenantPersonaParams {
  now: number;
}

export interface PcoreCreateTransferParams {
  id: string;
  tenantId: string;
  personaId: string;
  fromOwnerUserId: string;
  toOwnerUserId: string;
  reason: string;
  now: number;
}

export interface PcoreApproveTransferParams {
  tenantId: string;
  transferId: string;
  now: number;
}

export interface PcoreTransferPersonaOwnerParams extends PcoreTenantPersonaParams {
  ownerUserId: string;
  now: number;
}

export interface PcoreTaskCountByDateParams extends PcoreTenantPersonaParams {
  startMs: number;
  endMs: number;
}

export interface PcoreRevenueByDateParams extends PcoreTenantPersonaParams {
  startMs: number;
  endMs: number;
}

/** 批量按日期范围（无 personaId）：整租户一次取，按 persona 分组 */
export interface PcoreDateRangeParams {
  tenantId: string;
  startMs: number;
  endMs: number;
}

/** persona → 当日完成任务数 分组行 */
export interface PcorePersonaCountRow {
  persona_id: string;
  count: number | bigint;
}

/** persona → 当日收益（minor）分组行 */
export interface PcorePersonaTotalRow {
  persona_id: string;
  total: number | bigint | null;
}

export interface PcoreDailyMarketplaceAnalyticsParams {
  tenantId: string;
  startMs: number;
  endMs: number;
}

export interface PcoreUpsertPersonaDailyMetricParams extends PcoreTenantPersonaParams {
  metricDate: string;
  tasksCompleted: number;
  revenue: number;
  reputationScore: number;
  growthIndex: number;
}

export interface PcoreUpsertMarketplaceDailyMetricParams {
  tenantId: string;
  metricDate: string;
  openTasks: number;
  completedTasks: number;
  grossVolume: number;
  activePersonas: number;
}

export interface PcoreCreateForkParams extends PcoreTenantPersonaParams {
  id: string;
  label: string;
  forkType: string;
  syncMode: string;
  experienceFactor: number;
  now: number;
}

export interface PcorePersonaMemoriesParams extends PcoreTenantPersonaParams {
  kind?: string;
  cursor?: number;
  limit: number;
}

export interface PcoreMemoryNodeIdsParams extends PcoreTenantPersonaParams {
  memoryId?: string;
  kind?: string;
  limit: number;
}

export interface PcoreMemoryEdgesParams extends PcoreTenantPersonaParams {
  nodeIds: readonly string[];
  relation?: string;
}

export interface PcoreUpdatePersonaKnowledgeSyncParams extends PcoreTenantPersonaParams {
  growthDelta: number;
  reputationDelta: number;
  now: number;
}

export interface PcoreApplyGovernanceEventParams extends PcoreTenantPersonaParams {
  reputationDelta: number;
  growthDelta: number;
  now: number;
  nextStatus: string | null;
  legacyStatus: string | null;
}

export interface PcoreWalletByIdParams {
  tenantId: string;
  walletId: string;
}

export interface PcoreCreateWalletPayoutRequestParams {
  id: string;
  tenantId: string;
  walletId: string;
  amountMinor: number;
  currency: string;
  requestedByUserId: string;
  now: number;
}

export interface PcoreUpdateWalletBalanceParams extends PcoreWalletByIdParams {
  balance: number;
  now: number;
}

export interface PcoreCreateWalletSettlementParams {
  id: string;
  tenantId: string;
  walletId: string;
  taskId: string;
  assignmentId: string;
  totalAmountMinor: number;
  currency: string;
  ownerPct: number;
  personaPct: number;
  platformPct: number;
  ownerAmountMinor: number;
  personaAmountMinor: number;
  platformAmountMinor: number;
  now: number;
}

export interface PcoreSettlePersonaWalletParams extends PcoreWalletByIdParams {
  ownerAmount: number;
  personaAmount: number;
  currency: string;
  now: number;
}

export interface PcoreTaskApplicationParams {
  tenantId: string;
  taskId: string;
  personaId: string;
}

export interface PcoreTaskApplicationsByTaskParams {
  tenantId: string;
  taskId: string;
}

export interface PcoreCreateTaskApplicationParams extends PcoreTaskApplicationParams {
  id: string;
  rankingScore: number;
  now: number;
}

export interface PcoreCreateTaskAssignmentParams extends PcoreTaskApplicationParams {
  id: string;
  applicationId: string;
  now: number;
}

export interface PcoreMarkTaskApplicationsAssignedParams {
  tenantId: string;
  taskId: string;
  applicationId: string;
  now: number;
}

export interface PcoreAcceptMarketplaceTaskAssignmentParams {
  tenantId: string;
  taskId: string;
  personaId: string;
  now: number;
}

export interface PcoreCreateRuntimeSessionParams extends PcoreTenantPersonaParams {
  id: string;
  taskId: string;
  assignmentId: string;
  timeoutAt: number;
  now: number;
}

export interface PcoreAssignmentRuntimeSessionParams {
  tenantId: string;
  assignmentId: string;
  sessionId: string;
}

export interface PcoreRuntimeSessionParams {
  tenantId: string;
  sessionId: string;
}

export interface PcorePlanRuntimeSessionParams extends PcoreRuntimeSessionParams {
  planJson: string;
  now: number;
  timeoutAt: number;
}

export interface PcoreExecuteRuntimeSessionParams extends PcoreRuntimeSessionParams {
  artifactsJson: string;
  now: number;
  timeoutAt: number;
}

export interface PcoreStartTaskAssignmentParams {
  tenantId: string;
  assignmentId: string;
  now: number;
}

export interface PcoreEvaluateRuntimeSessionParams extends PcoreRuntimeSessionParams {
  evaluationJson: string;
  now: number;
  timeoutAt: number;
}

export interface PcoreCompleteRuntimeSessionParams extends PcoreRuntimeSessionParams {
  resultSummaryJson: string;
  now: number;
}

export interface PcoreTimedOutRuntimeSessionsParams {
  now: number;
  limit: number;
}

export interface PcoreRetryRuntimeSessionParams extends PcoreRuntimeSessionParams {
  state: string;
  timeoutAt: number;
  now: number;
  errorJson: string;
}

export interface PcoreTimeoutRuntimeSessionParams extends PcoreRuntimeSessionParams {
  now: number;
  errorJson: string;
}

export interface PcoreCreateTaskResultParams {
  id: string;
  tenantId: string;
  taskId: string;
  assignmentId: string;
  resultUri: string;
  evaluationJson: string;
  now: number;
}

export interface PcoreTaskAssignmentIdParams {
  tenantId: string;
  assignmentId: string;
  now: number;
}

export interface PcoreTouchMarketplaceTaskParams {
  tenantId: string;
  taskId: string;
  now: number;
}

export interface PcoreAcceptTaskResultParams {
  tenantId: string;
  resultId: string;
  qualityScore: number;
  clientRating: number;
  now: number;
}

export interface PcoreCompleteMarketplaceTaskParams {
  tenantId: string;
  taskId: string;
  qualityScore: number;
  growthDelta: number;
  now: number;
}

export interface PcoreUpdatePersonaTaskAcceptedParams extends PcoreTenantPersonaParams {
  growthDelta: number;
  reputationDelta: number;
  now: number;
}

export interface PcoreRejectTaskResultParams {
  tenantId: string;
  resultId: string;
  reason: string;
  now: number;
}

export interface PcoreRejectTaskApplicationParams {
  tenantId: string;
  applicationId: string | null;
  now: number;
}

export interface PcoreReopenMarketplaceTaskParams {
  tenantId: string;
  taskId: string;
  now: number;
}

export interface PcoreDisputeTaskResultParams {
  tenantId: string;
  resultId: string;
  now: number;
}

export interface PcoreCreateGovernanceCaseParams extends PcoreTenantPersonaParams {
  id: string;
  taskId: string | null;
  triggerType: string;
  severity: string;
  detailsJson: string;
  now: number;
}

export interface PcoreCreateGovernanceActionParams {
  id: string;
  tenantId: string;
  caseId: string;
  actionType: string;
  durationSeconds: number | null;
  detailsJson: string;
  actorUserId: string | null;
  now: number;
}

export interface PcoreUpdateGovernanceCaseActionParams {
  tenantId: string;
  caseId: string;
  status: string;
  resolvedAt: number | null;
}

export interface PcoreApplyGovernanceActionToPersonaParams extends PcoreTenantPersonaParams {
  reputationDelta: number;
  nextStatus: string;
  legacyStatus: string;
  now: number;
}

export interface PcoreAppealGovernanceCaseParams {
  tenantId: string;
  caseId: string;
  appealJson: string;
  now: number;
}

/* Wave-23 Params */

export interface PcoreMarketplaceTasksByTenantParams {
  tenantId: string;
  status?: string;
}

export interface PcoreMarketplaceTaskByIdParams {
  tenantId: string;
  taskId: string;
}

export interface PcorePersonaExistsParams {
  tenantId: string;
  ownerUserId: string;
  personaId: string;
}

export interface PcoreForkExistsParams extends PcoreTenantPersonaParams {
  forkId: string;
}

export interface PcoreTaskAssignmentByIdParams {
  tenantId: string;
  assignmentId: string;
}

export interface PcoreLatestTaskAssignmentByTaskParams {
  tenantId: string;
  taskId: string;
}

export interface PcoreLatestTaskAssignmentForPersonaTaskParams {
  tenantId: string;
  personaId: string;
  taskId: string;
}

export interface PcoreLatestTaskResultByAssignmentParams {
  tenantId: string;
  assignmentId: string;
}

export interface PcoreGovernanceCaseByIdParams {
  tenantId: string;
  caseId: string;
}

export interface PcoreGovernanceActionByIdParams {
  tenantId: string;
  actionId: string;
}

export interface PcorePersonaByIdParams {
  tenantId: string;
  personaId: string;
}

export interface PcoreWalletPayoutRequestByIdParams {
  tenantId: string;
  payoutId: string;
}

export interface PcoreWalletSettlementByAssignmentIdParams {
  tenantId: string;
  assignmentId: string;
}

export interface PcoreTransferAccessParams {
  tenantId: string;
  userId: string;
  personaId: string;
}

export interface PcoreUserExistsParams {
  tenantId: string;
  userId: string;
}

export interface PcoreRankingTaskStatsParams extends PcoreTenantPersonaParams {
  category: string;
}

export interface PcoreLastActiveAtParams extends PcoreTenantPersonaParams {}

export interface PcorePublishMarketplaceTaskParams {
  id: string;
  tenantId: string;
  publisherUserId: string;
  title: string;
  description: string;
  category: string;
  reward: number;
  currency: string;
  now: number;
}

export interface PcoreAcceptMarketplaceTaskLegacyParams {
  tenantId: string;
  taskId: string;
  personaId: string;
  forkId: string | null;
  now: number;
}

export interface PcoreCompleteTaskWalletUpdateParams {
  tenantId: string;
  personaId: string;
  payout: number;
  tokenReward: number;
  now: number;
}

export interface PcoreCompleteTaskPersonaUpdateParams extends PcoreTenantPersonaParams {
  growthDelta: number;
  reputationDelta: number;
  ownerTrainingHours: number;
  now: number;
}

export interface PcoreInsertWalletTransactionParams {
  id: string;
  tenantId: string;
  walletId: string;
  transactionType: string;
  amountMinor: number;
  currency: string;
  referenceType: string | null;
  referenceId: string | null;
  now: number;
}

export interface PcoreInsertReputationHistoryParams {
  id: string;
  tenantId: string;
  personaId: string;
  oldScore: number;
  newScore: number;
  reason: string;
  now: number;
}

export interface PcoreInsertGrowthEventParams {
  id: string;
  tenantId: string;
  personaId: string;
  taskId: string | null;
  eventType: string;
  growthDelta: number;
  reputationDelta: number;
  trainingDelta: number;
  payloadJson: string;
  now: number;
}

export interface PcoreInsertGovernanceEventParams {
  id: string;
  tenantId: string;
  personaId: string;
  eventType: string;
  severity: number;
  summary: string;
  payloadJson: string;
  actorUserId: string | null;
  now: number;
}

export interface PcoreInsertMemoryParams {
  id: string;
  tenantId: string;
  personaId: string;
  forkId: string | null;
  kind: string;
  sensitivity: string;
  isEncrypted: number;
  ownerRestricted: number;
  summary: string;
  contentJson: string;
  importance: number;
  now: number;
}

/* Query factories */

export function pcoreQuerySummariesByOwner(params: PcoreTenantOwnerParams): Query<PcorePersonaSummaryRow, PcoreTenantOwnerParams> {
  return { kind: PCORE_QUERY_SUMMARIES_BY_OWNER, params };
}

export function pcoreQuerySummaryByOwner(params: PcoreSummaryByOwnerParams): Query<PcorePersonaSummaryRow | null, PcoreSummaryByOwnerParams> {
  return { kind: PCORE_QUERY_SUMMARY_BY_OWNER, params };
}

export function pcoreQueryForksByPersona(params: PcoreTenantPersonaParams): Query<PcoreForkRow, PcoreTenantPersonaParams> {
  return { kind: PCORE_QUERY_FORKS_BY_PERSONA, params };
}

export function pcoreQueryRecentMemories(params: PcoreTenantPersonaParams): Query<PcoreMemoryRow, PcoreTenantPersonaParams> {
  return { kind: PCORE_QUERY_RECENT_MEMORIES, params };
}

export function pcoreQueryRecentKnowledge(params: PcoreTenantPersonaParams): Query<PcoreKnowledgeRow, PcoreTenantPersonaParams> {
  return { kind: PCORE_QUERY_RECENT_KNOWLEDGE, params };
}

export function pcoreQueryRecentGrowthEvents(params: PcoreTenantPersonaParams): Query<PcoreGrowthEventRow, PcoreTenantPersonaParams> {
  return { kind: PCORE_QUERY_RECENT_GROWTH_EVENTS, params };
}

export function pcoreQueryRecentGovernanceEvents(params: PcoreTenantPersonaParams): Query<PcoreGovernanceEventRow, PcoreTenantPersonaParams> {
  return { kind: PCORE_QUERY_RECENT_GOVERNANCE_EVENTS, params };
}

export function pcoreQueryRecentMarketplaceTasks(params: PcoreRecentMarketplaceTasksParams): Query<PcoreMarketplaceTaskRow, PcoreRecentMarketplaceTasksParams> {
  return { kind: PCORE_QUERY_RECENT_MARKETPLACE_TASKS, params };
}

export function pcoreQueryPendingTransfer(params: PcoreTenantPersonaParams): Query<PcoreTransferRow | null, PcoreTenantPersonaParams> {
  return { kind: PCORE_QUERY_PENDING_TRANSFER, params };
}

export function pcoreQueryTransferByPersonaId(params: PcoreTransferByPersonaIdParams): Query<PcoreTransferRow | null, PcoreTransferByPersonaIdParams> {
  return { kind: PCORE_QUERY_TRANSFER_BY_PERSONA_ID, params };
}

export function pcoreQueryTransferById(params: PcoreTransferByIdParams): Query<PcoreTransferRow | null, PcoreTransferByIdParams> {
  return { kind: PCORE_QUERY_TRANSFER_BY_ID, params };
}

export function pcoreQueryTransfersByPersona(params: PcoreTenantPersonaParams): Query<PcoreTransferRow, PcoreTenantPersonaParams> {
  return { kind: PCORE_QUERY_TRANSFERS_BY_PERSONA, params };
}

export function pcoreQueryCompletedTaskCount(params: PcoreTenantPersonaParams): Query<PcoreCountRow | null, PcoreTenantPersonaParams> {
  return { kind: PCORE_QUERY_COMPLETED_TASK_COUNT, params };
}

export function pcoreQueryGovernancePenaltyCount(params: PcoreTenantPersonaParams): Query<PcoreCountRow | null, PcoreTenantPersonaParams> {
  return { kind: PCORE_QUERY_GOVERNANCE_PENALTY_COUNT, params };
}

export function pcoreQueryReputationHistory(params: PcoreTenantPersonaParams): Query<PcoreReputationHistoryRow, PcoreTenantPersonaParams> {
  return { kind: PCORE_QUERY_REPUTATION_HISTORY, params };
}

export function pcoreQueryActivePersonasForRanking(tenantId: string): Query<PcorePersonaSummaryRow, string> {
  return { kind: PCORE_QUERY_ACTIVE_PERSONAS_FOR_RANKING, params: tenantId };
}

export function pcoreQueryMemoryCount(params: PcoreTenantPersonaParams): Query<PcoreCountRow | null, PcoreTenantPersonaParams> {
  return { kind: PCORE_QUERY_MEMORY_COUNT, params };
}

export function pcoreQueryGovernanceEventCount(params: PcoreTenantPersonaParams): Query<PcoreCountRow | null, PcoreTenantPersonaParams> {
  return { kind: PCORE_QUERY_GOVERNANCE_EVENT_COUNT, params };
}

export function pcoreQueryMarketplaceAnalytics(tenantId: string): Query<PcoreMarketplaceAnalyticsRow | null, string> {
  return { kind: PCORE_QUERY_MARKETPLACE_ANALYTICS, params: tenantId };
}

export function pcoreQueryDailyPersonas(tenantId: string): Query<PcoreDailyPersonaRow, string> {
  return { kind: PCORE_QUERY_DAILY_PERSONAS, params: tenantId };
}

export function pcoreQueryDailyCompletedTaskCount(params: PcoreTaskCountByDateParams): Query<PcoreCountRow | null, PcoreTaskCountByDateParams> {
  return { kind: PCORE_QUERY_DAILY_COMPLETED_TASK_COUNT, params };
}

export function pcoreQueryDailyPersonaRevenue(params: PcoreRevenueByDateParams): Query<PcoreTotalRow | null, PcoreRevenueByDateParams> {
  return { kind: PCORE_QUERY_DAILY_PERSONA_REVENUE, params };
}

/** 批量：整租户当日完成数按 persona 分组（消 N+1） */
export function pcoreQueryDailyCompletedTaskCountByPersona(params: PcoreDateRangeParams): Query<PcorePersonaCountRow, PcoreDateRangeParams> {
  return { kind: PCORE_QUERY_DAILY_COMPLETED_TASK_COUNT_BY_PERSONA, params };
}

/** 批量：整租户当日收益按 persona 分组（消 N+1） */
export function pcoreQueryDailyPersonaRevenueByPersona(params: PcoreDateRangeParams): Query<PcorePersonaTotalRow, PcoreDateRangeParams> {
  return { kind: PCORE_QUERY_DAILY_PERSONA_REVENUE_BY_PERSONA, params };
}

export function pcoreQueryDailyMarketplaceAnalytics(params: PcoreDailyMarketplaceAnalyticsParams): Query<PcoreDailyMarketplaceAnalyticsRow | null, PcoreDailyMarketplaceAnalyticsParams> {
  return { kind: PCORE_QUERY_DAILY_MARKETPLACE_ANALYTICS, params };
}

export function pcoreQueryEconomyAnalytics(tenantId: string): Query<PcoreEconomyAnalyticsRow | null, string> {
  return { kind: PCORE_QUERY_ECONOMY_ANALYTICS, params: tenantId };
}

export function pcoreQueryPersonaMemories(params: PcorePersonaMemoriesParams): Query<PcoreMemoryRow, PcorePersonaMemoriesParams> {
  return { kind: PCORE_QUERY_PERSONA_MEMORIES, params };
}

export function pcoreQueryMemoryKindCounts(params: PcoreTenantPersonaParams): Query<PcoreMemoryCountByKindRow, PcoreTenantPersonaParams> {
  return { kind: PCORE_QUERY_MEMORY_KIND_COUNTS, params };
}

export function pcoreQueryMemoryRelationCounts(params: PcoreTenantPersonaParams): Query<PcoreMemoryCountByRelationRow, PcoreTenantPersonaParams> {
  return { kind: PCORE_QUERY_MEMORY_RELATION_COUNTS, params };
}

export function pcoreQueryMemoryNodeIds(params: PcoreMemoryNodeIdsParams): Query<PcoreMemoryNodeIdRow, PcoreMemoryNodeIdsParams> {
  return { kind: PCORE_QUERY_MEMORY_NODE_IDS, params };
}

export function pcoreQueryMemoryEdges(params: PcoreMemoryEdgesParams): Query<PcoreMemoryEdgeRow, PcoreMemoryEdgesParams> {
  return { kind: PCORE_QUERY_MEMORY_EDGES, params };
}

export function pcoreQueryWalletByPersona(params: PcoreTenantPersonaParams): Query<PcoreWalletRow | null, PcoreTenantPersonaParams> {
  return { kind: PCORE_QUERY_WALLET_BY_PERSONA, params };
}

export function pcoreQueryWalletByIdForOwner(params: PcoreWalletByIdParams): Query<PcoreWalletForOwnerRow | null, PcoreWalletByIdParams> {
  return { kind: PCORE_QUERY_WALLET_BY_ID_FOR_OWNER, params };
}

export function pcoreQueryWalletTransactions(params: PcoreWalletByIdParams): Query<PcoreWalletTransactionRow, PcoreWalletByIdParams> {
  return { kind: PCORE_QUERY_WALLET_TRANSACTIONS, params };
}

export function pcoreQueryTaskApplication(params: PcoreTaskApplicationParams): Query<PcoreTaskApplicationRow | null, PcoreTaskApplicationParams> {
  return { kind: PCORE_QUERY_TASK_APPLICATION, params };
}

export function pcoreQueryTaskApplicationsByTask(params: PcoreTaskApplicationsByTaskParams): Query<PcoreTaskApplicantRow, PcoreTaskApplicationsByTaskParams> {
  return { kind: PCORE_QUERY_TASK_APPLICATIONS_BY_TASK, params };
}

export function pcoreQueryRuntimeSession(params: PcoreRuntimeSessionParams): Query<PcoreRuntimeSessionRow | null, PcoreRuntimeSessionParams> {
  return { kind: PCORE_QUERY_RUNTIME_SESSION, params };
}

export function pcoreQueryTimedOutRuntimeSessions(params: PcoreTimedOutRuntimeSessionsParams): Query<PcoreRuntimeSessionRow, PcoreTimedOutRuntimeSessionsParams> {
  return { kind: PCORE_QUERY_TIMED_OUT_RUNTIME_SESSIONS, params };
}

export function pcoreQueryGovernanceCasesByPersona(params: PcoreTenantPersonaParams): Query<PcoreGovernanceCaseRow, PcoreTenantPersonaParams> {
  return { kind: PCORE_QUERY_GOVERNANCE_CASES_BY_PERSONA, params };
}

/* Wave-23 Query factories */

export function pcoreQueryMarketplaceTasksByTenant(params: PcoreMarketplaceTasksByTenantParams): Query<PcoreMarketplaceTaskRow, PcoreMarketplaceTasksByTenantParams> {
  return { kind: PCORE_QUERY_MARKETPLACE_TASKS_BY_TENANT, params };
}

export function pcoreQueryMarketplaceTaskById(params: PcoreMarketplaceTaskByIdParams): Query<PcoreMarketplaceTaskRow | null, PcoreMarketplaceTaskByIdParams> {
  return { kind: PCORE_QUERY_MARKETPLACE_TASK_BY_ID, params };
}

export function pcoreQueryPersonaExists(params: PcorePersonaExistsParams): Query<PcoreExistsRow | null, PcorePersonaExistsParams> {
  return { kind: PCORE_QUERY_PERSONA_EXISTS, params };
}

export function pcoreQueryForkExists(params: PcoreForkExistsParams): Query<PcoreExistsRow | null, PcoreForkExistsParams> {
  return { kind: PCORE_QUERY_FORK_EXISTS, params };
}

export function pcoreQueryTaskAssignmentById(params: PcoreTaskAssignmentByIdParams): Query<PcoreTaskAssignmentRow | null, PcoreTaskAssignmentByIdParams> {
  return { kind: PCORE_QUERY_TASK_ASSIGNMENT_BY_ID, params };
}

export function pcoreQueryLatestTaskAssignmentByTask(params: PcoreLatestTaskAssignmentByTaskParams): Query<PcoreTaskAssignmentRow | null, PcoreLatestTaskAssignmentByTaskParams> {
  return { kind: PCORE_QUERY_LATEST_TASK_ASSIGNMENT_BY_TASK, params };
}

export function pcoreQueryLatestTaskAssignmentForPersonaTask(params: PcoreLatestTaskAssignmentForPersonaTaskParams): Query<PcoreTaskAssignmentRow | null, PcoreLatestTaskAssignmentForPersonaTaskParams> {
  return { kind: PCORE_QUERY_LATEST_TASK_ASSIGNMENT_FOR_PERSONA_TASK, params };
}

export function pcoreQueryLatestTaskResultByAssignment(params: PcoreLatestTaskResultByAssignmentParams): Query<PcoreTaskResultRow | null, PcoreLatestTaskResultByAssignmentParams> {
  return { kind: PCORE_QUERY_LATEST_TASK_RESULT_BY_ASSIGNMENT, params };
}

export function pcoreQueryGovernanceCaseById(params: PcoreGovernanceCaseByIdParams): Query<PcoreGovernanceCaseRow | null, PcoreGovernanceCaseByIdParams> {
  return { kind: PCORE_QUERY_GOVERNANCE_CASE_BY_ID, params };
}

export function pcoreQueryGovernanceActionById(params: PcoreGovernanceActionByIdParams): Query<PcoreGovernanceActionRow | null, PcoreGovernanceActionByIdParams> {
  return { kind: PCORE_QUERY_GOVERNANCE_ACTION_BY_ID, params };
}

export function pcoreQueryPersonaById(params: PcorePersonaByIdParams): Query<PcorePersonaRow | null, PcorePersonaByIdParams> {
  return { kind: PCORE_QUERY_PERSONA_BY_ID, params };
}

export function pcoreQueryWalletByPersonaId(params: PcoreTenantPersonaParams): Query<PcoreWalletRow | null, PcoreTenantPersonaParams> {
  return { kind: PCORE_QUERY_WALLET_BY_PERSONA_ID, params };
}

export function pcoreQueryWalletPayoutRequestById(params: PcoreWalletPayoutRequestByIdParams): Query<PcoreWalletPayoutRequestRow | null, PcoreWalletPayoutRequestByIdParams> {
  return { kind: PCORE_QUERY_WALLET_PAYOUT_REQUEST_BY_ID, params };
}

export function pcoreQueryWalletSettlementByAssignmentId(params: PcoreWalletSettlementByAssignmentIdParams): Query<PcoreWalletSettlementRow | null, PcoreWalletSettlementByAssignmentIdParams> {
  return { kind: PCORE_QUERY_WALLET_SETTLEMENT_BY_ASSIGNMENT_ID, params };
}

export function pcoreQueryTransferAccess(params: PcoreTransferAccessParams): Query<PcoreExistsRow | null, PcoreTransferAccessParams> {
  return { kind: PCORE_QUERY_TRANSFER_ACCESS, params };
}

export function pcoreQueryUserExists(params: PcoreUserExistsParams): Query<PcoreExistsRow | null, PcoreUserExistsParams> {
  return { kind: PCORE_QUERY_USER_EXISTS, params };
}

export function pcoreQueryRankingTaskStats(params: PcoreRankingTaskStatsParams): Query<PcoreRankingTaskStatsRow | null, PcoreRankingTaskStatsParams> {
  return { kind: PCORE_QUERY_RANKING_TASK_STATS, params };
}

export function pcoreQueryRankingTaskStatsUncategorized(params: PcoreTenantPersonaParams): Query<PcoreRankingTaskStatsRow | null, PcoreTenantPersonaParams> {
  return { kind: PCORE_QUERY_RANKING_TASK_STATS_UNCATEGORIZED, params };
}

export function pcoreQueryLastActiveAt(params: PcoreLastActiveAtParams): Query<PcoreLastActiveAtRow | null, PcoreLastActiveAtParams> {
  return { kind: PCORE_QUERY_LAST_ACTIVE_AT, params };
}

/* Command factories */

export function pcoreCmdCreatePersona(params: PcoreCreatePersonaParams): Command<PcoreCreatePersonaParams> {
  return { kind: PCORE_CMD_CREATE_PERSONA, params };
}

export function pcoreCmdCreateWallet(params: PcoreCreateWalletParams): Command<PcoreCreateWalletParams> {
  return { kind: PCORE_CMD_CREATE_WALLET, params };
}

export function pcoreCmdCreateKnowledgeItem(params: PcoreCreateKnowledgeItemParams): Command<PcoreCreateKnowledgeItemParams> {
  return { kind: PCORE_CMD_CREATE_KNOWLEDGE_ITEM, params };
}

export function pcoreCmdActivatePersona(params: PcoreSetPersonaStatusParams): Command<PcoreSetPersonaStatusParams> {
  return { kind: PCORE_CMD_ACTIVATE_PERSONA, params };
}

export function pcoreCmdDeactivatePersona(params: PcoreSetPersonaStatusParams): Command<PcoreSetPersonaStatusParams> {
  return { kind: PCORE_CMD_DEACTIVATE_PERSONA, params };
}

export function pcoreCmdCreateTransfer(params: PcoreCreateTransferParams): Command<PcoreCreateTransferParams> {
  return { kind: PCORE_CMD_CREATE_TRANSFER, params };
}

export function pcoreCmdApproveTransfer(params: PcoreApproveTransferParams): Command<PcoreApproveTransferParams> {
  return { kind: PCORE_CMD_APPROVE_TRANSFER, params };
}

export function pcoreCmdTransferPersonaOwner(params: PcoreTransferPersonaOwnerParams): Command<PcoreTransferPersonaOwnerParams> {
  return { kind: PCORE_CMD_TRANSFER_PERSONA_OWNER, params };
}

export function pcoreCmdCompleteTransfer(params: PcoreApproveTransferParams): Command<PcoreApproveTransferParams> {
  return { kind: PCORE_CMD_COMPLETE_TRANSFER, params };
}

export function pcoreCmdUpsertPersonaDailyMetric(params: PcoreUpsertPersonaDailyMetricParams): Command<PcoreUpsertPersonaDailyMetricParams> {
  return { kind: PCORE_CMD_UPSERT_PERSONA_DAILY_METRIC, params };
}

export function pcoreCmdUpsertMarketplaceDailyMetric(params: PcoreUpsertMarketplaceDailyMetricParams): Command<PcoreUpsertMarketplaceDailyMetricParams> {
  return { kind: PCORE_CMD_UPSERT_MARKETPLACE_DAILY_METRIC, params };
}

export function pcoreCmdCreateFork(params: PcoreCreateForkParams): Command<PcoreCreateForkParams> {
  return { kind: PCORE_CMD_CREATE_FORK, params };
}

export function pcoreCmdUpdatePersonaKnowledgeSync(params: PcoreUpdatePersonaKnowledgeSyncParams): Command<PcoreUpdatePersonaKnowledgeSyncParams> {
  return { kind: PCORE_CMD_UPDATE_PERSONA_KNOWLEDGE_SYNC, params };
}

export function pcoreCmdApplyGovernanceEvent(params: PcoreApplyGovernanceEventParams): Command<PcoreApplyGovernanceEventParams> {
  return { kind: PCORE_CMD_APPLY_GOVERNANCE_EVENT, params };
}

export function pcoreCmdCreateWalletPayoutRequest(params: PcoreCreateWalletPayoutRequestParams): Command<PcoreCreateWalletPayoutRequestParams> {
  return { kind: PCORE_CMD_CREATE_WALLET_PAYOUT_REQUEST, params };
}

export function pcoreCmdUpdateWalletBalance(params: PcoreUpdateWalletBalanceParams): Command<PcoreUpdateWalletBalanceParams> {
  return { kind: PCORE_CMD_UPDATE_WALLET_BALANCE, params };
}

export function pcoreCmdCreateWalletSettlement(params: PcoreCreateWalletSettlementParams): Command<PcoreCreateWalletSettlementParams> {
  return { kind: PCORE_CMD_CREATE_WALLET_SETTLEMENT, params };
}

export function pcoreCmdSettlePersonaWallet(params: PcoreSettlePersonaWalletParams): Command<PcoreSettlePersonaWalletParams> {
  return { kind: PCORE_CMD_SETTLE_PERSONA_WALLET, params };
}

export function pcoreCmdCreateTaskApplication(params: PcoreCreateTaskApplicationParams): Command<PcoreCreateTaskApplicationParams> {
  return { kind: PCORE_CMD_CREATE_TASK_APPLICATION, params };
}

export function pcoreCmdCreateTaskAssignment(params: PcoreCreateTaskAssignmentParams): Command<PcoreCreateTaskAssignmentParams> {
  return { kind: PCORE_CMD_CREATE_TASK_ASSIGNMENT, params };
}

export function pcoreCmdMarkTaskApplicationsAssigned(params: PcoreMarkTaskApplicationsAssignedParams): Command<PcoreMarkTaskApplicationsAssignedParams> {
  return { kind: PCORE_CMD_MARK_TASK_APPLICATIONS_ASSIGNED, params };
}

export function pcoreCmdAcceptMarketplaceTaskAssignment(params: PcoreAcceptMarketplaceTaskAssignmentParams): Command<PcoreAcceptMarketplaceTaskAssignmentParams> {
  return { kind: PCORE_CMD_ACCEPT_MARKETPLACE_TASK_ASSIGNMENT, params };
}

export function pcoreCmdCreateRuntimeSession(params: PcoreCreateRuntimeSessionParams): Command<PcoreCreateRuntimeSessionParams> {
  return { kind: PCORE_CMD_CREATE_RUNTIME_SESSION, params };
}

export function pcoreCmdLinkTaskAssignmentRuntimeSession(params: PcoreAssignmentRuntimeSessionParams): Command<PcoreAssignmentRuntimeSessionParams> {
  return { kind: PCORE_CMD_LINK_TASK_ASSIGNMENT_RUNTIME_SESSION, params };
}

export function pcoreCmdPlanRuntimeSession(params: PcorePlanRuntimeSessionParams): Command<PcorePlanRuntimeSessionParams> {
  return { kind: PCORE_CMD_PLAN_RUNTIME_SESSION, params };
}

export function pcoreCmdExecuteRuntimeSession(params: PcoreExecuteRuntimeSessionParams): Command<PcoreExecuteRuntimeSessionParams> {
  return { kind: PCORE_CMD_EXECUTE_RUNTIME_SESSION, params };
}

export function pcoreCmdStartTaskAssignment(params: PcoreStartTaskAssignmentParams): Command<PcoreStartTaskAssignmentParams> {
  return { kind: PCORE_CMD_START_TASK_ASSIGNMENT, params };
}

export function pcoreCmdEvaluateRuntimeSession(params: PcoreEvaluateRuntimeSessionParams): Command<PcoreEvaluateRuntimeSessionParams> {
  return { kind: PCORE_CMD_EVALUATE_RUNTIME_SESSION, params };
}

export function pcoreCmdCompleteRuntimeSession(params: PcoreCompleteRuntimeSessionParams): Command<PcoreCompleteRuntimeSessionParams> {
  return { kind: PCORE_CMD_COMPLETE_RUNTIME_SESSION, params };
}

export function pcoreCmdRetryRuntimeSession(params: PcoreRetryRuntimeSessionParams): Command<PcoreRetryRuntimeSessionParams> {
  return { kind: PCORE_CMD_RETRY_RUNTIME_SESSION, params };
}

export function pcoreCmdTimeoutRuntimeSession(params: PcoreTimeoutRuntimeSessionParams): Command<PcoreTimeoutRuntimeSessionParams> {
  return { kind: PCORE_CMD_TIMEOUT_RUNTIME_SESSION, params };
}

export function pcoreCmdCreateTaskResult(params: PcoreCreateTaskResultParams): Command<PcoreCreateTaskResultParams> {
  return { kind: PCORE_CMD_CREATE_TASK_RESULT, params };
}

export function pcoreCmdSubmitTaskAssignment(params: PcoreTaskAssignmentIdParams): Command<PcoreTaskAssignmentIdParams> {
  return { kind: PCORE_CMD_SUBMIT_TASK_ASSIGNMENT, params };
}

export function pcoreCmdTouchMarketplaceTask(params: PcoreTouchMarketplaceTaskParams): Command<PcoreTouchMarketplaceTaskParams> {
  return { kind: PCORE_CMD_TOUCH_MARKETPLACE_TASK, params };
}

export function pcoreCmdAcceptTaskResult(params: PcoreAcceptTaskResultParams): Command<PcoreAcceptTaskResultParams> {
  return { kind: PCORE_CMD_ACCEPT_TASK_RESULT, params };
}

export function pcoreCmdAcceptTaskAssignment(params: PcoreTaskAssignmentIdParams): Command<PcoreTaskAssignmentIdParams> {
  return { kind: PCORE_CMD_ACCEPT_TASK_ASSIGNMENT, params };
}

export function pcoreCmdCompleteMarketplaceTask(params: PcoreCompleteMarketplaceTaskParams): Command<PcoreCompleteMarketplaceTaskParams> {
  return { kind: PCORE_CMD_COMPLETE_MARKETPLACE_TASK, params };
}

export function pcoreCmdUpdatePersonaTaskAccepted(params: PcoreUpdatePersonaTaskAcceptedParams): Command<PcoreUpdatePersonaTaskAcceptedParams> {
  return { kind: PCORE_CMD_UPDATE_PERSONA_TASK_ACCEPTED, params };
}

export function pcoreCmdRejectTaskResult(params: PcoreRejectTaskResultParams): Command<PcoreRejectTaskResultParams> {
  return { kind: PCORE_CMD_REJECT_TASK_RESULT, params };
}

export function pcoreCmdRejectTaskAssignment(params: PcoreTaskAssignmentIdParams): Command<PcoreTaskAssignmentIdParams> {
  return { kind: PCORE_CMD_REJECT_TASK_ASSIGNMENT, params };
}

export function pcoreCmdRejectTaskApplication(params: PcoreRejectTaskApplicationParams): Command<PcoreRejectTaskApplicationParams> {
  return { kind: PCORE_CMD_REJECT_TASK_APPLICATION, params };
}

export function pcoreCmdReopenMarketplaceTask(params: PcoreReopenMarketplaceTaskParams): Command<PcoreReopenMarketplaceTaskParams> {
  return { kind: PCORE_CMD_REOPEN_MARKETPLACE_TASK, params };
}

export function pcoreCmdDisputeTaskAssignment(params: PcoreTaskAssignmentIdParams): Command<PcoreTaskAssignmentIdParams> {
  return { kind: PCORE_CMD_DISPUTE_TASK_ASSIGNMENT, params };
}

export function pcoreCmdDisputeTaskResult(params: PcoreDisputeTaskResultParams): Command<PcoreDisputeTaskResultParams> {
  return { kind: PCORE_CMD_DISPUTE_TASK_RESULT, params };
}

export function pcoreCmdCreateGovernanceCase(params: PcoreCreateGovernanceCaseParams): Command<PcoreCreateGovernanceCaseParams> {
  return { kind: PCORE_CMD_CREATE_GOVERNANCE_CASE, params };
}

export function pcoreCmdCreateGovernanceAction(params: PcoreCreateGovernanceActionParams): Command<PcoreCreateGovernanceActionParams> {
  return { kind: PCORE_CMD_CREATE_GOVERNANCE_ACTION, params };
}

export function pcoreCmdUpdateGovernanceCaseAction(params: PcoreUpdateGovernanceCaseActionParams): Command<PcoreUpdateGovernanceCaseActionParams> {
  return { kind: PCORE_CMD_UPDATE_GOVERNANCE_CASE_ACTION, params };
}

export function pcoreCmdApplyGovernanceActionToPersona(params: PcoreApplyGovernanceActionToPersonaParams): Command<PcoreApplyGovernanceActionToPersonaParams> {
  return { kind: PCORE_CMD_APPLY_GOVERNANCE_ACTION_TO_PERSONA, params };
}

export function pcoreCmdAppealGovernanceCase(params: PcoreAppealGovernanceCaseParams): Command<PcoreAppealGovernanceCaseParams> {
  return { kind: PCORE_CMD_APPEAL_GOVERNANCE_CASE, params };
}

/* Wave-23 Command factories */

export function pcoreCmdPublishMarketplaceTask(params: PcorePublishMarketplaceTaskParams): Command<PcorePublishMarketplaceTaskParams> {
  return { kind: PCORE_CMD_PUBLISH_MARKETPLACE_TASK, params };
}

export function pcoreCmdAcceptMarketplaceTaskLegacy(params: PcoreAcceptMarketplaceTaskLegacyParams): Command<PcoreAcceptMarketplaceTaskLegacyParams> {
  return { kind: PCORE_CMD_ACCEPT_MARKETPLACE_TASK_LEGACY, params };
}

export function pcoreCmdCompleteTaskWalletUpdate(params: PcoreCompleteTaskWalletUpdateParams): Command<PcoreCompleteTaskWalletUpdateParams> {
  return { kind: PCORE_CMD_COMPLETE_TASK_WALLET_UPDATE, params };
}

export function pcoreCmdCompleteTaskPersonaUpdate(params: PcoreCompleteTaskPersonaUpdateParams): Command<PcoreCompleteTaskPersonaUpdateParams> {
  return { kind: PCORE_CMD_COMPLETE_TASK_PERSONA_UPDATE, params };
}

export function pcoreCmdInsertWalletTransaction(params: PcoreInsertWalletTransactionParams): Command<PcoreInsertWalletTransactionParams> {
  return { kind: PCORE_CMD_INSERT_WALLET_TRANSACTION, params };
}

export function pcoreCmdInsertReputationHistory(params: PcoreInsertReputationHistoryParams): Command<PcoreInsertReputationHistoryParams> {
  return { kind: PCORE_CMD_INSERT_REPUTATION_HISTORY, params };
}

export function pcoreCmdInsertGrowthEvent(params: PcoreInsertGrowthEventParams): Command<PcoreInsertGrowthEventParams> {
  return { kind: PCORE_CMD_INSERT_GROWTH_EVENT, params };
}

export function pcoreCmdInsertGovernanceEvent(params: PcoreInsertGovernanceEventParams): Command<PcoreInsertGovernanceEventParams> {
  return { kind: PCORE_CMD_INSERT_GOVERNANCE_EVENT, params };
}

export function pcoreCmdInsertMemory(params: PcoreInsertMemoryParams): Command<PcoreInsertMemoryParams> {
  return { kind: PCORE_CMD_INSERT_MEMORY, params };
}
