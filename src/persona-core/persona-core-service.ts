import type { FieldEncryption } from '../storage/encryption.js';
import type { SyncWriteUnitOfWork } from '@chrono/kernel';
import {
  pcoreCmdActivatePersona,
  pcoreCmdApproveTransfer,
  pcoreCmdCompleteTransfer,
  pcoreCmdApplyGovernanceEvent,
  pcoreCmdCreateFork,
  pcoreCmdUpdatePersonaKnowledgeSync,
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
  pcoreQueryMarketplaceAnalytics,
  pcoreQueryMemoryCount,
  pcoreQueryPendingTransfer,
  pcoreQueryRecentGovernanceEvents,
  pcoreQueryRecentGrowthEvents,
  pcoreQueryRecentKnowledge,
  pcoreQueryRecentMarketplaceTasks,
  pcoreQueryRecentMemories,
  pcoreQueryReputationHistory,
  pcoreQuerySummariesByOwner,
  pcoreQuerySummaryByOwner,
  pcoreQueryTransferById,
  pcoreQueryTransferByPersonaId,
  pcoreQueryTransfersByPersona,
  pcoreQueryPersonaExists,
  pcoreQueryForkExists,
  pcoreQueryPersonaById,
  pcoreQueryTransferAccess,
  pcoreQueryUserExists,
  pcoreQueryRankingTaskStats,
  pcoreQueryRankingTaskStatsUncategorized,
  pcoreQueryLastActiveAt,
  pcoreCmdInsertReputationHistory,
  pcoreCmdInsertGrowthEvent,
  type PcorePersonaRow,
  type PcoreForkRow,
  type PcoreKnowledgeRow,
  type PcoreGrowthEventRow,
  type PcoreGovernanceEventRow,
  type PcoreTransferRow,
  type PcoreReputationHistoryRow,
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
} from './persona-core-utils.js';
import { PersonaMemoryService, type PersonaMemoryContext } from './persona-memory-service.js';
import { PersonaWalletService, walletFromRow, type PersonaWalletContext } from './persona-wallet-service.js';
import {
  PersonaGovernanceService,
  type PersonaGovernanceContext,
} from './persona-governance-service.js';
import {
  PersonaMarketplaceService,
  taskFromRow,
  type PersonaMarketplaceContext,
  type TaskApplicant,
} from './persona-marketplace-service.js';
/* Runtime state machine helpers moved to PersonaMarketplaceService. */
import type {
  AddGovernanceEventInput,
  AddPersonaKnowledgeInput,
  AddPersonaMemoryInput,
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
  AppealGovernanceCaseInput,
  ApplyGovernanceActionInput,
  GovernanceAction,
  GovernanceCase,
  OpenGovernanceCaseInput,
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
/* MarketplaceTaskRow alias removed — extracted to PersonaMarketplaceService. */
type PersonaTransferRow = PcoreTransferRow;
type ReputationHistoryRow = PcoreReputationHistoryRow;
/* TaskApplicationRow / TaskAssignmentRow / RuntimeSessionRow /
 * TaskResultRow aliases removed — all extracted to PersonaMarketplaceService. */
/* GovernanceCaseRow / GovernanceActionRow aliases removed —
 * governance rows are only mapped inside PersonaGovernanceService now. */
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

/* taskFromRow moved to PersonaMarketplaceService and re-imported above
 * for the listPersonas/getPersonaDetail recent-tasks projection. */

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

/* taskApplicationFromRow / taskAssignmentFromRow / runtimeSessionFromRow
 * / taskResultFromRow moved to PersonaMarketplaceService. */

/* governanceCaseFromRow / governanceActionFromRow moved into
 * PersonaGovernanceService as part of the Step 16c split. */

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
   * Wallet sub-service — Step 16b. Owns wallet read paths, wallet
   * payout flow, and the wallet-transaction journal write path.
   * settleTaskPayment moved to PersonaMarketplaceService in Step 16d,
   * but it still reaches the wallet write path through the
   * MarketplaceWalletHook so there's a single write source for
   * `pcoreCmdInsertWalletTransaction`. */
  private readonly walletService: PersonaWalletService;
  /**
   * Governance sub-service — Step 16c third cut. Owns case + action
   * + appeal lifecycle. Still-in-core lifecycle methods
   * (addGovernanceEvent / markDeceased / evaluateLifecycle) call into
   * this service via `this.governanceService.insertGovernanceEvent`
   * to share a single write path for the governance event row. */
  private readonly governanceService: PersonaGovernanceService;
  /**
   * Marketplace sub-service — Step 16d, the final cut of the §8
   * Step 16 split. Owns tasks, applications, assignments, runtime
   * sessions, result lifecycle, disputes, and settlement. Reaches
   * into the other sub-services via typed hooks (wallet, memory,
   * governance) — see PersonaMarketplaceContext.
   */
  private readonly marketplaceService: PersonaMarketplaceService;

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
    /* Governance sub-service context. Wires the lookups + side-effects
     * the governance domain needs but doesn't own (persona lookup,
     * persona-state writes, memory hook). The memoryHook passes
     * through to `this.memoryService.insertMemory` so the governance
     * service can write into the audit memory trail without taking a
     * direct dependency on PersonaMemoryService. */
    const governanceContext: PersonaGovernanceContext = {
      personaExists: (t, o, p) => this.personaExists(t, o, p),
      getPersonaById: (t, p) => this.getPersonaById(t, p),
      toLegacyStatus: (status) => this.toLegacyStatus(status),
      insertGrowthEvent: (input) => this.insertGrowthEvent(input),
      insertReputationHistory: (t, p, from, to, reason) =>
        this.insertReputationHistory(t, p, from, to, reason),
      memoryHook: this.memoryService,
    };
    this.governanceService = new PersonaGovernanceService(tx, governanceContext);
    /* Marketplace sub-service context. The marketplace cluster
     * reaches into wallet (settlement + journal), memory (audit
     * trail), and governance (reward events on high-quality
     * completion + dispute case creation), so the hooks are typed
     * slices of those sibling sub-services rather than passing the
     * full instances. */
    const marketplaceContext: PersonaMarketplaceContext = {
      getPersonaDetail: (t, o, p) => this.getPersonaDetail(t, o, p),
      getPersonaById: (t, p) => this.getPersonaById(t, p),
      personaExists: (t, o, p) => this.personaExists(t, o, p),
      forkBelongsToPersona: (t, p, f) => this.forkBelongsToPersona(t, p, f),
      isTerminalStatus: (status) => this.isTerminalStatus(status),
      insertGrowthEvent: (input) => this.insertGrowthEvent(input),
      insertReputationHistory: (t, p, from, to, reason) =>
        this.insertReputationHistory(t, p, from, to, reason),
      walletHook: this.walletService,
      memoryHook: this.memoryService,
      governanceHook: this.governanceService,
    };
    this.marketplaceService = new PersonaMarketplaceService(
      tx,
      marketplaceContext,
      this.runtimeSessionTimeoutMs,
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

      this.governanceService.insertGovernanceEvent({
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
      this.governanceService.insertGovernanceEvent({
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

  /* ── Governance domain (delegated to PersonaGovernanceService — Step 16c) ──
   * Public methods are thin pass-throughs; the still-in-core methods
   * (addGovernanceEvent / disputeTask) call into the same sub-service
   * via `this.governanceService.{insertGovernanceEvent, severityToLevel,
   * openGovernanceCase, getGovernanceCaseById}` so the governance
   * write path stays single-sourced. */

  listGovernanceCases(tenantId: string, ownerUserId: string, personaId: string): GovernanceCase[] | null {
    return this.governanceService.listGovernanceCases(tenantId, ownerUserId, personaId);
  }

  openGovernanceCase(input: OpenGovernanceCaseInput): GovernanceCase | null {
    return this.governanceService.openGovernanceCase(input);
  }

  applyGovernanceAction(input: ApplyGovernanceActionInput): { governanceCase: GovernanceCase; action: GovernanceAction; personaStatus: PersonaCore['status'] } | null {
    return this.governanceService.applyGovernanceAction(input);
  }

  appealGovernanceCase(input: AppealGovernanceCaseInput): GovernanceCase | null {
    return this.governanceService.appealGovernanceCase(input);
  }

  /* ── Marketplace domain (delegated to PersonaMarketplaceService — Step 16d, final cut) ──
   * Tasks, applications, assignments, runtime sessions, result
   * lifecycle, disputes, and settlement all live in the sub-service.
   * The facade exposes thin pass-throughs so API consumers + test
   * fixtures that mock PersonaCoreService keep working unchanged. */

  settleTaskPayment(input: SettleTaskPaymentInput): TaskWalletSettlement | null {
    return this.marketplaceService.settleTaskPayment(input);
  }

  findTaskApplication(tenantId: string, taskId: string, personaId: string): TaskApplication | null {
    return this.marketplaceService.findTaskApplication(tenantId, taskId, personaId);
  }

  /** 列某工单的 persona 申请者（含 display_name）——发布者据此选委派给哪个数字人格（ADR-0058）。 */
  listTaskApplicants(tenantId: string, taskId: string): TaskApplicant[] {
    return this.marketplaceService.listTaskApplicants(tenantId, taskId);
  }

  applyToTask(input: ApplyTaskInput): TaskApplication | null {
    return this.marketplaceService.applyToTask(input);
  }

  assignTask(input: AssignTaskInput): TaskAssignment | null {
    return this.marketplaceService.assignTask(input);
  }

  createRuntimeSession(input: CreateRuntimeSessionInput): RuntimeSession | null {
    return this.marketplaceService.createRuntimeSession(input);
  }

  getRuntimeSession(tenantId: string, ownerUserId: string, sessionId: string): RuntimeSession | null {
    return this.marketplaceService.getRuntimeSession(tenantId, ownerUserId, sessionId);
  }

  planRuntimeSession(tenantId: string, ownerUserId: string, sessionId: string): RuntimeSession | null {
    return this.marketplaceService.planRuntimeSession(tenantId, ownerUserId, sessionId);
  }

  executeRuntimeSession(tenantId: string, ownerUserId: string, sessionId: string): RuntimeSession | null {
    return this.marketplaceService.executeRuntimeSession(tenantId, ownerUserId, sessionId);
  }

  evaluateRuntimeSession(tenantId: string, ownerUserId: string, sessionId: string): RuntimeSession | null {
    return this.marketplaceService.evaluateRuntimeSession(tenantId, ownerUserId, sessionId);
  }

  completeRuntimeSession(tenantId: string, ownerUserId: string, sessionId: string): RuntimeSession | null {
    return this.marketplaceService.completeRuntimeSession(tenantId, ownerUserId, sessionId);
  }

  recoverTimedOutRuntimeSessions(input: {
    now: number;
    sessionTimeoutMs: number;
    maxRetries: number;
    limit?: number;
  }): { scanned: number; recovered: number; timedOut: number } {
    return this.marketplaceService.recoverTimedOutRuntimeSessions(input);
  }

  submitTaskResult(input: SubmitTaskResultInput): TaskResult | null {
    return this.marketplaceService.submitTaskResult(input);
  }

  acceptSubmittedTask(input: AcceptSubmittedTaskInput): { task: MarketplaceTask; assignment: TaskAssignment; result: TaskResult } | null {
    return this.marketplaceService.acceptSubmittedTask(input);
  }

  rejectSubmittedTask(input: RejectSubmittedTaskInput): { task: MarketplaceTask; assignment: TaskAssignment; result: TaskResult } | null {
    return this.marketplaceService.rejectSubmittedTask(input);
  }

  disputeTask(input: DisputeTaskInput): { task: MarketplaceTask; assignment: TaskAssignment; result: TaskResult | null; governanceCase: GovernanceCase } | null {
    return this.marketplaceService.disputeTask(input);
  }

  publishTask(input: PublishMarketplaceTaskInput): MarketplaceTask {
    return this.marketplaceService.publishTask(input);
  }

  listMarketplaceTasks(tenantId: string, status?: MarketplaceTask['status']): MarketplaceTask[] {
    return this.marketplaceService.listMarketplaceTasks(tenantId, status);
  }

  getMarketplaceTaskById(tenantId: string, taskId: string): MarketplaceTask | null {
    return this.marketplaceService.getMarketplaceTaskById(tenantId, taskId);
  }

  acceptTask(input: AcceptMarketplaceTaskInput): MarketplaceTask | null {
    return this.marketplaceService.acceptTask(input);
  }

  completeTask(input: CompleteMarketplaceTaskInput): { task: MarketplaceTask; wallet: PersonaWallet; persona: PersonaCoreDetail } | null {
    return this.marketplaceService.completeTask(input);
  }

  private personaExists(tenantId: string, ownerUserId: string, personaId: string): boolean {
    return Boolean(this.tx.queryOne(pcoreQueryPersonaExists({ tenantId, ownerUserId, personaId })));
  }

  private forkBelongsToPersona(tenantId: string, personaId: string, forkId: string): boolean {
    return Boolean(this.tx.queryOne(pcoreQueryForkExists({ tenantId, personaId, forkId })));
  }

  /* Marketplace privates (getMarketplaceTask / getTaskAssignmentById /
   * getLatestTaskAssignmentByTask /
   * getLatestTaskAssignmentForPersonaAndTask /
   * getLatestTaskResultByAssignment) moved to
   * PersonaMarketplaceService as part of the Step 16d split. */

  /* getGovernanceCaseById / getGovernanceActionById moved to
   * PersonaGovernanceService as part of the Step 16c split. The
   * still-in-core disputeTask calls through
   * `this.governanceService.getGovernanceCaseById(...)`. */

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

  /* computeSettlementSplit moved to PersonaMarketplaceService (used
   * by settleTaskPayment, which is now in the sub-service). */

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

  /* computePersonaTaskRanking moved to PersonaMarketplaceService (used
   * by applyToTask, which is now in the sub-service). The ranking
   * helpers it depends on (getRankingTaskStats + computeRankingScore)
   * stay in core because listTopPersonas also uses them. */

  /* severityToLevel / resolvePersonaStatusForAction /
   * reputationDeltaForAction / governanceEventTypeForAction moved to
   * PersonaGovernanceService. The still-in-core methods that need
   * `severityToLevel` (settleTaskPayment / submitTaskResult /
   * addGovernanceEvent's severity coercion) reach it via
   * `this.governanceService.severityToLevel(...)`. */

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

  /* insertGovernanceEvent moved to PersonaGovernanceService. The
   * still-in-core methods that write governance events (addGovernanceEvent,
   * settleTaskPayment, submitTaskResult, etc.) call through
   * `this.governanceService.insertGovernanceEvent(...)`. */
}
