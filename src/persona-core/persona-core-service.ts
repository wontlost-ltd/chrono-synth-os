import type { FieldEncryption } from '../storage/encryption.js';
import type { SyncWriteUnitOfWork } from '@chrono/kernel';
import {
  pcoreCmdActivatePersona,
  pcoreCmdApproveTransfer,
  pcoreCmdCompleteTransfer,
  pcoreCmdAcceptMarketplaceTaskAssignment,
  pcoreCmdAcceptTaskAssignment,
  pcoreCmdAcceptTaskResult,
  pcoreCmdApplyGovernanceEvent,
  pcoreCmdCompleteMarketplaceTask,
  pcoreCmdCompleteRuntimeSession,
  pcoreCmdAppealGovernanceCase,
  pcoreCmdApplyGovernanceActionToPersona,
  pcoreCmdCreateFork,
  pcoreCmdCreateGovernanceAction,
  pcoreCmdCreateGovernanceCase,
  pcoreCmdCreateRuntimeSession,
  pcoreCmdCreateTaskApplication,
  pcoreCmdCreateTaskAssignment,
  pcoreCmdCreateTaskResult,
  pcoreCmdCreateWalletSettlement,
  pcoreCmdDisputeTaskAssignment,
  pcoreCmdDisputeTaskResult,
  pcoreCmdEvaluateRuntimeSession,
  pcoreCmdExecuteRuntimeSession,
  pcoreCmdLinkTaskAssignmentRuntimeSession,
  pcoreCmdMarkTaskApplicationsAssigned,
  pcoreCmdPlanRuntimeSession,
  pcoreCmdRetryRuntimeSession,
  pcoreCmdRejectTaskApplication,
  pcoreCmdRejectTaskAssignment,
  pcoreCmdRejectTaskResult,
  pcoreCmdReopenMarketplaceTask,
  pcoreCmdSettlePersonaWallet,
  pcoreCmdStartTaskAssignment,
  pcoreCmdSubmitTaskAssignment,
  pcoreCmdTimeoutRuntimeSession,
  pcoreCmdTouchMarketplaceTask,
  pcoreCmdUpdatePersonaKnowledgeSync,
  pcoreCmdUpdatePersonaTaskAccepted,
  pcoreCmdUpdateGovernanceCaseAction,
  pcoreCmdCreateKnowledgeItem,
  pcoreCmdCreatePersona,
  pcoreCmdCreateTransfer,
  pcoreCmdCreateWallet,
  pcoreCmdDeactivatePersona,
  pcoreCmdTransferPersonaOwner,
  pcoreCmdUpsertMarketplaceDailyMetric,
  pcoreCmdUpsertPersonaDailyMetric,
  pcoreQueryActivePersonasForRanking,
  pcoreQueryCompletedTaskCount,
  pcoreQueryDailyCompletedTaskCount,
  pcoreQueryDailyMarketplaceAnalytics,
  pcoreQueryDailyPersonaRevenue,
  pcoreQueryDailyPersonas,
  pcoreQueryEconomyAnalytics,
  pcoreQueryForksByPersona,
  pcoreQueryGovernanceEventCount,
  pcoreQueryGovernancePenaltyCount,
  pcoreQueryGovernanceCasesByPersona,
  pcoreQueryMarketplaceAnalytics,
  pcoreQueryMemoryCount,
  pcoreQueryPendingTransfer,
  pcoreQueryRecentGovernanceEvents,
  pcoreQueryRecentGrowthEvents,
  pcoreQueryRecentKnowledge,
  pcoreQueryRecentMarketplaceTasks,
  pcoreQueryRecentMemories,
  pcoreQueryReputationHistory,
  pcoreQueryRuntimeSession,
  pcoreQuerySummariesByOwner,
  pcoreQueryTaskApplication,
  pcoreQueryTimedOutRuntimeSessions,
  pcoreQuerySummaryByOwner,
  pcoreQueryTransferById,
  pcoreQueryTransferByPersonaId,
  pcoreQueryTransfersByPersona,
  pcoreQueryMarketplaceTasksByTenant,
  pcoreQueryMarketplaceTaskById,
  pcoreQueryPersonaExists,
  pcoreQueryForkExists,
  pcoreQueryTaskAssignmentById,
  pcoreQueryLatestTaskAssignmentByTask,
  pcoreQueryLatestTaskAssignmentForPersonaTask,
  pcoreQueryLatestTaskResultByAssignment,
  pcoreQueryGovernanceCaseById,
  pcoreQueryGovernanceActionById,
  pcoreQueryPersonaById,
  pcoreQueryTransferAccess,
  pcoreQueryUserExists,
  pcoreQueryRankingTaskStats,
  pcoreQueryRankingTaskStatsUncategorized,
  pcoreQueryLastActiveAt,
  pcoreCmdPublishMarketplaceTask,
  pcoreCmdAcceptMarketplaceTaskLegacy,
  pcoreCmdCompleteTaskWalletUpdate,
  pcoreCmdCompleteTaskPersonaUpdate,
  pcoreCmdInsertReputationHistory,
  pcoreCmdInsertGrowthEvent,
  pcoreCmdInsertGovernanceEvent,
  type PcorePersonaRow,
  type PcoreForkRow,
  type PcoreKnowledgeRow,
  type PcoreGrowthEventRow,
  type PcoreGovernanceEventRow,
  type PcoreMarketplaceTaskRow,
  type PcoreTransferRow,
  type PcoreReputationHistoryRow,
  type PcoreTaskApplicationRow,
  type PcoreTaskAssignmentRow,
  type PcoreRuntimeSessionRow,
  type PcoreTaskResultRow,
  type PcoreGovernanceCaseRow,
  type PcoreGovernanceActionRow,
} from '@chrono/kernel';
import { registerCoreSelfExecutors } from '../storage/executors/index.js';
import { OBSERVABILITY_TOPIC, publishObservabilityEvent } from '../observability/observability-outbox.js';
import { ensureAuditLogColumns, recordBusinessAuditLog } from '../audit/audit-log-store.js';
import { generatePrefixedId } from '../utils/id-generator.js';
import { PersonaCognitiveMemoryGraph } from './persona-cognitive-memory.js';
/* Shared utilities extracted in the Step 16 split. */
import {
  clamp,
  fromMinor,
  round,
  safeJsonParse,
  toMinor,
} from './persona-core-utils.js';
import { PersonaMemoryService, type PersonaMemoryContext } from './persona-memory-service.js';
import { PersonaWalletService, walletFromRow, type PersonaWalletContext } from './persona-wallet-service.js';
import {
  ACTIVE_RUNTIME_STATES,
  computeRuntimeTimeoutAt,
  isRuntimeTerminalState,
  nextRuntimeRetryState,
  shouldRetryRuntimeSession,
} from './runtime-state-machine.js';
import type {
  AddGovernanceEventInput,
  AddPersonaKnowledgeInput,
  AddPersonaMemoryInput,
  AppealGovernanceCaseInput,
  ApplyGovernanceActionInput,
  ApplyTaskInput,
  ApprovePersonaTransferInput,
  AssignTaskInput,
  AcceptSubmittedTaskInput,
  AcceptMarketplaceTaskInput,
  CompleteMarketplaceTaskInput,
  CreateRuntimeSessionInput,
  CreatePersonaCoreInput,
  CreatePersonaForkInput,
  DailyAnalyticsMaterialization,
  DisputeTaskInput,
  EconomyAnalytics,
  EvaluatePersonaLifecycleInput,
  GovernanceAction,
  GovernanceActionType,
  GovernanceCase,
  GovernanceCaseSeverity,
  MarketplaceAnalytics,
  MarketplaceTask,
  PersonaCore,
  PersonaCoreDetail,
  PersonaCoreSummary,
  PersonaFork,
  PersonaGraphQueryInput,
  PersonaGraphQueryResult,
  PersonaGraphSummary,
  PersonaGovernanceEvent,
  PersonaGrowthEvent,
  PersonaKnowledgeItem,
  PersonaLifecycleEvaluation,
  PersonaMemory,
  PersonaMemorySearchResult,
  PersonaOperatingState,
  PersonaAnalytics,
  PersonaRankingEntry,
  PersonaReputationHistoryEntry,
  PersonaReputationSummary,
  PersonaTransfer,
  PersonaWallet,
  PublishMarketplaceTaskInput,
  RequestWalletPayoutInput,
  RuntimeSession,
  RequestPersonaTransferInput,
  SetPersonaStatusInput,
  SettleTaskPaymentInput,
  SubmitTaskResultInput,
  TaskApplication,
  TaskAssignment,
  TaskWalletSettlement,
  TaskResult,
  RejectSubmittedTaskInput,
  OpenGovernanceCaseInput,
  WalletPayoutRequest,
  WalletTransaction,
} from './types.js';

/* Row types are aliased to the kernel-side interfaces. Kernel rows use
 * `readonly` on every property and store narrowed enums as `string`; the
 * service is the authoritative narrower at the FromRow boundary helpers. */
type PersonaCoreRow = PcorePersonaRow;
/* PersonaWalletRow alias removed — wallet rows are only mapped
 * inside PersonaWalletService now. */
type PersonaForkRow = PcoreForkRow;
/* PersonaMemoryRow alias removed — only used by the extracted
 * PersonaMemoryService. */
type PersonaKnowledgeRow = PcoreKnowledgeRow;
type PersonaGrowthEventRow = PcoreGrowthEventRow;
type PersonaGovernanceEventRow = PcoreGovernanceEventRow;
type MarketplaceTaskRow = PcoreMarketplaceTaskRow;
type PersonaTransferRow = PcoreTransferRow;
type ReputationHistoryRow = PcoreReputationHistoryRow;
type TaskApplicationRow = PcoreTaskApplicationRow;
type TaskAssignmentRow = PcoreTaskAssignmentRow;
type RuntimeSessionRow = PcoreRuntimeSessionRow;
type TaskResultRow = PcoreTaskResultRow;
type GovernanceCaseRow = PcoreGovernanceCaseRow;
type GovernanceActionRow = PcoreGovernanceActionRow;
/* WalletTransactionRow / WalletPayoutRequestRow /
 * WalletSettlementRow aliases removed — the rows are only mapped
 * inside PersonaWalletService now. */

/* Shared utilities moved to ./persona-core-utils.ts as part of the
 * Step 16 split — see imports at the top of this file. */

function personaFromRow(row: PersonaCoreRow): PersonaCore {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    ownerUserId: row.owner_user_id,
    displayName: row.display_name,
    profile: safeJsonParse<Record<string, unknown>>(row.profile_json, {}),
    status: (row.lifecycle_status ?? row.status) as PersonaCore['status'],
    visibility: row.visibility as PersonaCore['visibility'],
    growthIndex: Number(row.growth_index),
    reputation: Number(row.reputation),
    trainingInvestment: Number(row.training_investment),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    deceasedAt: row.deceased_at === null ? null : Number(row.deceased_at),
    transferredAt: row.transferred_at === null ? null : Number(row.transferred_at),
  };
}

/* walletFromRow now lives in persona-wallet-service.ts as part of
 * the Step 16b split. Re-imported above so listPersonas and
 * getPersonaDetail still synthesize wallet snapshots from joined
 * rows without re-implementing the mapping. */

function forkFromRow(row: PersonaForkRow): PersonaFork {
  /* Kernel rows store narrowed enums as plain strings (the Query type
   * surface is provider-agnostic); the persona-core service is the
   * authoritative narrower for this domain. */
  return {
    id: row.id,
    tenantId: row.tenant_id,
    personaId: row.persona_id,
    label: row.label,
    forkType: row.fork_type as PersonaFork['forkType'],
    status: row.status as PersonaFork['status'],
    syncMode: row.sync_mode as PersonaFork['syncMode'],
    experienceFactor: Number(row.experience_factor),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    recycledAt: row.recycled_at === null ? null : Number(row.recycled_at),
  };
}

/* normalizeMemorySensitivity moved to ./persona-core-utils.ts. */

function knowledgeFromRow(row: PersonaKnowledgeRow): PersonaKnowledgeItem {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    personaId: row.persona_id,
    title: row.title,
    content: row.content,
    source: row.source,
    tags: safeJsonParse<string[]>(row.tags_json, []),
    confidence: Number(row.confidence),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function growthEventFromRow(row: PersonaGrowthEventRow): PersonaGrowthEvent {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    personaId: row.persona_id,
    taskId: row.task_id,
    eventType: row.event_type as PersonaGrowthEvent['eventType'],
    growthDelta: Number(row.growth_delta),
    reputationDelta: Number(row.reputation_delta),
    trainingDelta: Number(row.training_delta),
    payload: safeJsonParse<Record<string, unknown>>(row.payload_json, {}),
    createdAt: Number(row.created_at),
  };
}

function governanceEventFromRow(row: PersonaGovernanceEventRow): PersonaGovernanceEvent {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    personaId: row.persona_id,
    eventType: row.event_type as PersonaGovernanceEvent['eventType'],
    severity: Number(row.severity),
    summary: row.summary,
    payload: safeJsonParse<Record<string, unknown>>(row.payload_json, {}),
    actorUserId: row.actor_user_id,
    createdAt: Number(row.created_at),
  };
}

function taskFromRow(row: MarketplaceTaskRow): MarketplaceTask {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    publisherUserId: row.publisher_user_id,
    assigneePersonaId: row.assignee_persona_id,
    assigneeForkId: row.assignee_fork_id,
    assigneePersonaName: row.assignee_persona_name ?? null,
    title: row.title,
    description: row.description,
    category: row.category as MarketplaceTask['category'],
    reward: Number(row.reward),
    currency: row.currency,
    status: row.status as MarketplaceTask['status'],
    qualityScore: row.quality_score === null ? null : Number(row.quality_score),
    growthDelta: row.growth_delta === null ? null : Number(row.growth_delta),
    publishedAt: Number(row.published_at),
    acceptedAt: row.accepted_at === null ? null : Number(row.accepted_at),
    completedAt: row.completed_at === null ? null : Number(row.completed_at),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function transferFromRow(row: PersonaTransferRow): PersonaTransfer {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    personaId: row.persona_id,
    fromOwnerUserId: row.from_owner_user_id,
    toOwnerUserId: row.to_owner_user_id,
    status: row.status as PersonaTransfer['status'],
    reason: row.reason,
    requestedAt: Number(row.requested_at),
    approvedAt: row.approved_at === null ? null : Number(row.approved_at),
    completedAt: row.completed_at === null ? null : Number(row.completed_at),
  };
}

function reputationHistoryFromRow(row: ReputationHistoryRow): PersonaReputationHistoryEntry {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    personaId: row.persona_id,
    oldScore: Number(row.old_score),
    newScore: Number(row.new_score),
    reason: row.reason,
    createdAt: Number(row.created_at),
  };
}

function taskApplicationFromRow(row: TaskApplicationRow): TaskApplication {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    taskId: row.task_id,
    personaId: row.persona_id,
    rankingScore: Number(row.ranking_score),
    status: row.status as TaskApplication['status'],
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function taskAssignmentFromRow(row: TaskAssignmentRow): TaskAssignment {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    taskId: row.task_id,
    personaId: row.persona_id,
    applicationId: row.application_id,
    runtimeSessionId: row.runtime_session_id,
    status: row.status as TaskAssignment['status'],
    assignedAt: Number(row.assigned_at),
    startedAt: row.started_at === null ? null : Number(row.started_at),
    submittedAt: row.submitted_at === null ? null : Number(row.submitted_at),
    completedAt: row.completed_at === null ? null : Number(row.completed_at),
  };
}

function runtimeSessionFromRow(row: RuntimeSessionRow): RuntimeSession {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    personaId: row.persona_id,
    taskId: row.task_id,
    assignmentId: row.assignment_id,
    state: row.state as RuntimeSession['state'],
    retryCount: Number(row.retry_count),
    timeoutAt: row.timeout_at === null ? null : Number(row.timeout_at),
    plan: safeJsonParse<{ steps: string[] } | null>(row.plan_json, null),
    artifacts: safeJsonParse<Array<{ type: string; uri: string }>>(row.artifacts_json, []),
    evaluation: safeJsonParse<Record<string, unknown> | null>(row.evaluation_json, null),
    resultSummary: safeJsonParse<Record<string, unknown> | null>(row.result_summary_json, null),
    error: safeJsonParse<Record<string, unknown> | null>(row.error_json, null),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    completedAt: row.completed_at === null ? null : Number(row.completed_at),
  };
}

function taskResultFromRow(row: TaskResultRow): TaskResult {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    taskId: row.task_id,
    assignmentId: row.assignment_id,
    resultUri: row.result_uri,
    evaluation: safeJsonParse<Record<string, unknown>>(row.evaluation_json, {}),
    qualityScore: row.quality_score === null ? null : Number(row.quality_score),
    clientRating: row.client_rating === null ? null : Number(row.client_rating),
    status: row.status as TaskResult['status'],
    rejectionReason: row.rejection_reason,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    acceptedAt: row.accepted_at === null ? null : Number(row.accepted_at),
    rejectedAt: row.rejected_at === null ? null : Number(row.rejected_at),
    disputedAt: row.disputed_at === null ? null : Number(row.disputed_at),
  };
}

function governanceCaseFromRow(row: GovernanceCaseRow): GovernanceCase {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    personaId: row.persona_id,
    taskId: row.task_id,
    triggerType: row.trigger_type,
    severity: row.severity as GovernanceCase['severity'],
    status: row.status as GovernanceCase['status'],
    details: safeJsonParse<Record<string, unknown>>(row.details_json, {}),
    appeal: safeJsonParse<Record<string, unknown> | null>(row.appeal_json, null),
    openedAt: Number(row.opened_at),
    resolvedAt: row.resolved_at === null ? null : Number(row.resolved_at),
    appealedAt: row.appealed_at === null ? null : Number(row.appealed_at),
  };
}

function governanceActionFromRow(row: GovernanceActionRow): GovernanceAction {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    caseId: row.case_id,
    actionType: row.action_type as GovernanceAction['actionType'],
    durationSeconds: row.duration_seconds === null ? null : Number(row.duration_seconds),
    details: safeJsonParse<Record<string, unknown>>(row.details_json, {}),
    actorUserId: row.actor_user_id,
    createdAt: Number(row.created_at),
  };
}

/* walletTransactionFromRow / walletPayoutRequestFromRow /
 * walletSettlementFromRow moved into PersonaWalletService as part
 * of the Step 16b split. The only mapper still used in this file
 * is walletFromRow (above), called by listPersonas + getPersonaDetail
 * to synthesise a wallet snapshot from a joined query row. */

export class PersonaCoreService {
  private readonly encryption?: FieldEncryption;
  private readonly runtimeSessionTimeoutMs: number;
  /**
   * Memory-domain sub-service. The facade delegates all memory CRUD
   * + search + graph methods to this instance. Internal cross-domain
   * methods (e.g. `addKnowledge`) also call into the same instance
   * so the memory write path is single-sourced. (Step 16 first cut.)
   */
  private readonly memoryService: PersonaMemoryService;
  /**
   * Wallet sub-service — Step 16b second cut. Owns wallet read paths,
   * wallet payout flow, and the wallet-transaction journal write path.
   * The settleTaskPayment + task-completion methods still live in this
   * file (cross-domain with task / governance), but they route their
   * wallet writes through `this.walletService.insertWalletTransaction`
   * + `this.walletService.getWalletByPersonaId(...)` so there's a
   * single write path. */
  private readonly walletService: PersonaWalletService;

  constructor(
    private readonly tx: SyncWriteUnitOfWork,
    encryption?: FieldEncryption,
    runtimeSessionTimeoutMs = 60_000,
    private readonly encryptionResolver?: (tenantId: string) => FieldEncryption | undefined,
  ) {
    registerCoreSelfExecutors();
    this.encryption = encryption?.isEnabled ? encryption : undefined;
    this.runtimeSessionTimeoutMs = runtimeSessionTimeoutMs;
    ensureAuditLogColumns(tx);
    /* Context bag for the memory service. Bound to `this` so the
     * sub-service can call into facade-owned lifecycle guards
     * (getPersonaDetail / isTerminalStatus / forkBelongsToPersona)
     * without a circular constructor dependency. */
    const memoryContext: PersonaMemoryContext = {
      getPersonaDetail: (tenantId, ownerUserId, personaId) =>
        this.getPersonaDetail(tenantId, ownerUserId, personaId),
      isTerminalStatus: (status) => this.isTerminalStatus(status),
      forkBelongsToPersona: (tenantId, personaId, forkId) =>
        this.forkBelongsToPersona(tenantId, personaId, forkId),
    };
    this.memoryService = new PersonaMemoryService(
      tx,
      memoryContext,
      this.encryption,
      this.encryptionResolver,
    );
    /* Wallet sub-service context. The wallet service only needs the
     * persona-existence + owner check; it does not need detail or
     * status because the wallet operations gate on wallet.status
     * (active/suspended) rather than persona lifecycle. */
    const walletContext: PersonaWalletContext = {
      personaExists: (tenantId, ownerUserId, personaId) =>
        this.personaExists(tenantId, ownerUserId, personaId),
    };
    this.walletService = new PersonaWalletService(
      tx,
      walletContext,
      this.encryption,
      this.encryptionResolver,
    );
  }

  private getEncryption(tenantId: string): FieldEncryption | undefined {
    const resolved = this.encryptionResolver?.(tenantId);
    return resolved?.isEnabled ? resolved : this.encryption;
  }

  private getCognitive(tenantId: string): PersonaCognitiveMemoryGraph {
    return new PersonaCognitiveMemoryGraph(this.tx, undefined, this.getEncryption(tenantId));
  }

  private recordBusinessAudit(input: {
    tenantId: string;
    actorId: string;
    actionType: string;
    targetType: string;
    targetId: string;
    payload?: Record<string, unknown>;
    createdAt?: number;
  }): void {
    recordBusinessAuditLog(this.tx, {
      tenantId: input.tenantId,
      actorType: 'user',
      actorId: input.actorId,
      actionType: input.actionType,
      targetType: input.targetType,
      targetId: input.targetId,
      payload: input.payload,
      createdAt: input.createdAt,
    });
  }

  private publishObservability(event: Parameters<typeof publishObservabilityEvent>[1]): void {
    publishObservabilityEvent(this.tx, event);
  }

  createPersona(input: CreatePersonaCoreInput): PersonaCoreDetail {
    const now = Date.now();
    const personaId = generatePrefixedId('pcore');
    const walletId = generatePrefixedId('pwal');
    const walletAddress = `local://persona/${personaId}`;
    const profileJson = JSON.stringify(input.profile ?? {});
    const visibility = input.visibility ?? 'private';
    const initialReputation = 50;

    this.tx.transaction(() => {
      this.tx.execute(pcoreCmdCreatePersona({
        id: personaId,
        tenantId: input.tenantId,
        ownerUserId: input.ownerUserId,
        displayName: input.displayName,
        profileJson,
        visibility,
        reputation: initialReputation,
        now,
      }));

      this.tx.execute(pcoreCmdCreateWallet({
        id: walletId,
        tenantId: input.tenantId,
        personaId,
        walletAddress,
        now,
      }));

      for (const item of input.initialKnowledge ?? []) {
        const knowledgeId = generatePrefixedId('pknow');
        const confidence = clamp(item.confidence ?? 0.7, 0, 1);
        const tagsJson = JSON.stringify(item.tags ?? []);

        this.tx.execute(pcoreCmdCreateKnowledgeItem({
          id: knowledgeId,
          tenantId: input.tenantId,
          personaId,
          title: item.title,
          content: item.content,
          source: item.source ?? 'seed',
          tagsJson,
          confidence,
          now,
        }));

        this.memoryService.insertMemory({
          tenantId: input.tenantId,
          personaId,
          kind: 'knowledge',
          summary: `初始知识同步: ${item.title}`,
          content: { title: item.title, source: item.source ?? 'seed', tags: item.tags ?? [] },
          importance: confidence,
          skipCognitiveProjection: true,
        });

        this.memoryService.projectKnowledgeItem({
          tenantId: input.tenantId,
          personaId,
          knowledgeItemId: knowledgeId,
          title: item.title,
          content: item.content,
          confidence,
        });
      }

      this.recordBusinessAudit({
        tenantId: input.tenantId,
        actorId: input.ownerUserId,
        actionType: 'persona.create',
        targetType: 'persona',
        targetId: personaId,
        createdAt: now,
        payload: {
          displayName: input.displayName,
          visibility,
          initialKnowledgeCount: input.initialKnowledge?.length ?? 0,
        },
      });
    });

    return this.getPersonaDetail(input.tenantId, input.ownerUserId, personaId)!;
  }

  listPersonas(tenantId: string, ownerUserId: string): PersonaCoreSummary[] {
    const rows = this.tx.queryMany(pcoreQuerySummariesByOwner({ tenantId, ownerUserId }));

    return rows.map((row) => ({
      ...personaFromRow(row),
      wallet: walletFromRow({
        id: row.wallet_id,
        tenant_id: row.tenant_id,
        persona_id: row.id,
        wallet_address: row.wallet_address,
        balance: row.balance,
        token_balance: row.token_balance,
        last_settled_at: row.last_settled_at,
        created_at: row.wallet_created_at,
        updated_at: row.wallet_updated_at,
      }),
      stats: {
        activeForks: Number(row.active_fork_count),
        memoryCount: Number(row.memory_count),
        knowledgeCount: Number(row.knowledge_count),
        activeTaskCount: Number(row.active_task_count),
      },
    }));
  }

  getPersonaDetail(tenantId: string, ownerUserId: string, personaId: string): PersonaCoreDetail | null {
    const base = this.tx.queryOne(pcoreQuerySummaryByOwner({ tenantId, ownerUserId, personaId }));

    if (!base) return null;

    const forks = this.tx.queryMany(pcoreQueryForksByPersona({ tenantId, personaId })).map(forkFromRow);

    const recentMemories = this.tx.queryMany(pcoreQueryRecentMemories({ tenantId, personaId })).map((row) => this.memoryService.memoryFromRow(row));

    const knowledgeItems = this.tx.queryMany(pcoreQueryRecentKnowledge({ tenantId, personaId })).map(knowledgeFromRow);

    const growthEvents = this.tx.queryMany(pcoreQueryRecentGrowthEvents({ tenantId, personaId })).map(growthEventFromRow);

    const governanceEvents = this.tx.queryMany(pcoreQueryRecentGovernanceEvents({ tenantId, personaId })).map(governanceEventFromRow);

    const marketplaceTasks = this.tx.queryMany(pcoreQueryRecentMarketplaceTasks({ tenantId, ownerUserId, personaId })).map(taskFromRow);

    return {
      ...personaFromRow(base),
      wallet: walletFromRow({
        id: base.wallet_id,
        tenant_id: base.tenant_id,
        persona_id: base.id,
        wallet_address: base.wallet_address,
        balance: base.balance,
        token_balance: base.token_balance,
        last_settled_at: base.last_settled_at,
        created_at: base.wallet_created_at,
        updated_at: base.wallet_updated_at,
      }),
      stats: {
        activeForks: Number(base.active_fork_count),
        memoryCount: Number(base.memory_count),
        knowledgeCount: Number(base.knowledge_count),
        activeTaskCount: Number(base.active_task_count),
      },
      forks,
      recentMemories,
      knowledgeItems,
      growthEvents,
      governanceEvents,
      marketplaceTasks,
    };
  }

  getOperatingState(tenantId: string, ownerUserId: string, personaId: string): PersonaOperatingState | null {
    const persona = this.getPersonaDetail(tenantId, ownerUserId, personaId);
    if (!persona) return null;

    return {
      persona,
      cognitive: this.getCognitive(tenantId).buildState(tenantId, personaId),
    };
  }

  activatePersona(input: SetPersonaStatusInput): PersonaCoreDetail | null {
    const persona = this.getPersonaDetail(input.tenantId, input.ownerUserId, input.personaId);
    if (!persona || persona.status === 'deceased' || persona.status === 'transferred') return null;
    if (persona.status === 'active') return persona;

    const now = Date.now();
    this.tx.transaction(() => {
      this.tx.execute(pcoreCmdActivatePersona({ tenantId: input.tenantId, personaId: input.personaId, now }));

      this.memoryService.insertMemory({
        tenantId: input.tenantId,
        personaId: input.personaId,
        kind: 'governance',
        summary: 'Persona reactivated',
        content: { eventType: 'review', transition: 'reactivated' },
        importance: 0.45,
      });
    });

    return this.getPersonaDetail(input.tenantId, input.ownerUserId, input.personaId);
  }

  deactivatePersona(input: SetPersonaStatusInput): PersonaCoreDetail | null {
    const persona = this.getPersonaDetail(input.tenantId, input.ownerUserId, input.personaId);
    if (!persona || persona.status === 'deceased' || persona.status === 'transferred') return null;
    if (persona.status === 'dormant') return persona;

    const now = Date.now();
    this.tx.transaction(() => {
      this.tx.execute(pcoreCmdDeactivatePersona({ tenantId: input.tenantId, personaId: input.personaId, now }));

      this.memoryService.insertMemory({
        tenantId: input.tenantId,
        personaId: input.personaId,
        kind: 'governance',
        summary: 'Persona entered dormant state',
        content: { eventType: 'review', transition: 'dormant' },
        importance: 0.5,
      });
    });

    return this.getPersonaDetail(input.tenantId, input.ownerUserId, input.personaId);
  }

  requestTransfer(input: RequestPersonaTransferInput): PersonaTransfer | null {
    const persona = this.getPersonaDetail(input.tenantId, input.ownerUserId, input.personaId);
    if (!persona || persona.status === 'deceased' || persona.status === 'transferred') return null;
    if (input.toOwnerUserId === input.ownerUserId) return null;
    if (!this.userExists(input.tenantId, input.toOwnerUserId)) return null;

    const pending = this.tx.queryOne(pcoreQueryPendingTransfer({
      tenantId: input.tenantId,
      personaId: input.personaId,
    }));
    if (pending) return transferFromRow(pending);

    const now = Date.now();
    const transferId = generatePrefixedId('ptransfer');
    this.tx.transaction(() => {
      this.tx.execute(pcoreCmdCreateTransfer({
        id: transferId,
        tenantId: input.tenantId,
        personaId: input.personaId,
        fromOwnerUserId: input.ownerUserId,
        toOwnerUserId: input.toOwnerUserId,
        reason: input.reason ?? 'asset sale',
        now,
      }));

      this.memoryService.insertMemory({
        tenantId: input.tenantId,
        personaId: input.personaId,
        kind: 'governance',
        summary: 'Ownership transfer requested',
        content: {
          eventType: 'transfer',
          toOwnerUserId: input.toOwnerUserId,
          status: 'pending_review',
        },
        importance: 0.6,
      });

      this.recordBusinessAudit({
        tenantId: input.tenantId,
        actorId: input.ownerUserId,
        actionType: 'persona.transfer.requested',
        targetType: 'persona',
        targetId: input.personaId,
        createdAt: now,
        payload: {
          transferId,
          fromOwnerUserId: input.ownerUserId,
          toOwnerUserId: input.toOwnerUserId,
          status: 'pending_review',
        },
      });
    });

    const created = this.getTransferById(input.tenantId, transferId);
    return created ? transferFromRow(created) : null;
  }

  approveTransfer(input: ApprovePersonaTransferInput): { transfer: PersonaTransfer; persona: PersonaCoreDetail } | null {
    const transfer = this.tx.queryOne(pcoreQueryTransferByPersonaId({
      tenantId: input.tenantId,
      personaId: input.personaId,
      transferId: input.transferId,
    }));
    if (!transfer || transfer.status !== 'pending_review' || transfer.to_owner_user_id !== input.approverUserId) {
      return null;
    }

    const now = Date.now();
    this.tx.transaction(() => {
      this.tx.execute(pcoreCmdApproveTransfer({ tenantId: input.tenantId, transferId: input.transferId, now }));

      this.tx.execute(pcoreCmdTransferPersonaOwner({
        tenantId: input.tenantId,
        personaId: input.personaId,
        ownerUserId: input.approverUserId,
        now,
      }));

      this.tx.execute(pcoreCmdCompleteTransfer({ tenantId: input.tenantId, transferId: input.transferId, now }));

      this.insertGovernanceEvent({
        tenantId: input.tenantId,
        personaId: input.personaId,
        eventType: 'transfer',
        severity: 2,
        summary: 'Persona ownership transferred',
        payload: {
          fromOwnerUserId: transfer.from_owner_user_id,
          toOwnerUserId: transfer.to_owner_user_id,
        },
        actorUserId: input.approverUserId,
      });

      this.memoryService.insertMemory({
        tenantId: input.tenantId,
        personaId: input.personaId,
        kind: 'governance',
        summary: 'Ownership transferred',
        content: {
          eventType: 'transfer',
          fromOwnerUserId: transfer.from_owner_user_id,
          toOwnerUserId: transfer.to_owner_user_id,
          status: 'completed',
        },
        importance: 0.8,
      });

      this.recordBusinessAudit({
        tenantId: input.tenantId,
        actorId: input.approverUserId,
        actionType: 'persona.transfer',
        targetType: 'persona',
        targetId: input.personaId,
        createdAt: now,
        payload: {
          transferId: input.transferId,
          fromOwnerUserId: transfer.from_owner_user_id,
          toOwnerUserId: transfer.to_owner_user_id,
          status: 'completed',
        },
      });
    });

    const completedTransfer = this.tx.queryOne(pcoreQueryTransferById({
      tenantId: input.tenantId,
      transferId: input.transferId,
    }));
    const persona = this.getPersonaDetail(input.tenantId, input.approverUserId, input.personaId);
    if (!completedTransfer || !persona) return null;
    return {
      transfer: transferFromRow(completedTransfer),
      persona,
    };
  }

  listTransfers(tenantId: string, requesterUserId: string, personaId: string): PersonaTransfer[] | null {
    if (!this.canAccessTransferHistory(tenantId, requesterUserId, personaId)) return null;
    return this.tx.queryMany(pcoreQueryTransfersByPersona({ tenantId, personaId })).map(transferFromRow);
  }

  getReputationSummary(tenantId: string, ownerUserId: string, personaId: string): PersonaReputationSummary | null {
    const persona = this.getPersonaDetail(tenantId, ownerUserId, personaId);
    if (!persona) return null;

    const successfulTasks = this.tx.queryOne(pcoreQueryCompletedTaskCount({ tenantId, personaId }))?.count ?? 0;
    const governancePenalties = this.tx.queryOne(pcoreQueryGovernancePenaltyCount({ tenantId, personaId }))?.count ?? 0;

    return {
      personaId,
      score: round(clamp(persona.reputation, 0, 100), 2),
      summary: {
        successfulTasks: Number(successfulTasks),
        disputes: 0,
        governancePenalties: Number(governancePenalties),
      },
    };
  }

  listReputationHistory(tenantId: string, ownerUserId: string, personaId: string): PersonaReputationHistoryEntry[] | null {
    if (!this.personaExists(tenantId, ownerUserId, personaId)) return null;
    return this.tx.queryMany(pcoreQueryReputationHistory({ tenantId, personaId })).map(reputationHistoryFromRow);
  }

  listTopPersonas(
    tenantId: string,
    options?: { category?: MarketplaceTask['category']; limit?: number },
  ): PersonaRankingEntry[] {
    const limit = Math.max(1, Math.min(50, options?.limit ?? 10));
    const personas = this.tx.queryMany(pcoreQueryActivePersonasForRanking(tenantId));

    return personas
      .map((row) => {
        const stats = this.getRankingTaskStats(tenantId, row.id, options?.category);
        return {
          personaId: row.id,
          name: row.display_name,
          score: this.computeRankingScore(Number(row.reputation), Number(row.growth_index), stats.completedTasks, stats.avgQuality, stats.responseSpeed),
          reputationScore: round(Number(row.reputation), 2),
          growthIndex: round(Number(row.growth_index), 2),
          category: (options?.category ?? 'all') as MarketplaceTask['category'] | 'all',
        };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  getPersonaAnalytics(tenantId: string, ownerUserId: string, personaId: string): PersonaAnalytics | null {
    const persona = this.getPersonaDetail(tenantId, ownerUserId, personaId);
    if (!persona) return null;

    const tasksCompleted = this.tx.queryOne(pcoreQueryCompletedTaskCount({ tenantId, personaId }))?.count ?? 0;
    const memoryCount = this.tx.queryOne(pcoreQueryMemoryCount({ tenantId, personaId }))?.count ?? 0;
    const governanceEvents = this.tx.queryOne(pcoreQueryGovernanceEventCount({ tenantId, personaId }))?.count ?? 0;

    return {
      personaId,
      growthIndex: round(persona.growthIndex, 4),
      tasksCompleted: Number(tasksCompleted),
      walletBalance: round(persona.wallet.balance, 2),
      walletTokenBalance: round(persona.wallet.tokenBalance, 2),
      reputationScore: round(clamp(persona.reputation, 0, 100), 2),
      memoryCount: Number(memoryCount),
      governanceEvents: Number(governanceEvents),
    };
  }

  getMarketplaceAnalytics(tenantId: string): MarketplaceAnalytics {
    const row = this.tx.queryOne(pcoreQueryMarketplaceAnalytics(tenantId));

    return {
      openTasks: Number(row?.open_tasks ?? 0),
      activePersonas: Number(row?.active_personas ?? 0),
      completedTasks7d: Number(row?.completed_tasks_7d ?? 0),
      grossVolume: round(Number(row?.gross_volume ?? 0), 2),
    };
  }

  materializeDailyAnalytics(tenantId: string, metricDate = this.currentMetricDate()): DailyAnalyticsMaterialization {
    const { startMs, endMs } = this.metricDateRange(metricDate);
    const personas = this.tx.queryMany(pcoreQueryDailyPersonas(tenantId));

    this.tx.transaction(() => {
      for (const persona of personas) {
        const completedTasks = this.tx.queryOne(pcoreQueryDailyCompletedTaskCount({
          tenantId,
          personaId: persona.id,
          startMs,
          endMs,
        }))?.count ?? 0;

        const revenue = this.tx.queryOne(pcoreQueryDailyPersonaRevenue({
          tenantId,
          personaId: persona.id,
          startMs,
          endMs,
        }))?.total ?? 0;

        this.tx.execute(pcoreCmdUpsertPersonaDailyMetric({
          tenantId,
          personaId: persona.id,
          metricDate,
          tasksCompleted: Number(completedTasks),
          revenue: fromMinor(Number(revenue ?? 0)),
          reputationScore: round(Number(persona.reputation), 2),
          growthIndex: round(Number(persona.growth_index), 4),
        }));
      }

      const dailyMarketplace = this.tx.queryOne(pcoreQueryDailyMarketplaceAnalytics({ tenantId, startMs, endMs }));

      this.tx.execute(pcoreCmdUpsertMarketplaceDailyMetric({
        tenantId,
        metricDate,
        openTasks: Number(dailyMarketplace?.open_tasks ?? 0),
        completedTasks: Number(dailyMarketplace?.completed_tasks ?? 0),
        grossVolume: fromMinor(Number(dailyMarketplace?.gross_volume ?? 0)),
        activePersonas: Number(dailyMarketplace?.active_personas ?? 0),
      }));
    });

    return {
      metricDate,
      personaRows: personas.length,
      marketplaceRows: 1,
    };
  }

  recomputeMarketplaceRankings(
    tenantId: string,
    options?: { category?: MarketplaceTask['category']; limit?: number; metricDate?: string },
  ): { rankings: PersonaRankingEntry[]; materialization: DailyAnalyticsMaterialization } {
    const materialization = this.materializeDailyAnalytics(tenantId, options?.metricDate);
    const rankings = this.listTopPersonas(tenantId, {
      category: options?.category,
      limit: options?.limit,
    });
    return {
      rankings,
      materialization,
    };
  }

  getEconomyAnalytics(tenantId: string): EconomyAnalytics {
    const row = this.tx.queryOne(pcoreQueryEconomyAnalytics(tenantId));

    return {
      grossRevenueMinor: Number(row?.gross_revenue_minor ?? 0),
      ownerPayoutsMinor: Number(row?.owner_payouts_minor ?? 0),
      platformFeesMinor: Number(row?.platform_fees_minor ?? 0),
      personaReservesMinor: Number(row?.persona_reserves_minor ?? 0),
      payoutRequests: Number(row?.payout_requests ?? 0),
      settlementCount: Number(row?.settlement_count ?? 0),
      transactionCount: Number(row?.transaction_count ?? 0),
    };
  }

  createFork(input: CreatePersonaForkInput): PersonaCoreDetail | null {
    const persona = this.getPersonaDetail(input.tenantId, input.ownerUserId, input.personaId);
    if (!persona || this.isTerminalStatus(persona.status)) return null;

    const now = Date.now();
    const forkId = generatePrefixedId('pfork');
    this.tx.execute(pcoreCmdCreateFork({
      id: forkId,
      tenantId: input.tenantId,
      personaId: input.personaId,
      label: input.label,
      forkType: input.forkType ?? 'experimental',
      syncMode: input.syncMode ?? 'core',
      experienceFactor: clamp(input.experienceFactor ?? 1, 0, 2),
      now,
    }));

    this.memoryService.insertMemory({
      tenantId: input.tenantId,
      personaId: input.personaId,
      kind: 'governance',
      summary: `创建分叉 ${input.label}`,
      content: {
        forkId,
        forkType: input.forkType ?? 'experimental',
        syncMode: input.syncMode ?? 'core',
      },
      importance: 0.65,
    });

    return this.getPersonaDetail(input.tenantId, input.ownerUserId, input.personaId);
  }

  /* ── Memory domain (delegated to PersonaMemoryService) ─────────
   * These delegations are intentionally thin so test fixtures + API
   * routes that mock `PersonaCoreService` keep working without
   * change. The sub-service owns the per-method behaviour; the
   * facade owns the public name. */

  addMemory(input: AddPersonaMemoryInput): PersonaMemory | null {
    return this.memoryService.addMemory(input);
  }

  listPersonaMemories(
    tenantId: string,
    ownerUserId: string,
    personaId: string,
    options?: {
      kind?: PersonaMemory['kind'];
      limit?: number;
      cursor?: number;
    },
  ): PersonaMemory[] | null {
    return this.memoryService.listPersonaMemories(tenantId, ownerUserId, personaId, options);
  }

  searchPersonaMemories(
    tenantId: string,
    ownerUserId: string,
    personaId: string,
    query: string,
    limit = 5,
  ): PersonaMemorySearchResult[] | null {
    return this.memoryService.searchPersonaMemories(tenantId, ownerUserId, personaId, query, limit);
  }

  getPersonaGraphSummary(tenantId: string, ownerUserId: string, personaId: string): PersonaGraphSummary | null {
    return this.memoryService.getPersonaGraphSummary(tenantId, ownerUserId, personaId);
  }

  queryPersonaGraph(
    tenantId: string,
    ownerUserId: string,
    personaId: string,
    input: PersonaGraphQueryInput,
  ): PersonaGraphQueryResult | null {
    return this.memoryService.queryPersonaGraph(tenantId, ownerUserId, personaId, input);
  }

  addKnowledge(input: AddPersonaKnowledgeInput): PersonaCoreDetail | null {
    const persona = this.getPersonaDetail(input.tenantId, input.ownerUserId, input.personaId);
    if (!persona || this.isTerminalStatus(persona.status)) return null;

    const now = Date.now();
    const knowledgeId = generatePrefixedId('pknow');
    const confidence = clamp(input.confidence ?? 0.75, 0, 1);
    const growthDelta = round(0.3 + confidence * 0.8);
    const reputationDelta = round(confidence * 0.4);
    const currentReputation = persona.reputation;

    this.tx.transaction(() => {
      this.tx.execute(pcoreCmdCreateKnowledgeItem({
        id: knowledgeId,
        tenantId: input.tenantId,
        personaId: input.personaId,
        title: input.title,
        content: input.content,
        source: input.source ?? 'manual',
        tagsJson: JSON.stringify(input.tags ?? []),
        confidence,
        now,
        fingerprint: input.fingerprint ?? null,
      }));

      this.memoryService.insertMemory({
        tenantId: input.tenantId,
        personaId: input.personaId,
        kind: 'knowledge',
        summary: `知识同步: ${input.title}`,
        content: { title: input.title, source: input.source ?? 'manual', tags: input.tags ?? [] },
        importance: confidence,
        skipCognitiveProjection: true,
      });

      this.memoryService.projectKnowledgeItem({
        tenantId: input.tenantId,
        personaId: input.personaId,
        knowledgeItemId: knowledgeId,
        title: input.title,
        content: input.content,
        confidence,
      });

      this.insertGrowthEvent({
        tenantId: input.tenantId,
        personaId: input.personaId,
        eventType: 'knowledge_sync',
        growthDelta,
        reputationDelta,
        trainingDelta: 0,
        payload: { title: input.title, source: input.source ?? 'manual' },
      });

      this.tx.execute(pcoreCmdUpdatePersonaKnowledgeSync({
        tenantId: input.tenantId,
        personaId: input.personaId,
        growthDelta,
        reputationDelta,
        now,
      }));

      this.insertReputationHistory(
        input.tenantId,
        input.personaId,
        currentReputation,
        currentReputation + reputationDelta,
        `knowledge_sync:${input.title}`,
      );
    });

    return this.getPersonaDetail(input.tenantId, input.ownerUserId, input.personaId);
  }

  addGovernanceEvent(input: AddGovernanceEventInput): PersonaCoreDetail | null {
    const persona = this.getPersonaDetail(input.tenantId, input.ownerUserId, input.personaId);
    if (!persona) return null;

    const now = Date.now();
    const severity = Math.round(clamp(input.severity, 1, 5));
    let nextStatus: PersonaCore['status'] | null = null;
    let reputationDelta = 0;
    let growthDelta = 0;

    switch (input.eventType) {
      case 'warning':
        reputationDelta = round(-1.5 * severity);
        break;
      case 'reward':
        reputationDelta = round(1.8 * severity);
        growthDelta = round(0.25 * severity);
        break;
      case 'restriction':
        nextStatus = severity >= 4 ? 'suspended' : 'restricted';
        reputationDelta = round(-2.5 * severity);
        break;
      case 'death':
        nextStatus = 'deceased';
        reputationDelta = round(-4 * severity);
        break;
      case 'transfer':
        nextStatus = 'transferred';
        break;
      case 'review':
        reputationDelta = round(-0.5 * severity);
        break;
    }

    this.tx.transaction(() => {
      this.insertGovernanceEvent({
        tenantId: input.tenantId,
        personaId: input.personaId,
        eventType: input.eventType,
        severity,
        summary: input.summary,
        payload: input.payload ?? {},
        actorUserId: input.ownerUserId,
      });

      this.memoryService.insertMemory({
        tenantId: input.tenantId,
        personaId: input.personaId,
        kind: 'governance',
        summary: input.summary,
        content: {
          eventType: input.eventType,
          severity,
          ...input.payload,
        },
        importance: clamp(0.4 + severity * 0.1, 0, 1),
      });

      if (growthDelta !== 0 || reputationDelta !== 0) {
        this.insertGrowthEvent({
          tenantId: input.tenantId,
          personaId: input.personaId,
          eventType: 'governance',
          growthDelta,
          reputationDelta,
          trainingDelta: 0,
          payload: {
            eventType: input.eventType,
            severity,
            summary: input.summary,
          },
        });
      }

      this.tx.execute(pcoreCmdApplyGovernanceEvent({
        tenantId: input.tenantId,
        personaId: input.personaId,
        reputationDelta,
        growthDelta,
        now,
        nextStatus,
        legacyStatus: nextStatus ? this.toLegacyStatus(nextStatus) : null,
      }));

      if (reputationDelta !== 0) {
        this.insertReputationHistory(
          input.tenantId,
          input.personaId,
          persona.reputation,
          persona.reputation + reputationDelta,
          `governance:${input.eventType}`,
        );
      }
    });

    return this.getPersonaDetail(input.tenantId, input.ownerUserId, input.personaId);
  }

  markDeceased(tenantId: string, ownerUserId: string, personaId: string, reason: string): PersonaCoreDetail | null {
    return this.addGovernanceEvent({
      tenantId,
      ownerUserId,
      personaId,
      eventType: 'death',
      severity: 5,
      summary: reason || 'Persona 已终止',
      payload: { reason: reason || 'owner-request' },
    });
  }

  evaluateLifecycle(input: EvaluatePersonaLifecycleInput): PersonaLifecycleEvaluation | null {
    const persona = this.getPersonaDetail(input.tenantId, input.ownerUserId, input.personaId);
    if (!persona) return null;

    const inactivityDays = Math.round(clamp(input.inactivityDays ?? 180, 30, 3650));
    const lastActiveAt = this.resolveLastActiveAt(input.tenantId, input.personaId, persona.createdAt);

    if (persona.status === 'deceased' || persona.status === 'transferred') {
      return {
        persona,
        transition: 'none',
        inactivityDays,
        lastActiveAt,
      };
    }

    const thresholdMs = inactivityDays * 24 * 60 * 60 * 1000;
    if (persona.status === 'dormant') {
      if (Date.now() - persona.updatedAt < thresholdMs) {
        return {
          persona,
          transition: 'none',
          inactivityDays,
          lastActiveAt,
        };
      }

      const deceased = this.markDeceased(
        input.tenantId,
        input.ownerUserId,
        input.personaId,
        `Inactivity threshold exceeded twice (${inactivityDays}d)`,
      );
      if (!deceased) return null;
      return {
        persona: deceased,
        transition: 'deceased',
        inactivityDays,
        lastActiveAt,
      };
    }

    if (Date.now() - lastActiveAt < thresholdMs) {
      return {
        persona,
        transition: 'none',
        inactivityDays,
        lastActiveAt,
      };
    }

    const dormant = this.deactivatePersona({
      tenantId: input.tenantId,
      ownerUserId: input.ownerUserId,
      personaId: input.personaId,
    });
    if (!dormant) return null;

    return {
      persona: dormant,
      transition: 'dormant',
      inactivityDays,
      lastActiveAt,
    };
  }

  /* ── Wallet domain (delegated to PersonaWalletService — Step 16b) ──
   * Public methods are thin pass-throughs so API consumers and test
   * fixtures that mock PersonaCoreService keep working unchanged. */

  getWallet(tenantId: string, ownerUserId: string, personaId: string): PersonaWallet | null {
    return this.walletService.getWallet(tenantId, ownerUserId, personaId);
  }

  getWalletByIdForOwner(tenantId: string, ownerUserId: string, walletId: string): PersonaWallet | null {
    return this.walletService.getWalletByIdForOwner(tenantId, ownerUserId, walletId);
  }

  listWalletTransactions(tenantId: string, ownerUserId: string, walletId: string): WalletTransaction[] | null {
    return this.walletService.listWalletTransactions(tenantId, ownerUserId, walletId);
  }

  requestWalletPayout(input: RequestWalletPayoutInput): WalletPayoutRequest | null {
    return this.walletService.requestWalletPayout(input);
  }

  settleTaskPayment(input: SettleTaskPaymentInput): TaskWalletSettlement | null {
    const task = this.getMarketplaceTask(input.tenantId, input.taskId);
    if (!task || task.publisherUserId !== input.actorUserId || !task.assigneePersonaId) return null;

    const assignment = this.getTaskAssignmentById(input.tenantId, input.assignmentId);
    if (!assignment || assignment.taskId !== input.taskId || assignment.personaId !== task.assigneePersonaId) return null;

    const wallet = this.walletService.getWalletByPersonaId(input.tenantId, assignment.personaId);
    if (!wallet || wallet.status !== 'active') return null;

    const existing = this.walletService.getWalletSettlementByAssignmentId(input.tenantId, input.assignmentId);
    if (existing) return existing;

    const totalAmountMinor = Math.round(input.totalAmountMinor);
    if (totalAmountMinor <= 0) return null;

    const ownerPct = Math.round(input.split.ownerPct);
    const personaPct = Math.round(input.split.personaPct);
    const platformPct = Math.round(input.split.platformPct);
    if (ownerPct + personaPct + platformPct !== 100) return null;

    const {
      ownerAmountMinor,
      personaAmountMinor,
      platformAmountMinor,
    } = this.computeSettlementSplit(totalAmountMinor, ownerPct, personaPct, platformPct);
    const now = Date.now();
    const settlementId = generatePrefixedId('ws');
    const settlementLatencyMs = Math.max(0, now - (assignment.submittedAt ?? assignment.assignedAt));

    this.tx.transaction(() => {
      this.tx.execute(pcoreCmdCreateWalletSettlement({
        id: settlementId,
        tenantId: input.tenantId,
        walletId: wallet.id,
        taskId: input.taskId,
        assignmentId: input.assignmentId,
        totalAmountMinor,
        currency: input.currency,
        ownerPct,
        personaPct,
        platformPct,
        ownerAmountMinor,
        personaAmountMinor,
        platformAmountMinor,
        now,
      }));

      this.tx.execute(pcoreCmdSettlePersonaWallet({
        tenantId: input.tenantId,
        walletId: wallet.id,
        ownerAmount: fromMinor(ownerAmountMinor),
        personaAmount: fromMinor(personaAmountMinor),
        currency: input.currency,
        now,
      }));

      this.walletService.insertWalletTransaction({
        tenantId: input.tenantId,
        walletId: wallet.id,
        transactionType: 'task_payment',
        amountMinor: totalAmountMinor,
        currency: input.currency,
        referenceType: 'wallet_settlement',
        referenceId: settlementId,
      });
      this.walletService.insertWalletTransaction({
        tenantId: input.tenantId,
        walletId: wallet.id,
        transactionType: 'platform_fee',
        amountMinor: -platformAmountMinor,
        currency: input.currency,
        referenceType: 'wallet_settlement',
        referenceId: settlementId,
      });
      this.walletService.insertWalletTransaction({
        tenantId: input.tenantId,
        walletId: wallet.id,
        transactionType: 'persona_reserve',
        amountMinor: -personaAmountMinor,
        currency: input.currency,
        referenceType: 'wallet_settlement',
        referenceId: settlementId,
      });

      this.publishObservability({
        tenantId: input.tenantId,
        topic: OBSERVABILITY_TOPIC,
        eventType: 'wallet.settlement_completed',
        partitionKey: wallet.id,
        payload: {
          settlementId,
          walletId: wallet.id,
          taskId: input.taskId,
          assignmentId: input.assignmentId,
          personaId: assignment.personaId,
          totalAmountMinor,
          currency: input.currency,
          latencyMs: settlementLatencyMs,
          updatedAt: now,
        },
      });

      this.recordBusinessAudit({
        tenantId: input.tenantId,
        actorId: input.actorUserId,
        actionType: 'wallet.settlement',
        targetType: 'wallet_settlement',
        targetId: settlementId,
        createdAt: now,
        payload: {
          walletId: wallet.id,
          taskId: input.taskId,
          assignmentId: input.assignmentId,
          totalAmountMinor,
          currency: input.currency,
          ownerAmountMinor,
          personaAmountMinor,
          platformAmountMinor,
        },
      });
    });

    return this.walletService.getWalletSettlementByAssignmentId(input.tenantId, input.assignmentId);
  }

  findTaskApplication(tenantId: string, taskId: string, personaId: string): TaskApplication | null {
    const row = this.tx.queryOne(pcoreQueryTaskApplication({ tenantId, taskId, personaId }));
    return row ? taskApplicationFromRow(row) : null;
  }

  applyToTask(input: ApplyTaskInput): TaskApplication | null {
    const persona = this.getPersonaDetail(input.tenantId, input.ownerUserId, input.personaId);
    if (!persona || persona.status !== 'active') return null;

    const task = this.getMarketplaceTask(input.tenantId, input.taskId);
    if (!task || task.status !== 'open') return null;

    if (this.findTaskApplication(input.tenantId, input.taskId, input.personaId)) {
      return null;
    }

    const now = Date.now();
    const applicationId = generatePrefixedId('tapp');
    const rankingScore = this.computePersonaTaskRanking(persona, task);

    this.tx.execute(pcoreCmdCreateTaskApplication({
      id: applicationId,
      tenantId: input.tenantId,
      taskId: input.taskId,
      personaId: input.personaId,
      rankingScore,
      now,
    }));

    this.memoryService.insertMemory({
      tenantId: input.tenantId,
      personaId: input.personaId,
      kind: 'task',
      summary: `申请市场任务: ${task.title}`,
      content: {
        taskId: task.id,
        category: task.category,
        rankingScore,
      },
      importance: 0.52,
    });

    return this.findTaskApplication(input.tenantId, input.taskId, input.personaId);
  }

  assignTask(input: AssignTaskInput): TaskAssignment | null {
    const task = this.getMarketplaceTask(input.tenantId, input.taskId);
    if (!task || task.status !== 'open' || task.publisherUserId !== input.actorUserId) return null;

    const persona = this.getPersonaById(input.tenantId, input.personaId);
    if (!persona || persona.status !== 'active') return null;

    const application = this.findTaskApplication(input.tenantId, input.taskId, input.personaId);
    if (!application || application.status !== 'submitted') return null;
    const latestAssignment = this.getLatestTaskAssignmentByTask(input.tenantId, input.taskId);
    if (latestAssignment && !['rejected', 'completed'].includes(latestAssignment.status)) return null;

    const now = Date.now();
    const assignmentId = generatePrefixedId('tas');

    this.tx.transaction(() => {
      this.tx.execute(pcoreCmdCreateTaskAssignment({
        id: assignmentId,
        tenantId: input.tenantId,
        taskId: input.taskId,
        personaId: input.personaId,
        applicationId: application.id,
        now,
      }));

      this.tx.execute(pcoreCmdMarkTaskApplicationsAssigned({
        tenantId: input.tenantId,
        taskId: input.taskId,
        applicationId: application.id,
        now,
      }));

      this.tx.execute(pcoreCmdAcceptMarketplaceTaskAssignment({
        tenantId: input.tenantId,
        taskId: input.taskId,
        personaId: input.personaId,
        now,
      }));

      this.memoryService.insertMemory({
        tenantId: input.tenantId,
        personaId: input.personaId,
        kind: 'task',
        summary: `被指派市场任务: ${task.title}`,
        content: {
          taskId: task.id,
          assignmentId,
        reward: task.reward,
      },
      importance: 0.74,
      });

      this.recordBusinessAudit({
        tenantId: input.tenantId,
        actorId: input.actorUserId,
        actionType: 'task.assignment',
        targetType: 'task_assignment',
        targetId: assignmentId,
        createdAt: now,
        payload: {
          taskId: input.taskId,
          personaId: input.personaId,
          applicationId: application.id,
        },
      });
    });

    return this.getTaskAssignmentById(input.tenantId, assignmentId);
  }

  createRuntimeSession(input: CreateRuntimeSessionInput): RuntimeSession | null {
    const persona = this.getPersonaDetail(input.tenantId, input.ownerUserId, input.personaId);
    if (!persona || persona.status !== 'active') return null;

    const task = this.getMarketplaceTask(input.tenantId, input.taskId);
    if (!task || task.assigneePersonaId !== input.personaId) return null;

    const assignment = this.getLatestTaskAssignmentForPersonaAndTask(input.tenantId, input.personaId, input.taskId);
    if (!assignment || !['assigned', 'in_progress', 'submitted'].includes(assignment.status)) return null;

    const now = Date.now();
    const sessionId = generatePrefixedId('rs');
    const timeoutAt = computeRuntimeTimeoutAt(now, this.runtimeSessionTimeoutMs);

    this.tx.transaction(() => {
      this.tx.execute(pcoreCmdCreateRuntimeSession({
        id: sessionId,
        tenantId: input.tenantId,
        personaId: input.personaId,
        taskId: input.taskId,
        assignmentId: assignment.id,
        timeoutAt,
        now,
      }));

      this.tx.execute(pcoreCmdLinkTaskAssignmentRuntimeSession({
        tenantId: input.tenantId,
        assignmentId: assignment.id,
        sessionId,
      }));
    });

    return this.getRuntimeSession(input.tenantId, input.ownerUserId, sessionId);
  }

  getRuntimeSession(tenantId: string, ownerUserId: string, sessionId: string): RuntimeSession | null {
    const row = this.tx.queryOne(pcoreQueryRuntimeSession({ tenantId, sessionId }));
    if (!row || !this.personaExists(tenantId, ownerUserId, row.persona_id)) return null;
    return runtimeSessionFromRow(row);
  }

  planRuntimeSession(tenantId: string, ownerUserId: string, sessionId: string): RuntimeSession | null {
    const session = this.getRuntimeSession(tenantId, ownerUserId, sessionId);
    if (!session || isRuntimeTerminalState(session.state)) return null;

    const task = this.getMarketplaceTask(tenantId, session.taskId);
    if (!task) return null;

    const plan = {
      steps: [
        `Inspect task requirements for ${task.title}`,
        `Run ${task.category} workflow on approved tools`,
        'Package artifacts and summarize outcome',
        'Prepare evaluation and submission package',
      ],
    };

    const now = Date.now();
    this.tx.execute(pcoreCmdPlanRuntimeSession({
      tenantId,
      sessionId,
      planJson: JSON.stringify(plan),
      now,
      timeoutAt: computeRuntimeTimeoutAt(now, this.runtimeSessionTimeoutMs),
    }));

    return this.getRuntimeSession(tenantId, ownerUserId, sessionId);
  }

  executeRuntimeSession(tenantId: string, ownerUserId: string, sessionId: string): RuntimeSession | null {
    const session = this.getRuntimeSession(tenantId, ownerUserId, sessionId);
    if (!session || !['PLAN', 'EXECUTE'].includes(session.state)) return null;

    const task = this.getMarketplaceTask(tenantId, session.taskId);
    if (!task) return null;

    const now = Date.now();
    const artifacts = [
      { type: 'text', uri: `runtime://${session.id}/artifact.json` },
    ];

    this.tx.transaction(() => {
      this.tx.execute(pcoreCmdExecuteRuntimeSession({
        tenantId,
        sessionId,
        artifactsJson: JSON.stringify(artifacts),
        now,
        timeoutAt: computeRuntimeTimeoutAt(now, this.runtimeSessionTimeoutMs),
      }));

      if (session.assignmentId) {
        this.tx.execute(pcoreCmdStartTaskAssignment({
          tenantId,
          assignmentId: session.assignmentId,
          now,
        }));
      }
    });

    this.memoryService.insertMemory({
      tenantId,
      personaId: session.personaId,
      kind: 'task',
      summary: `运行任务执行环节: ${task.title}`,
      content: {
        taskId: task.id,
        sessionId: session.id,
        artifactCount: artifacts.length,
      },
      importance: 0.58,
    });

    return this.getRuntimeSession(tenantId, ownerUserId, sessionId);
  }

  evaluateRuntimeSession(tenantId: string, ownerUserId: string, sessionId: string): RuntimeSession | null {
    const session = this.getRuntimeSession(tenantId, ownerUserId, sessionId);
    if (!session || session.state !== 'EVALUATE') return null;

    const evaluation = {
      summary: 'Execution artifacts evaluated',
      artifact_count: session.artifacts.length,
      ready_for_completion: true,
    };

    const now = Date.now();
    this.tx.execute(pcoreCmdEvaluateRuntimeSession({
      tenantId,
      sessionId,
      evaluationJson: JSON.stringify(evaluation),
      now,
      timeoutAt: computeRuntimeTimeoutAt(now, this.runtimeSessionTimeoutMs),
    }));

    return this.getRuntimeSession(tenantId, ownerUserId, sessionId);
  }

  completeRuntimeSession(tenantId: string, ownerUserId: string, sessionId: string): RuntimeSession | null {
    const session = this.getRuntimeSession(tenantId, ownerUserId, sessionId);
    if (!session || isRuntimeTerminalState(session.state) || !['EVALUATE', 'MEMORY_UPDATE', 'REPUTATION_UPDATE'].includes(session.state)) return null;

    const task = this.getMarketplaceTask(tenantId, session.taskId);
    if (!task) return null;

    const now = Date.now();
    const resultSummary = {
      success: true,
      memory_records_created: 1,
      task_id: task.id,
    };

    this.tx.transaction(() => {
      this.memoryService.insertMemory({
        tenantId,
        personaId: session.personaId,
        kind: 'task',
        summary: `完成 runtime 会话: ${task.title}`,
        content: {
          taskId: task.id,
          sessionId: session.id,
          state: session.state,
        },
        importance: 0.63,
      });

      this.tx.execute(pcoreCmdCompleteRuntimeSession({
        tenantId,
        sessionId,
        resultSummaryJson: JSON.stringify(resultSummary),
        now,
      }));

      this.publishObservability({
        tenantId,
        topic: OBSERVABILITY_TOPIC,
        eventType: 'runtime.completed',
        partitionKey: session.id,
        payload: {
          sessionId: session.id,
          personaId: session.personaId,
          taskId: session.taskId,
          durationMs: Math.max(0, now - session.createdAt),
          updatedAt: now,
        },
      });
    });

    return this.getRuntimeSession(tenantId, ownerUserId, sessionId);
  }

  recoverTimedOutRuntimeSessions(input: {
    now: number;
    sessionTimeoutMs: number;
    maxRetries: number;
    limit?: number;
  }): { scanned: number; recovered: number; timedOut: number } {
    const rows = this.tx.queryMany(pcoreQueryTimedOutRuntimeSessions({
      now: input.now,
      limit: input.limit ?? 100,
    }));

    let recovered = 0;
    let timedOut = 0;

    for (const row of rows) {
      const state = row.state as RuntimeSession['state'];
      if (!ACTIVE_RUNTIME_STATES.has(state)) continue;

      const errorPayload = {
        code: 'runtime_timeout',
        previousState: state,
        detectedAt: input.now,
        retryCount: Number(row.retry_count),
      };

      if (shouldRetryRuntimeSession(Number(row.retry_count), input.maxRetries)) {
        this.tx.execute(pcoreCmdRetryRuntimeSession({
          tenantId: row.tenant_id,
          sessionId: row.id,
          state: nextRuntimeRetryState(state),
          timeoutAt: computeRuntimeTimeoutAt(input.now, input.sessionTimeoutMs),
          now: input.now,
          errorJson: JSON.stringify(errorPayload),
        }));
        recovered++;
        continue;
      }

      this.tx.execute(pcoreCmdTimeoutRuntimeSession({
        tenantId: row.tenant_id,
        sessionId: row.id,
        now: input.now,
        errorJson: JSON.stringify(errorPayload),
      }));
      timedOut++;
    }

    return {
      scanned: rows.length,
      recovered,
      timedOut,
    };
  }

  submitTaskResult(input: SubmitTaskResultInput): TaskResult | null {
    const assignment = this.getTaskAssignmentById(input.tenantId, input.assignmentId);
    if (!assignment || assignment.taskId !== input.taskId) return null;
    if (!this.personaExists(input.tenantId, input.ownerUserId, assignment.personaId)) return null;
    if (!['assigned', 'in_progress', 'rejected'].includes(assignment.status)) return null;

    const task = this.getMarketplaceTask(input.tenantId, input.taskId);
    if (!task || task.assigneePersonaId !== assignment.personaId) return null;

    const now = Date.now();
    const resultId = generatePrefixedId('tr');
    const evaluation = input.evaluation ?? {};

    this.tx.transaction(() => {
      this.tx.execute(pcoreCmdCreateTaskResult({
        id: resultId,
        tenantId: input.tenantId,
        taskId: input.taskId,
        assignmentId: input.assignmentId,
        resultUri: input.resultUri,
        evaluationJson: JSON.stringify(evaluation),
        now,
      }));

      this.tx.execute(pcoreCmdSubmitTaskAssignment({
        tenantId: input.tenantId,
        assignmentId: input.assignmentId,
        now,
      }));

      this.tx.execute(pcoreCmdTouchMarketplaceTask({
        tenantId: input.tenantId,
        taskId: input.taskId,
        now,
      }));

      this.recordBusinessAudit({
        tenantId: input.tenantId,
        actorId: input.ownerUserId,
        actionType: 'task.submission',
        targetType: 'task_result',
        targetId: resultId,
        createdAt: now,
        payload: {
          taskId: input.taskId,
          assignmentId: input.assignmentId,
          resultUri: input.resultUri,
        },
      });
    });

    this.memoryService.insertMemory({
      tenantId: input.tenantId,
      personaId: assignment.personaId,
      kind: 'task',
      summary: `提交任务结果: ${task.title}`,
      content: {
        taskId: task.id,
        assignmentId: assignment.id,
        resultId,
        resultUri: input.resultUri,
      },
      importance: 0.67,
    });

    return this.getLatestTaskResultByAssignment(input.tenantId, input.assignmentId);
  }

  acceptSubmittedTask(input: AcceptSubmittedTaskInput): { task: MarketplaceTask; assignment: TaskAssignment; result: TaskResult } | null {
    const task = this.getMarketplaceTask(input.tenantId, input.taskId);
    if (!task || task.publisherUserId !== input.actorUserId || !task.assigneePersonaId) return null;

    const assignment = this.getLatestTaskAssignmentByTask(input.tenantId, input.taskId);
    if (!assignment || assignment.status !== 'submitted') return null;

    const result = this.getLatestTaskResultByAssignment(input.tenantId, assignment.id);
    if (!result || result.status !== 'submitted') return null;

    const persona = this.getPersonaById(input.tenantId, assignment.personaId);
    if (!persona || this.isTerminalStatus(persona.status)) return null;

    const now = Date.now();
    const qualityScore = clamp(input.qualityScore, 0, 1);
    const clientRating = Math.round(clamp(input.clientRating, 1, 5));
    const rewardSignal = Math.max(task.reward, 1) / 100;
    const growthDelta = round(rewardSignal * (0.6 + qualityScore));
    const reputationDelta = round((qualityScore - 0.5) * 8 + rewardSignal * 3 + (clientRating - 3) * 0.8);
    const totalAmountMinor = toMinor(task.reward);
    const split = { ownerPct: 60, personaPct: 20, platformPct: 20 };
    const {
      ownerAmountMinor,
      personaAmountMinor,
      platformAmountMinor,
    } = this.computeSettlementSplit(totalAmountMinor, split.ownerPct, split.personaPct, split.platformPct);

    this.tx.transaction(() => {
      this.tx.execute(pcoreCmdAcceptTaskResult({
        tenantId: input.tenantId,
        resultId: result.id,
        qualityScore,
        clientRating,
        now,
      }));

      this.tx.execute(pcoreCmdAcceptTaskAssignment({
        tenantId: input.tenantId,
        assignmentId: assignment.id,
        now,
      }));

      this.tx.execute(pcoreCmdCompleteMarketplaceTask({
        tenantId: input.tenantId,
        taskId: input.taskId,
        qualityScore,
        growthDelta,
        now,
      }));

      this.tx.execute(pcoreCmdUpdatePersonaTaskAccepted({
        tenantId: input.tenantId,
        personaId: assignment.personaId,
        growthDelta,
        reputationDelta,
        now,
      }));

      this.insertReputationHistory(
        input.tenantId,
        assignment.personaId,
        persona.reputation,
        persona.reputation + reputationDelta,
        `task_accepted:${task.id}`,
      );

      this.insertGrowthEvent({
        tenantId: input.tenantId,
        personaId: assignment.personaId,
        taskId: task.id,
        eventType: 'task_completed',
        growthDelta,
        reputationDelta,
        trainingDelta: 0,
        payload: {
          ownerAmountMinor,
          personaAmountMinor,
          platformAmountMinor,
          qualityScore,
          clientRating,
          resultId: result.id,
        },
      });

      this.memoryService.insertMemory({
        tenantId: input.tenantId,
        personaId: assignment.personaId,
        kind: 'task',
        summary: `任务结果被客户验收: ${task.title}`,
        content: {
          taskId: task.id,
          assignmentId: assignment.id,
          resultId: result.id,
          qualityScore,
          clientRating,
          ownerAmountMinor,
          personaAmountMinor,
          platformAmountMinor,
        },
        importance: clamp(0.68 + qualityScore * 0.18, 0, 1),
      });

      if (qualityScore >= 0.85) {
        this.insertGovernanceEvent({
          tenantId: input.tenantId,
          personaId: assignment.personaId,
          eventType: 'reward',
          severity: 2,
          summary: `高质量任务被验收: ${task.title}`,
          payload: { taskId: task.id, qualityScore, clientRating },
          actorUserId: input.actorUserId,
        });
      }

      this.publishObservability({
        tenantId: input.tenantId,
        topic: OBSERVABILITY_TOPIC,
        eventType: 'task.outcome',
        partitionKey: task.id,
        payload: {
          taskId: task.id,
          assignmentId: assignment.id,
          personaId: assignment.personaId,
          outcome: 'accepted',
          terminal: true,
          success: true,
          qualityScore,
          clientRating,
          updatedAt: now,
        },
      });

      this.recordBusinessAudit({
        tenantId: input.tenantId,
        actorId: input.actorUserId,
        actionType: 'task.acceptance',
        targetType: 'task_result',
        targetId: result.id,
        createdAt: now,
        payload: {
          taskId: task.id,
          assignmentId: assignment.id,
          personaId: assignment.personaId,
          qualityScore,
          clientRating,
        },
      });
    });

    const settlement = this.settleTaskPayment({
      tenantId: input.tenantId,
      actorUserId: input.actorUserId,
      taskId: task.id,
      assignmentId: assignment.id,
      totalAmountMinor,
      currency: task.currency,
      split,
    });
    if (!settlement) return null;

    const nextTask = this.getMarketplaceTask(input.tenantId, input.taskId);
    const nextAssignment = this.getTaskAssignmentById(input.tenantId, assignment.id);
    const nextResult = this.getLatestTaskResultByAssignment(input.tenantId, assignment.id);
    if (!nextTask || !nextAssignment || !nextResult) return null;

    return {
      task: nextTask,
      assignment: nextAssignment,
      result: nextResult,
    };
  }

  rejectSubmittedTask(input: RejectSubmittedTaskInput): { task: MarketplaceTask; assignment: TaskAssignment; result: TaskResult } | null {
    const task = this.getMarketplaceTask(input.tenantId, input.taskId);
    if (!task || task.publisherUserId !== input.actorUserId) return null;

    const assignment = this.getLatestTaskAssignmentByTask(input.tenantId, input.taskId);
    if (!assignment || assignment.status !== 'submitted') return null;

    const result = this.getLatestTaskResultByAssignment(input.tenantId, assignment.id);
    if (!result || result.status !== 'submitted') return null;

    const now = Date.now();
    this.tx.transaction(() => {
      this.tx.execute(pcoreCmdRejectTaskResult({
        tenantId: input.tenantId,
        resultId: result.id,
        reason: input.reason,
        now,
      }));

      this.tx.execute(pcoreCmdRejectTaskAssignment({
        tenantId: input.tenantId,
        assignmentId: assignment.id,
        now,
      }));

      this.tx.execute(pcoreCmdRejectTaskApplication({
        tenantId: input.tenantId,
        applicationId: assignment.applicationId,
        now,
      }));

      this.tx.execute(pcoreCmdReopenMarketplaceTask({
        tenantId: input.tenantId,
        taskId: input.taskId,
        now,
      }));

      this.publishObservability({
        tenantId: input.tenantId,
        topic: OBSERVABILITY_TOPIC,
        eventType: 'task.outcome',
        partitionKey: task.id,
        payload: {
          taskId: task.id,
          assignmentId: assignment.id,
          personaId: assignment.personaId,
          outcome: 'rejected',
          terminal: true,
          success: false,
          updatedAt: now,
        },
      });
    });

    this.memoryService.insertMemory({
      tenantId: input.tenantId,
      personaId: assignment.personaId,
      kind: 'task',
      summary: `任务结果被拒绝: ${task.title}`,
      content: {
        taskId: task.id,
        assignmentId: assignment.id,
        resultId: result.id,
        reason: input.reason,
      },
      importance: 0.72,
    });

    const nextTask = this.getMarketplaceTask(input.tenantId, input.taskId);
    const nextAssignment = this.getTaskAssignmentById(input.tenantId, assignment.id);
    const nextResult = this.getLatestTaskResultByAssignment(input.tenantId, assignment.id);
    if (!nextTask || !nextAssignment || !nextResult) return null;

    return {
      task: nextTask,
      assignment: nextAssignment,
      result: nextResult,
    };
  }

  disputeTask(input: DisputeTaskInput): { task: MarketplaceTask; assignment: TaskAssignment; result: TaskResult | null; governanceCase: GovernanceCase } | null {
    const task = this.getMarketplaceTask(input.tenantId, input.taskId);
    if (!task || task.publisherUserId !== input.actorUserId || !task.assigneePersonaId) return null;

    const assignment = this.getLatestTaskAssignmentByTask(input.tenantId, input.taskId);
    if (!assignment || !['submitted', 'accepted'].includes(assignment.status)) return null;

    const result = this.getLatestTaskResultByAssignment(input.tenantId, assignment.id);
    const governanceCase = this.openGovernanceCase({
      tenantId: input.tenantId,
      actorUserId: input.actorUserId,
      personaId: task.assigneePersonaId,
      taskId: task.id,
      triggerType: 'task_dispute',
      severity: 'medium',
      details: { reason: input.reason, taskId: task.id, assignmentId: assignment.id },
    });
    if (!governanceCase) return null;

    const now = Date.now();
    this.tx.transaction(() => {
      this.tx.execute(pcoreCmdDisputeTaskAssignment({
        tenantId: input.tenantId,
        assignmentId: assignment.id,
        now,
      }));

      if (result) {
        this.tx.execute(pcoreCmdDisputeTaskResult({
          tenantId: input.tenantId,
          resultId: result.id,
          now,
        }));
      }

      this.tx.execute(pcoreCmdTouchMarketplaceTask({
        tenantId: input.tenantId,
        taskId: task.id,
        now,
      }));

      this.publishObservability({
        tenantId: input.tenantId,
        topic: OBSERVABILITY_TOPIC,
        eventType: 'task.outcome',
        partitionKey: task.id,
        payload: {
          taskId: task.id,
          assignmentId: assignment.id,
          personaId: assignment.personaId,
          outcome: 'disputed',
          terminal: true,
          success: false,
          updatedAt: now,
        },
      });
    });

    const nextTask = this.getMarketplaceTask(input.tenantId, input.taskId);
    const nextAssignment = this.getTaskAssignmentById(input.tenantId, assignment.id);
    const nextResult = result ? this.getLatestTaskResultByAssignment(input.tenantId, assignment.id) : null;
    const nextCase = this.getGovernanceCaseById(input.tenantId, governanceCase.id);
    if (!nextTask || !nextAssignment || !nextCase) return null;

    return {
      task: nextTask,
      assignment: nextAssignment,
      result: nextResult,
      governanceCase: nextCase,
    };
  }

  listGovernanceCases(tenantId: string, ownerUserId: string, personaId: string): GovernanceCase[] | null {
    if (!this.personaExists(tenantId, ownerUserId, personaId)) return null;
    return this.tx.queryMany(pcoreQueryGovernanceCasesByPersona({ tenantId, personaId })).map(governanceCaseFromRow);
  }

  openGovernanceCase(input: OpenGovernanceCaseInput): GovernanceCase | null {
    const persona = this.getPersonaById(input.tenantId, input.personaId);
    if (!persona) return null;

    const now = Date.now();
    const caseId = generatePrefixedId('gcase');
    const details = input.details ?? {};

    this.tx.transaction(() => {
      this.tx.execute(pcoreCmdCreateGovernanceCase({
        id: caseId,
        tenantId: input.tenantId,
        personaId: input.personaId,
        taskId: input.taskId ?? null,
        triggerType: input.triggerType,
        severity: input.severity,
        detailsJson: JSON.stringify(details),
        now,
      }));

      this.insertGovernanceEvent({
        tenantId: input.tenantId,
        personaId: input.personaId,
        eventType: 'review',
        severity: this.severityToLevel(input.severity),
        summary: `治理案件开启: ${input.triggerType}`,
        payload: {
          caseId,
          taskId: input.taskId ?? null,
          ...details,
        },
        actorUserId: input.actorUserId,
      });

      this.memoryService.insertMemory({
        tenantId: input.tenantId,
        personaId: input.personaId,
        kind: 'governance',
        summary: `治理案件开启: ${input.triggerType}`,
        content: {
          caseId,
          severity: input.severity,
          ...details,
        },
        importance: clamp(0.5 + this.severityToLevel(input.severity) * 0.08, 0, 1),
      });

      this.publishObservability({
        tenantId: input.tenantId,
        topic: OBSERVABILITY_TOPIC,
        eventType: 'governance.case_opened',
        partitionKey: caseId,
        payload: {
          caseId,
          personaId: input.personaId,
          taskId: input.taskId ?? null,
          triggerType: input.triggerType,
          severity: input.severity,
          updatedAt: now,
        },
      });

      this.recordBusinessAudit({
        tenantId: input.tenantId,
        actorId: input.actorUserId,
        actionType: 'governance.case.opened',
        targetType: 'governance_case',
        targetId: caseId,
        createdAt: now,
        payload: {
          personaId: input.personaId,
          taskId: input.taskId ?? null,
          triggerType: input.triggerType,
          severity: input.severity,
        },
      });
    });

    return this.getGovernanceCaseById(input.tenantId, caseId);
  }

  applyGovernanceAction(input: ApplyGovernanceActionInput): { governanceCase: GovernanceCase; action: GovernanceAction; personaStatus: PersonaCore['status'] } | null {
    const governanceCase = this.getGovernanceCaseById(input.tenantId, input.caseId);
    if (!governanceCase || governanceCase.status === 'resolved') return null;

    const persona = this.getPersonaById(input.tenantId, governanceCase.personaId);
    if (!persona) return null;

    const now = Date.now();
    const actionId = generatePrefixedId('gact');
    const nextStatus = this.resolvePersonaStatusForAction(persona.status, input.actionType);
    const caseStatus: GovernanceCase['status'] = input.actionType === 'reinstate' ? 'resolved' : 'action_applied';
    const severityLevel = this.severityToLevel(governanceCase.severity);
    const reputationDelta = this.reputationDeltaForAction(input.actionType, severityLevel);

    this.tx.transaction(() => {
      this.tx.execute(pcoreCmdCreateGovernanceAction({
        id: actionId,
        tenantId: input.tenantId,
        caseId: input.caseId,
        actionType: input.actionType,
        durationSeconds: input.durationSeconds ?? null,
        detailsJson: JSON.stringify(input.details ?? {}),
        actorUserId: input.actorUserId,
        now,
      }));

      this.tx.execute(pcoreCmdUpdateGovernanceCaseAction({
        tenantId: input.tenantId,
        caseId: input.caseId,
        status: caseStatus,
        resolvedAt: caseStatus === 'resolved' ? now : null,
      }));

      this.tx.execute(pcoreCmdApplyGovernanceActionToPersona({
        tenantId: input.tenantId,
        personaId: governanceCase.personaId,
        reputationDelta,
        nextStatus,
        legacyStatus: this.toLegacyStatus(nextStatus),
        now,
      }));

      this.insertGovernanceEvent({
        tenantId: input.tenantId,
        personaId: governanceCase.personaId,
        eventType: this.governanceEventTypeForAction(input.actionType),
        severity: severityLevel,
        summary: `治理动作执行: ${input.actionType}`,
        payload: {
          caseId: input.caseId,
          actionId,
          durationSeconds: input.durationSeconds ?? null,
          ...(input.details ?? {}),
        },
        actorUserId: input.actorUserId,
      });

      this.memoryService.insertMemory({
        tenantId: input.tenantId,
        personaId: governanceCase.personaId,
        kind: 'governance',
        summary: `治理动作执行: ${input.actionType}`,
        content: {
          caseId: input.caseId,
          actionId,
          nextStatus,
          ...(input.details ?? {}),
        },
        importance: clamp(0.55 + severityLevel * 0.08, 0, 1),
      });

      if (reputationDelta !== 0) {
        this.insertGrowthEvent({
          tenantId: input.tenantId,
          personaId: governanceCase.personaId,
          eventType: 'governance',
          growthDelta: 0,
          reputationDelta,
          trainingDelta: 0,
          payload: {
            caseId: input.caseId,
            actionType: input.actionType,
          },
        });

        this.insertReputationHistory(
          input.tenantId,
          governanceCase.personaId,
          persona.reputation,
          persona.reputation + reputationDelta,
          `governance_action:${input.actionType}`,
        );
      }

      this.publishObservability({
        tenantId: input.tenantId,
        topic: OBSERVABILITY_TOPIC,
        eventType: 'governance.action_applied',
        partitionKey: input.caseId,
        payload: {
          caseId: input.caseId,
          actionId,
          personaId: governanceCase.personaId,
          actionType: input.actionType,
          previousStatus: governanceCase.status,
          caseStatus,
          updatedAt: now,
        },
      });

      this.recordBusinessAudit({
        tenantId: input.tenantId,
        actorId: input.actorUserId,
        actionType: 'governance.action',
        targetType: 'governance_action',
        targetId: actionId,
        createdAt: now,
        payload: {
          caseId: input.caseId,
          personaId: governanceCase.personaId,
          actionType: input.actionType,
          nextStatus,
        },
      });
    });

    const nextCase = this.getGovernanceCaseById(input.tenantId, input.caseId);
    const nextAction = this.getGovernanceActionById(input.tenantId, actionId);
    if (!nextCase || !nextAction) return null;

    return {
      governanceCase: nextCase,
      action: nextAction,
      personaStatus: nextStatus,
    };
  }

  appealGovernanceCase(input: AppealGovernanceCaseInput): GovernanceCase | null {
    const governanceCase = this.getGovernanceCaseById(input.tenantId, input.caseId);
    if (!governanceCase) return null;

    const persona = this.getPersonaById(input.tenantId, governanceCase.personaId);
    if (!persona || persona.ownerUserId !== input.actorUserId) return null;

    const now = Date.now();
    this.tx.transaction(() => {
      this.tx.execute(pcoreCmdAppealGovernanceCase({
        tenantId: input.tenantId,
        caseId: input.caseId,
        appealJson: JSON.stringify(input.details ?? {}),
        now,
      }));

      this.insertGovernanceEvent({
        tenantId: input.tenantId,
        personaId: governanceCase.personaId,
        eventType: 'review',
        severity: this.severityToLevel(governanceCase.severity),
        summary: '提交治理申诉',
        payload: {
          caseId: input.caseId,
          ...(input.details ?? {}),
        },
        actorUserId: input.actorUserId,
      });
    });

    return this.getGovernanceCaseById(input.tenantId, input.caseId);
  }

  publishTask(input: PublishMarketplaceTaskInput): MarketplaceTask {
    const now = Date.now();
    const taskId = generatePrefixedId('mkt');
    this.tx.execute(pcoreCmdPublishMarketplaceTask({
      id: taskId,
      tenantId: input.tenantId,
      publisherUserId: input.publisherUserId,
      title: input.title,
      description: input.description,
      category: input.category ?? 'general',
      reward: input.reward,
      currency: input.currency ?? 'CRED',
      now,
    }));
    return this.getMarketplaceTask(input.tenantId, taskId)!;
  }

  listMarketplaceTasks(tenantId: string, status?: MarketplaceTask['status']): MarketplaceTask[] {
    return this.tx.queryMany(pcoreQueryMarketplaceTasksByTenant({ tenantId, status })).map(taskFromRow);
  }

  getMarketplaceTaskById(tenantId: string, taskId: string): MarketplaceTask | null {
    return this.getMarketplaceTask(tenantId, taskId);
  }

  acceptTask(input: AcceptMarketplaceTaskInput): MarketplaceTask | null {
    const persona = this.getPersonaDetail(input.tenantId, input.ownerUserId, input.personaId);
    if (!persona || persona.status !== 'active') return null;
    if (input.forkId && !this.forkBelongsToPersona(input.tenantId, input.personaId, input.forkId)) return null;

    const task = this.getMarketplaceTask(input.tenantId, input.taskId);
    if (!task || task.status !== 'open') return null;

    const now = Date.now();
    this.tx.transaction(() => {
      this.tx.execute(pcoreCmdAcceptMarketplaceTaskLegacy({
        tenantId: input.tenantId,
        taskId: input.taskId,
        personaId: input.personaId,
        forkId: input.forkId ?? null,
        now,
      }));

      this.memoryService.insertMemory({
        tenantId: input.tenantId,
        personaId: input.personaId,
        forkId: input.forkId,
        kind: 'task',
        summary: `接受市场任务: ${task.title}`,
        content: { taskId: task.id, reward: task.reward, category: task.category },
        importance: 0.7,
      });
    });

    return this.getMarketplaceTask(input.tenantId, input.taskId);
  }

  completeTask(input: CompleteMarketplaceTaskInput): { task: MarketplaceTask; wallet: PersonaWallet; persona: PersonaCoreDetail } | null {
    const task = this.getMarketplaceTask(input.tenantId, input.taskId);
    if (!task || task.status !== 'accepted' || !task.assigneePersonaId) return null;
    const personaId = task.assigneePersonaId;
    const persona = this.getPersonaDetail(input.tenantId, input.ownerUserId, personaId);
    if (!persona || this.isTerminalStatus(persona.status)) return null;

    const now = Date.now();
    const qualityScore = clamp(input.qualityScore, 0, 1);
    const ownerTrainingHours = Math.max(0, input.ownerTrainingHours ?? 0);
    const rewardSignal = Math.max(task.reward, 1) / 100;
    const growthDelta = round(rewardSignal * (0.6 + qualityScore) + ownerTrainingHours * 0.15);
    const reputationDelta = round((qualityScore - 0.5) * 8 + rewardSignal * 3);
    const payout = round(task.reward * Math.max(qualityScore, 0.2), 2);
    const tokenReward = round(growthDelta * 8, 2);

    this.tx.transaction(() => {
      this.tx.execute(pcoreCmdCompleteMarketplaceTask({
        tenantId: input.tenantId,
        taskId: input.taskId,
        qualityScore,
        growthDelta,
        now,
      }));

      this.tx.execute(pcoreCmdCompleteTaskWalletUpdate({
        tenantId: input.tenantId,
        personaId,
        payout,
        tokenReward,
        now,
      }));

      this.tx.execute(pcoreCmdCompleteTaskPersonaUpdate({
        tenantId: input.tenantId,
        personaId,
        growthDelta,
        reputationDelta,
        ownerTrainingHours,
        now,
      }));

      this.insertReputationHistory(
        input.tenantId,
        personaId,
        persona.reputation,
        persona.reputation + reputationDelta,
        `task_completed:${task.id}`,
      );

      this.insertGrowthEvent({
        tenantId: input.tenantId,
        personaId,
        taskId: task.id,
        eventType: 'task_completed',
        growthDelta,
        reputationDelta,
        trainingDelta: ownerTrainingHours,
        payload: {
          reward: task.reward,
          payout,
          tokenReward,
          qualityScore,
          category: task.category,
        },
      });

      this.memoryService.insertMemory({
        tenantId: input.tenantId,
        personaId,
        forkId: task.assigneeForkId ?? undefined,
        kind: 'task',
        summary: `完成市场任务: ${task.title}`,
        content: {
          taskId: task.id,
          reward: task.reward,
          payout,
          qualityScore,
          ownerTrainingHours,
        },
        importance: clamp(0.65 + qualityScore * 0.2, 0, 1),
      });

      if (qualityScore >= 0.85) {
        this.insertGovernanceEvent({
          tenantId: input.tenantId,
          personaId,
          eventType: 'reward',
          severity: 2,
          summary: `高质量完成任务: ${task.title}`,
          payload: { taskId: task.id, qualityScore },
          actorUserId: input.ownerUserId,
        });
      }

      this.publishObservability({
        tenantId: input.tenantId,
        topic: OBSERVABILITY_TOPIC,
        eventType: 'task.outcome',
        partitionKey: task.id,
        payload: {
          taskId: task.id,
          personaId,
          outcome: 'completed',
          terminal: true,
          success: true,
          qualityScore,
          updatedAt: now,
        },
      });
    });

    const nextTask = this.getMarketplaceTask(input.tenantId, task.id);
    const wallet = this.getWallet(input.tenantId, input.ownerUserId, personaId);
    const nextPersona = this.getPersonaDetail(input.tenantId, input.ownerUserId, personaId);
    if (!nextTask || !wallet || !nextPersona) return null;

    return {
      task: nextTask,
      wallet,
      persona: nextPersona,
    };
  }

  private personaExists(tenantId: string, ownerUserId: string, personaId: string): boolean {
    return Boolean(this.tx.queryOne(pcoreQueryPersonaExists({ tenantId, ownerUserId, personaId })));
  }

  private forkBelongsToPersona(tenantId: string, personaId: string, forkId: string): boolean {
    return Boolean(this.tx.queryOne(pcoreQueryForkExists({ tenantId, personaId, forkId })));
  }

  private getMarketplaceTask(tenantId: string, taskId: string): MarketplaceTask | null {
    const row = this.tx.queryOne(pcoreQueryMarketplaceTaskById({ tenantId, taskId }));
    return row ? taskFromRow(row as MarketplaceTaskRow) : null;
  }

  private getTaskAssignmentById(tenantId: string, assignmentId: string): TaskAssignment | null {
    const row = this.tx.queryOne(pcoreQueryTaskAssignmentById({ tenantId, assignmentId }));
    return row ? taskAssignmentFromRow(row as TaskAssignmentRow) : null;
  }

  private getLatestTaskAssignmentByTask(tenantId: string, taskId: string): TaskAssignment | null {
    const row = this.tx.queryOne(pcoreQueryLatestTaskAssignmentByTask({ tenantId, taskId }));
    return row ? taskAssignmentFromRow(row as TaskAssignmentRow) : null;
  }

  private getLatestTaskAssignmentForPersonaAndTask(tenantId: string, personaId: string, taskId: string): TaskAssignment | null {
    const row = this.tx.queryOne(pcoreQueryLatestTaskAssignmentForPersonaTask({ tenantId, personaId, taskId }));
    return row ? taskAssignmentFromRow(row as TaskAssignmentRow) : null;
  }

  private getLatestTaskResultByAssignment(tenantId: string, assignmentId: string): TaskResult | null {
    const row = this.tx.queryOne(pcoreQueryLatestTaskResultByAssignment({ tenantId, assignmentId }));
    return row ? taskResultFromRow(row as TaskResultRow) : null;
  }

  private getGovernanceCaseById(tenantId: string, caseId: string): GovernanceCase | null {
    const row = this.tx.queryOne(pcoreQueryGovernanceCaseById({ tenantId, caseId }));
    return row ? governanceCaseFromRow(row as GovernanceCaseRow) : null;
  }

  private getGovernanceActionById(tenantId: string, actionId: string): GovernanceAction | null {
    const row = this.tx.queryOne(pcoreQueryGovernanceActionById({ tenantId, actionId }));
    return row ? governanceActionFromRow(row as GovernanceActionRow) : null;
  }

  private getPersonaById(tenantId: string, personaId: string): PersonaCore | null {
    const row = this.tx.queryOne(pcoreQueryPersonaById({ tenantId, personaId }));
    return row ? personaFromRow(row as PersonaCoreRow) : null;
  }

  /* Wallet helpers (getWalletByPersonaId / getWalletPayoutRequestById /
   * getWalletSettlementByAssignmentId / insertWalletTransaction)
   * moved to PersonaWalletService as part of the Step 16b split.
   * Internal callers go through `this.walletService.*` so the wallet
   * read+write paths remain single-sourced. */

  private getTransferById(tenantId: string, transferId: string): PersonaTransferRow | null {
    return this.tx.queryOne(pcoreQueryTransferById({ tenantId, transferId })) as PersonaTransferRow | null;
  }

  private canAccessTransferHistory(tenantId: string, userId: string, personaId: string): boolean {
    if (this.personaExists(tenantId, userId, personaId)) return true;
    return Boolean(this.tx.queryOne(pcoreQueryTransferAccess({ tenantId, userId, personaId })));
  }

  private userExists(tenantId: string, userId: string): boolean {
    return Boolean(this.tx.queryOne(pcoreQueryUserExists({ tenantId, userId })));
  }

  private isTerminalStatus(status: PersonaCore['status']): boolean {
    return status === 'deceased' || status === 'transferred';
  }

  private toLegacyStatus(status: PersonaCore['status']): Exclude<PersonaCore['status'], 'draft' | 'suspended' | 'dormant'> {
    switch (status) {
      case 'suspended':
        return 'restricted';
      case 'dormant':
      case 'draft':
        return 'active';
      case 'active':
      case 'restricted':
      case 'deceased':
      case 'transferred':
      default:
        return status;
    }
  }

  private insertReputationHistory(
    tenantId: string,
    personaId: string,
    oldScore: number,
    newScore: number,
    reason: string,
  ): void {
    this.tx.execute(pcoreCmdInsertReputationHistory({
      id: generatePrefixedId('rep'),
      tenantId,
      personaId,
      oldScore: round(clamp(oldScore, 0, 100), 4),
      newScore: round(clamp(newScore, 0, 100), 4),
      reason,
      now: Date.now(),
    }));
  }

  private getRankingTaskStats(
    tenantId: string,
    personaId: string,
    category?: MarketplaceTask['category'],
  ): { completedTasks: number; avgQuality: number; responseSpeed: number } {
    const row = category
      ? this.tx.queryOne(pcoreQueryRankingTaskStats({ tenantId, personaId, category }))
      : this.tx.queryOne(pcoreQueryRankingTaskStatsUncategorized({ tenantId, personaId }));

    const avgHours = Number((row as { avg_hours?: number | null } | null)?.avg_hours ?? 24);
    const responseSpeed = clamp(1 - avgHours / 72, 0.2, 1);
    return {
      completedTasks: Number((row as { completed_tasks?: number } | null)?.completed_tasks ?? 0),
      avgQuality: Number((row as { avg_quality?: number | null } | null)?.avg_quality ?? 0),
      responseSpeed,
    };
  }

  private computeRankingScore(
    reputation: number,
    growthIndex: number,
    completedTasks: number,
    avgQuality: number,
    responseSpeed: number,
  ): number {
    const taskSignal = clamp(Math.min(completedTasks, 20) / 20, 0, 1) * clamp(avgQuality, 0, 1) * 100;
    const reputationSignal = clamp(reputation, 0, 100);
    const growthSignal = clamp(growthIndex, 0, 100);
    const responseSignal = clamp(responseSpeed, 0, 1) * 100;
    return round(taskSignal * 0.35 + reputationSignal * 0.3 + growthSignal * 0.2 + responseSignal * 0.15, 4);
  }

  private computeSettlementSplit(totalAmountMinor: number, ownerPct: number, personaPct: number, _platformPct: number): {
    ownerAmountMinor: number;
    personaAmountMinor: number;
    platformAmountMinor: number;
  } {
    const ownerAmountMinor = Math.floor(totalAmountMinor * ownerPct / 100);
    const personaAmountMinor = Math.floor(totalAmountMinor * personaPct / 100);
    const platformAmountMinor = totalAmountMinor - ownerAmountMinor - personaAmountMinor;
    return {
      ownerAmountMinor,
      personaAmountMinor,
      platformAmountMinor,
    };
  }

  private currentMetricDate(now = new Date()): string {
    return now.toISOString().slice(0, 10);
  }

  private metricDateRange(metricDate: string): { startMs: number; endMs: number } {
    const startMs = Date.parse(`${metricDate}T00:00:00.000Z`);
    if (!Number.isFinite(startMs)) {
      const fallback = Date.now();
      return {
        startMs: fallback - 24 * 60 * 60 * 1000,
        endMs: fallback,
      };
    }
    return {
      startMs,
      endMs: startMs + 24 * 60 * 60 * 1000,
    };
  }

  private computePersonaTaskRanking(persona: PersonaCoreDetail, task: MarketplaceTask): number {
    const stats = this.getRankingTaskStats(persona.tenantId, persona.id, task.category);
    return this.computeRankingScore(
      persona.reputation,
      persona.growthIndex,
      stats.completedTasks,
      stats.avgQuality,
      stats.responseSpeed,
    );
  }

  private severityToLevel(severity: GovernanceCaseSeverity): number {
    switch (severity) {
      case 'critical':
        return 5;
      case 'high':
        return 4;
      case 'medium':
        return 3;
      case 'low':
      default:
        return 1;
    }
  }

  private resolvePersonaStatusForAction(
    currentStatus: PersonaCore['status'],
    actionType: GovernanceActionType,
  ): PersonaCore['status'] {
    switch (actionType) {
      case 'temporary_restriction':
        return 'restricted';
      case 'temporary_suspension':
        return 'suspended';
      case 'termination':
        return 'deceased';
      case 'reinstate':
        return 'active';
      case 'warning':
      default:
        return currentStatus;
    }
  }

  private reputationDeltaForAction(actionType: GovernanceActionType, severityLevel: number): number {
    switch (actionType) {
      case 'warning':
        return round(-0.8 * severityLevel);
      case 'temporary_restriction':
        return round(-1.5 * severityLevel);
      case 'temporary_suspension':
        return round(-2.1 * severityLevel);
      case 'termination':
        return round(-4 * severityLevel);
      case 'reinstate':
        return round(1.2 * severityLevel);
      default:
        return 0;
    }
  }

  private governanceEventTypeForAction(actionType: GovernanceActionType): PersonaGovernanceEvent['eventType'] {
    switch (actionType) {
      case 'warning':
        return 'warning';
      case 'temporary_restriction':
      case 'temporary_suspension':
        return 'restriction';
      case 'termination':
        return 'death';
      case 'reinstate':
      default:
        return 'review';
    }
  }

  private resolveLastActiveAt(tenantId: string, personaId: string, fallback: number): number {
    const row = this.tx.queryOne(pcoreQueryLastActiveAt({ tenantId, personaId })) as {
      wallet_value: number | null;
      memory_value: number | null;
      task_value: number | null;
    } | null;
    return Math.max(
      fallback,
      Number(row?.wallet_value ?? 0),
      Number(row?.memory_value ?? 0),
      Number(row?.task_value ?? 0),
    );
  }

  /* Memory write + projection helpers extracted to
   * PersonaMemoryService as part of the Step 16 split. The facade
   * delegates via `this.memoryService.{insertMemory,projectKnowledgeItem,
   * memoryFromRow}` so the SQL write path stays single-sourced. */

  private insertGrowthEvent(input: {
    tenantId: string;
    personaId: string;
    taskId?: string | null;
    eventType: PersonaGrowthEvent['eventType'];
    growthDelta: number;
    reputationDelta: number;
    trainingDelta: number;
    payload: Record<string, unknown>;
  }): void {
    const now = Date.now();
    this.tx.execute(pcoreCmdInsertGrowthEvent({
      id: generatePrefixedId('pgrow'),
      tenantId: input.tenantId,
      personaId: input.personaId,
      taskId: input.taskId ?? null,
      eventType: input.eventType,
      growthDelta: input.growthDelta,
      reputationDelta: input.reputationDelta,
      trainingDelta: input.trainingDelta,
      payloadJson: JSON.stringify(input.payload),
      now,
    }));

    this.publishObservability({
      tenantId: input.tenantId,
      topic: OBSERVABILITY_TOPIC,
      eventType: 'persona.growth_recorded',
      partitionKey: input.personaId,
      payload: {
        personaId: input.personaId,
        taskId: input.taskId ?? null,
        growthEventType: input.eventType,
        growthDelta: input.growthDelta,
        reputationDelta: input.reputationDelta,
        trainingDelta: input.trainingDelta,
        updatedAt: now,
      },
    });
  }

  private insertGovernanceEvent(input: {
    tenantId: string;
    personaId: string;
    eventType: PersonaGovernanceEvent['eventType'];
    severity: number;
    summary: string;
    payload: Record<string, unknown>;
    actorUserId: string | null;
  }): void {
    const now = Date.now();
    this.tx.execute(pcoreCmdInsertGovernanceEvent({
      id: generatePrefixedId('pgov'),
      tenantId: input.tenantId,
      personaId: input.personaId,
      eventType: input.eventType,
      severity: input.severity,
      summary: input.summary,
      payloadJson: JSON.stringify(input.payload),
      actorUserId: input.actorUserId,
      now,
    }));
  }
}
