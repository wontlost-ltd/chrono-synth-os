/**
 * Persona marketplace sub-service — Step 16d, the final piece of the
 * §8 Step 16 split. Owns tasks, applications, assignments, runtime
 * sessions, task results, settlements, and disputes.
 *
 * What this sub-service owns:
 *   - Task lifecycle: publishTask, listMarketplaceTasks,
 *     getMarketplaceTaskById, acceptTask, completeTask
 *   - Applications + assignments: findTaskApplication, applyToTask,
 *     assignTask
 *   - Runtime sessions: createRuntimeSession, getRuntimeSession,
 *     planRuntimeSession, executeRuntimeSession, evaluateRuntimeSession,
 *     completeRuntimeSession, recoverTimedOutRuntimeSessions
 *   - Result lifecycle: submitTaskResult, acceptSubmittedTask,
 *     rejectSubmittedTask, disputeTask
 *   - Wallet settlement: settleTaskPayment (writes a settlement row +
 *     mints 3 wallet journal entries via the wallet sub-service)
 *
 * Cross-domain dependencies (injected via PersonaMarketplaceContext):
 *   - Persona lookups: getPersonaDetail, getPersonaById, personaExists,
 *     forkBelongsToPersona, isTerminalStatus, toLegacyStatus
 *   - Wallet hook (subset of PersonaWalletService): getWalletByPersonaId,
 *     getWalletSettlementByAssignmentId, insertWalletTransaction —
 *     settleTaskPayment + acceptSubmittedTask reach into the wallet
 *     write path via this hook
 *   - Memory hook (insertMemory): used by every task lifecycle event
 *     that should leave an audit trail in the persona's memory graph
 *   - Governance hook: insertGovernanceEvent (high-quality reward
 *     event on acceptSubmittedTask), openGovernanceCase (called by
 *     disputeTask), severityToLevel (used internally by submitTaskResult
 *     etc.), getGovernanceCaseById (called by disputeTask's return path)
 *   - Persona-state writes: insertGrowthEvent + insertReputationHistory
 *     (used by acceptSubmittedTask + rejectSubmittedTask)
 *
 * Direct infrastructure dependencies (NOT injected — called as plain
 * function imports on the shared tx):
 *   - publishObservabilityEvent (../observability/observability-outbox)
 *   - recordBusinessAuditLog (../audit/audit-log-store)
 */

import type { SyncWriteUnitOfWork } from '@chrono/kernel';
import {
  pcoreCmdAcceptMarketplaceTaskAssignment,
  pcoreCmdAcceptMarketplaceTaskLegacy,
  pcoreCmdAcceptTaskAssignment,
  pcoreCmdAcceptTaskResult,
  pcoreCmdCompleteMarketplaceTask,
  pcoreCmdCompleteRuntimeSession,
  pcoreCmdCompleteTaskPersonaUpdate,
  pcoreCmdCompleteTaskWalletUpdate,
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
  pcoreCmdPublishMarketplaceTask,
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
  pcoreCmdUpdatePersonaTaskAccepted,
  pcoreQueryLatestTaskAssignmentByTask,
  pcoreQueryLatestTaskAssignmentForPersonaTask,
  pcoreQueryLatestTaskResultByAssignment,
  pcoreQueryMarketplaceTaskById,
  pcoreQueryMarketplaceTasksByTenant,
  pcoreQueryRankingTaskStats,
  pcoreQueryRankingTaskStatsUncategorized,
  pcoreQueryRuntimeSession,
  pcoreQueryTaskApplication,
  pcoreQueryTaskApplicationsByTask,
  pcoreQueryTaskAssignmentById,
  pcoreQueryTimedOutRuntimeSessions,
  type PcoreMarketplaceTaskRow,
  type PcoreRuntimeSessionRow,
  type PcoreTaskApplicationRow,
  type PcoreTaskAssignmentRow,
  type PcoreTaskResultRow,
} from '@chrono/kernel';
import { generatePrefixedId } from '../utils/id-generator.js';
import { ValidationError, ErrorCode } from '../errors/index.js';
import { OBSERVABILITY_TOPIC, publishObservabilityEvent } from '../observability/observability-outbox.js';
import { recordBusinessAuditLog } from '../audit/audit-log-store.js';
import { clamp, fromMinor, round, safeJsonParse, toMinor } from './persona-core-utils.js';
import type { PersonaCoreSource, TransactionContext } from './persona-core-source.js';
import {
  ACTIVE_RUNTIME_STATES,
  computeRuntimeTimeoutAt,
  isRuntimeTerminalState,
  nextRuntimeRetryState,
  shouldRetryRuntimeSession,
} from './runtime-state-machine.js';
import type {
  AcceptMarketplaceTaskInput,
  AcceptSubmittedTaskInput,
  ApplyTaskInput,
  AssignTaskInput,
  CompleteMarketplaceTaskInput,
  CreateRuntimeSessionInput,
  DisputeTaskInput,
  GovernanceCase,
  MarketplaceTask,
  OpenGovernanceCaseInput,
  PersonaCore,
  PersonaCoreDetail,
  PersonaGovernanceEvent,
  PersonaMemory,
  PersonaMemorySensitivity,
  PersonaWallet,
  PublishMarketplaceTaskInput,
  RejectSubmittedTaskInput,
  RuntimeSession,
  SettleTaskPaymentInput,
  SubmitTaskResultInput,
  TaskApplication,
  TaskAssignment,
  TaskResult,
  TaskWalletSettlement,
  WalletTransaction,
  WalletTransactionType,
} from './types.js';

/**
 * CAS 抢占失败的哨兵异常。
 *
 * ⚠️ 必须**抛出**而不是从事务回调里 `return` —— `IDatabase.transaction()` 只在
 * 回调**抛异常**时 ROLLBACK，提前 return 会照常 COMMIT（已实测：回调里先 INSERT
 * 再 return，行数仍为 1）。`acceptSubmittedTask` 在 CAS **之前**已经写了
 * acceptTaskResult / acceptTaskAssignment 两条，若靠 return 退出，这两条会留在库里
 * ⇒ result/assignment 是 accepted、任务却没 completed 也没结算，制造新的不一致。
 */
class LeaseLostError extends Error {
  constructor() {
    super('CAS_CLAIM_LOST');
    this.name = 'LeaseLostError';
  }
}

/* ── Row mappers (exported so disputeTask + completeTask in the
 * facade can still synthesize results when needed) ───────────────── */

export function taskFromRow(row: PcoreMarketplaceTaskRow): MarketplaceTask {
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

export function taskApplicationFromRow(row: PcoreTaskApplicationRow): TaskApplication {
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

/** 工单的 persona 申请者（含 display_name）——发布者视角列表项（ADR-0058）。 */
export interface TaskApplicant {
  readonly id: string;
  readonly taskId: string;
  readonly personaId: string;
  readonly personaName: string | null;
  readonly rankingScore: number;
  readonly status: string;
  readonly createdAt: number;
}

export function taskAssignmentFromRow(row: PcoreTaskAssignmentRow): TaskAssignment {
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

export function runtimeSessionFromRow(row: PcoreRuntimeSessionRow): RuntimeSession {
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

export function taskResultFromRow(row: PcoreTaskResultRow): TaskResult {
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

/* ── Hooks (typed slices of the sibling sub-services) ─────────── */

export interface MarketplaceWalletHook {
  getWalletByPersonaId(tenantId: string, personaId: string): PersonaWallet | null;
  getWalletSettlementByAssignmentId(tenantId: string, assignmentId: string): TaskWalletSettlement | null;
  /** 事务内变体：钱包 journal 写入用外层事务传入的同一 tx。 */
  insertWalletTransactionInTx(tx: TransactionContext, input: {
    tenantId: string;
    walletId: string;
    transactionType: WalletTransactionType;
    amountMinor: number;
    currency: string;
    referenceType?: string | null;
    referenceId?: string | null;
  }): WalletTransaction;
}

export interface MarketplaceMemoryHook {
  /** 事务内变体：memory 写入用外层事务传入的同一 tx。 */
  insertMemoryInTx(tx: TransactionContext, input: {
    tenantId: string;
    personaId: string;
    forkId?: string;
    kind: PersonaMemory['kind'];
    sensitivity?: PersonaMemorySensitivity;
    summary: string;
    content: Record<string, unknown>;
    importance: number;
    skipCognitiveProjection?: boolean;
  }): PersonaMemory;
}

export interface MarketplaceGovernanceHook {
  /** 事务内变体：治理事件写入用外层事务传入的同一 tx。 */
  insertGovernanceEventInTx(tx: TransactionContext, input: {
    tenantId: string;
    personaId: string;
    eventType: PersonaGovernanceEvent['eventType'];
    severity: number;
    summary: string;
    payload: Record<string, unknown>;
    actorUserId: string | null;
  }): void;
  /** disputeTask 保持两阶段时序调此 public 版（零回归）。 */
  openGovernanceCase(input: OpenGovernanceCaseInput): GovernanceCase | null;
  /** 双身份方法 #1 的事务内变体（契约完整）：把开案纳入调用者外层事务。返回新建 caseId。 */
  openGovernanceCaseInTx(tx: TransactionContext, input: OpenGovernanceCaseInput): string | null;
  getGovernanceCaseById(tenantId: string, caseId: string): GovernanceCase | null;
}

export interface PersonaMarketplaceContext {
  getPersonaDetail(tenantId: string, ownerUserId: string, personaId: string): PersonaCoreDetail | null;
  getPersonaById(tenantId: string, personaId: string): PersonaCore | null;
  personaExists(tenantId: string, ownerUserId: string, personaId: string): boolean;
  forkBelongsToPersona(tenantId: string, personaId: string, forkId: string): boolean;
  isTerminalStatus(status: PersonaCore['status']): boolean;
  /** 事务内变体：growth/reputation 写入用外层事务传入的同一 tx。 */
  insertGrowthEventInTx(tx: TransactionContext, input: {
    tenantId: string;
    personaId: string;
    taskId?: string | null;
    eventType: 'governance' | 'task_completed' | 'knowledge_sync' | 'training';
    growthDelta: number;
    reputationDelta: number;
    trainingDelta: number;
    payload: Record<string, unknown>;
  }): void;
  insertReputationHistoryInTx(
    tx: TransactionContext,
    tenantId: string,
    personaId: string,
    from: number,
    to: number,
    reason: string,
  ): void;
  walletHook: MarketplaceWalletHook;
  memoryHook: MarketplaceMemoryHook;
  governanceHook: MarketplaceGovernanceHook;
}

export class PersonaMarketplaceService {
  constructor(
    /* db 取源（双入口）：per-tenant public 方法经 source.forTenant 解析 + 开事务→InTx；
     * cross-tenant recoverTimedOut 经 source.allDbs fan-out。InTx 收外层 tx。 */
    private readonly source: PersonaCoreSource,
    private readonly ctx: PersonaMarketplaceContext,
    private readonly runtimeSessionTimeoutMs: number = 60_000,
  ) {}

  /**
   * 双身份方法 #2（public 入口）：解析租户 + 开事务 → 调 InTx。
   * facade.settleTaskPayment 直接委托；acceptSubmittedTask 保持两阶段时序调此 public 版（零回归）。 */
  settleTaskPayment(input: SettleTaskPaymentInput): TaskWalletSettlement | null {
    const db = this.source.forTenant(input.tenantId);
    return db.transaction(() => this.settleTaskPaymentInTx(db, input));
  }

  /**
   * 双身份方法 #2（事务内 primitive）：显式收 tx，禁止解析 source / 开事务。
   * 校验 + 幂等短路（已结算返回既有）+ 写结算/钱包/journal/observability/audit，全用外层 tx。 */
  settleTaskPaymentInTx(tx: TransactionContext, input: SettleTaskPaymentInput): TaskWalletSettlement | null {
    const task = this.getMarketplaceTask(input.tenantId, input.taskId);
    if (!task || task.publisherUserId !== input.actorUserId || !task.assigneePersonaId) return null;

    const assignment = this.getTaskAssignmentById(input.tenantId, input.assignmentId);
    if (!assignment || assignment.taskId !== input.taskId || assignment.personaId !== task.assigneePersonaId) return null;

    const wallet = this.ctx.walletHook.getWalletByPersonaId(input.tenantId, assignment.personaId);
    if (!wallet || wallet.status !== 'active') return null;

    const existing = this.ctx.walletHook.getWalletSettlementByAssignmentId(input.tenantId, input.assignmentId);
    if (existing) return existing;

    /* ⚠️ 审计 Warning #10：**钱包币种不可变**。
     *
     * 此前 `pcoreCmdSettlePersonaWallet` 的 SQL 是 `SET balance = balance + ?, …, currency = ?`
     * —— 无条件用**入参**币种覆盖钱包币种。实测：`CRED` 钱包收到一笔 `currency:'USD'` 的结算后
     * 变成 `USD`、余额 160，而原有余额与历史流水仍是按 CRED 计价的。
     * 等于把两种货币的金额直接相加，账目从此不可信（且**没有任何报错**）。
     *
     * 结算不是货币兑换：币种不一致时唯一正确的动作是**拒绝**，而不是改写钱包。 */
    if (input.currency !== wallet.currency) return null;

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

    tx.execute(pcoreCmdCreateWalletSettlement({
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

    tx.execute(pcoreCmdSettlePersonaWallet({
      tenantId: input.tenantId,
      walletId: wallet.id,
      ownerAmount: fromMinor(ownerAmountMinor),
      personaAmount: fromMinor(personaAmountMinor),
      currency: input.currency,
      now,
    }));

    this.ctx.walletHook.insertWalletTransactionInTx(tx, {
      tenantId: input.tenantId,
      walletId: wallet.id,
      transactionType: 'task_payment',
      amountMinor: totalAmountMinor,
      currency: input.currency,
      referenceType: 'wallet_settlement',
      referenceId: settlementId,
    });
    /* ⚠️ 审计 Warning #11：**零金额分项不写流水**。
     *
     * `insertWalletTransaction` 的钱包写入门要求 amountMinor 为正整数（`assertWalletMutationAllowed`），
     * 而零分成会送进 `-0` → 抛「amountMinor must be a positive integer」→ **整笔结算回滚**。
     * 实测两个合法输入都被打回、流水 0 条：
     *   - `platformPct: 0`（免平台抽成的推广活动/内部任务）
     *   - 1 分钱任务按 60/20/20 拆分（`Math.floor` 后 platform/persona 分项为 0）
     *
     * 零分项在账目上本就**没有发生**，写一条 0 元流水既无信息量又违反写入门。
     * 跳过它即可 —— 分账守恒不受影响：三项之和仍等于 totalAmountMinor（0 项贡献 0）。 */
    if (platformAmountMinor > 0) {
      this.ctx.walletHook.insertWalletTransactionInTx(tx, {
        tenantId: input.tenantId,
        walletId: wallet.id,
        transactionType: 'platform_fee',
        amountMinor: -platformAmountMinor,
        currency: input.currency,
        referenceType: 'wallet_settlement',
        referenceId: settlementId,
      });
    }
    if (personaAmountMinor > 0) {
      this.ctx.walletHook.insertWalletTransactionInTx(tx, {
        tenantId: input.tenantId,
        walletId: wallet.id,
        transactionType: 'persona_reserve',
        amountMinor: -personaAmountMinor,
        currency: input.currency,
        referenceType: 'wallet_settlement',
        referenceId: settlementId,
      });
    }

    publishObservabilityEvent(tx as SyncWriteUnitOfWork, {
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

    recordBusinessAuditLog(tx as SyncWriteUnitOfWork, {
      tenantId: input.tenantId,
      actorType: 'user',
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

    return this.ctx.walletHook.getWalletSettlementByAssignmentId(input.tenantId, input.assignmentId);
  }

  findTaskApplication(tenantId: string, taskId: string, personaId: string): TaskApplication | null {
    const row = this.source.forTenant(tenantId).queryOne(pcoreQueryTaskApplication({ tenantId, taskId, personaId }));
    return row ? taskApplicationFromRow(row) : null;
  }

  /**
   * 列某工单的全部 persona 申请者（含 persona display_name）——发布者据此选委派给哪个数字人格（ADR-0058）。
   * 确定性排序（分降序、创建升序）。
   */
  listTaskApplicants(tenantId: string, taskId: string): TaskApplicant[] {
    return this.source.forTenant(tenantId).queryMany(pcoreQueryTaskApplicationsByTask({ tenantId, taskId })).map((r) => ({
      id: r.id, taskId: r.task_id, personaId: r.persona_id, personaName: r.persona_name,
      rankingScore: r.ranking_score, status: r.status, createdAt: r.created_at,
    }));
  }

  applyToTask(input: ApplyTaskInput): TaskApplication | null {
    const persona = this.ctx.getPersonaDetail(input.tenantId, input.ownerUserId, input.personaId);
    if (!persona || persona.status !== 'active') return null;

    const task = this.getMarketplaceTask(input.tenantId, input.taskId);
    if (!task || task.status !== 'open') return null;

    if (this.findTaskApplication(input.tenantId, input.taskId, input.personaId)) {
      return null;
    }

    const now = Date.now();
    const applicationId = generatePrefixedId('tapp');
    const rankingScore = this.computePersonaTaskRanking(persona, task);

    /* 零回归：applyToTask 现状无 tx.transaction 包裹（既有原子性缺口，见调用矩阵补充发现 #1），
     * 双入口化仅换 db 取源，不趁机挪进事务——保持 3 条写各自 auto-commit 的现状。 */
    const db = this.source.forTenant(input.tenantId);
    db.execute(pcoreCmdCreateTaskApplication({
      id: applicationId,
      tenantId: input.tenantId,
      taskId: input.taskId,
      personaId: input.personaId,
      rankingScore,
      now,
    }));

    this.ctx.memoryHook.insertMemoryInTx(db, {
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

    /* ADR-0048：记录经济行为溯源（human vs autonomous），供治理审计。
     * 自主行为审计为 system（系统代 persona 经 pipeline 执行）。 */
    recordBusinessAuditLog(db, {
      tenantId: input.tenantId,
      actorType: input.actor === 'autonomous' ? 'system' : 'user',
      actorId: input.actor === 'autonomous' ? input.personaId : input.ownerUserId,
      actionType: 'task.application',
      targetType: 'task_application',
      targetId: applicationId,
      createdAt: now,
      payload: { taskId: input.taskId, personaId: input.personaId, actor: input.actor ?? 'human' },
    });

    return this.findTaskApplication(input.tenantId, input.taskId, input.personaId);
  }

  assignTask(input: AssignTaskInput): TaskAssignment | null {
    const task = this.getMarketplaceTask(input.tenantId, input.taskId);
    if (!task || task.status !== 'open' || task.publisherUserId !== input.actorUserId) return null;

    const persona = this.ctx.getPersonaById(input.tenantId, input.personaId);
    if (!persona || persona.status !== 'active') return null;

    const application = this.findTaskApplication(input.tenantId, input.taskId, input.personaId);
    if (!application || application.status !== 'submitted') return null;
    const latestAssignment = this.getLatestTaskAssignmentByTask(input.tenantId, input.taskId);
    if (latestAssignment && !['rejected', 'completed'].includes(latestAssignment.status)) return null;

    const now = Date.now();
    const assignmentId = generatePrefixedId('tas');

    const db = this.source.forTenant(input.tenantId);
    db.transaction(() => {
      db.execute(pcoreCmdCreateTaskAssignment({
        id: assignmentId,
        tenantId: input.tenantId,
        taskId: input.taskId,
        personaId: input.personaId,
        applicationId: application.id,
        now,
      }));

      db.execute(pcoreCmdMarkTaskApplicationsAssigned({
        tenantId: input.tenantId,
        taskId: input.taskId,
        applicationId: application.id,
        now,
      }));

      db.execute(pcoreCmdAcceptMarketplaceTaskAssignment({
        tenantId: input.tenantId,
        taskId: input.taskId,
        personaId: input.personaId,
        now,
      }));

      this.ctx.memoryHook.insertMemoryInTx(db, {
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

      recordBusinessAuditLog(db, {
        tenantId: input.tenantId,
        actorType: 'user',
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
    const persona = this.ctx.getPersonaDetail(input.tenantId, input.ownerUserId, input.personaId);
    if (!persona || persona.status !== 'active') return null;

    const task = this.getMarketplaceTask(input.tenantId, input.taskId);
    if (!task || task.assigneePersonaId !== input.personaId) return null;

    const assignment = this.getLatestTaskAssignmentForPersonaAndTask(input.tenantId, input.personaId, input.taskId);
    if (!assignment || !['assigned', 'in_progress', 'submitted'].includes(assignment.status)) return null;

    const now = Date.now();
    const sessionId = generatePrefixedId('rs');
    const timeoutAt = computeRuntimeTimeoutAt(now, this.runtimeSessionTimeoutMs);

    const db = this.source.forTenant(input.tenantId);
    db.transaction(() => {
      db.execute(pcoreCmdCreateRuntimeSession({
        id: sessionId,
        tenantId: input.tenantId,
        personaId: input.personaId,
        taskId: input.taskId,
        assignmentId: assignment.id,
        timeoutAt,
        now,
      }));

      db.execute(pcoreCmdLinkTaskAssignmentRuntimeSession({
        tenantId: input.tenantId,
        assignmentId: assignment.id,
        sessionId,
      }));
    });

    return this.getRuntimeSession(input.tenantId, input.ownerUserId, sessionId);
  }

  getRuntimeSession(tenantId: string, ownerUserId: string, sessionId: string): RuntimeSession | null {
    const row = this.source.forTenant(tenantId).queryOne(pcoreQueryRuntimeSession({ tenantId, sessionId }));
    if (!row || !this.ctx.personaExists(tenantId, ownerUserId, row.persona_id)) return null;
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
    this.source.forTenant(tenantId).execute(pcoreCmdPlanRuntimeSession({
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

    const db = this.source.forTenant(tenantId);
    db.transaction(() => {
      db.execute(pcoreCmdExecuteRuntimeSession({
        tenantId,
        sessionId,
        artifactsJson: JSON.stringify(artifacts),
        now,
        timeoutAt: computeRuntimeTimeoutAt(now, this.runtimeSessionTimeoutMs),
      }));

      if (session.assignmentId) {
        db.execute(pcoreCmdStartTaskAssignment({
          tenantId,
          assignmentId: session.assignmentId,
          now,
        }));
      }
    });

    /* 零回归（调用矩阵 D6）：insertMemory 现状在事务【外】调用（事务提交后才写 memory，
     * 两者非原子）。双入口化仅换 db 取源，保持事务外位置不变——不趁机挪进事务闭包。 */
    this.ctx.memoryHook.insertMemoryInTx(db, {
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
    this.source.forTenant(tenantId).execute(pcoreCmdEvaluateRuntimeSession({
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

    const db = this.source.forTenant(tenantId);
    db.transaction(() => {
      this.ctx.memoryHook.insertMemoryInTx(db, {
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

      db.execute(pcoreCmdCompleteRuntimeSession({
        tenantId,
        sessionId,
        resultSummaryJson: JSON.stringify(resultSummary),
        now,
      }));

      publishObservabilityEvent(db, {
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

  /**
   * cross-tenant fan-out（无 tenantId，全表跨租户扫 runtime_sessions）。
   * 遍历 source.allDbs() 逐 shard 隔离执行（见 spec 机制 6）：某 shard 抛错只记入 shardErrors，
   * 不 rethrow、不拖累其余 shard——目标是恢复卡死运行态 session，一个坏 shard 不该阻止健康 shard
   * 恢复（同 BillingOutbox flush 的隔离形状，与 QuotaManager prune 的 fail-fast 区分）。
   * 单库/UoW 模式下 allDbs()=[db]，行为等价现状（一个 shard、shardErrors 空）。 */
  recoverTimedOutRuntimeSessions(input: {
    now: number;
    sessionTimeoutMs: number;
    maxRetries: number;
    limit?: number;
  }): { scanned: number; recovered: number; timedOut: number; shardErrors: { shard: string; error: string }[] } {
    let scanned = 0;
    let recovered = 0;
    let timedOut = 0;
    const shardErrors: { shard: string; error: string }[] = [];
    const dbs = this.source.allDbs();

    for (let i = 0; i < dbs.length; i++) {
      try {
        const r = this.recoverTimedOutRuntimeSessionsOnDb(dbs[i]!, input);
        scanned += r.scanned;
        recovered += r.recovered;
        timedOut += r.timedOut;
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        shardErrors.push({ shard: String(i), error: errMsg });
      }
    }

    return { scanned, recovered, timedOut, shardErrors };
  }

  /** 单-db 恢复（原 recoverTimedOutRuntimeSessions 逻辑提取，this.source.allDbs()[0] 换成参数 db）。 */
  private recoverTimedOutRuntimeSessionsOnDb(
    db: SyncWriteUnitOfWork,
    input: { now: number; sessionTimeoutMs: number; maxRetries: number; limit?: number },
  ): { scanned: number; recovered: number; timedOut: number } {
    const rows = db.queryMany(pcoreQueryTimedOutRuntimeSessions({
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
        db.execute(pcoreCmdRetryRuntimeSession({
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

      db.execute(pcoreCmdTimeoutRuntimeSession({
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
    if (!this.ctx.personaExists(input.tenantId, input.ownerUserId, assignment.personaId)) return null;
    if (!['assigned', 'in_progress', 'rejected'].includes(assignment.status)) return null;

    const task = this.getMarketplaceTask(input.tenantId, input.taskId);
    if (!task || task.assigneePersonaId !== assignment.personaId) return null;

    const now = Date.now();
    const resultId = generatePrefixedId('tr');
    const evaluation = input.evaluation ?? {};

    const db = this.source.forTenant(input.tenantId);
    db.transaction(() => {
      db.execute(pcoreCmdCreateTaskResult({
        id: resultId,
        tenantId: input.tenantId,
        taskId: input.taskId,
        assignmentId: input.assignmentId,
        resultUri: input.resultUri,
        evaluationJson: JSON.stringify(evaluation),
        now,
      }));

      db.execute(pcoreCmdSubmitTaskAssignment({
        tenantId: input.tenantId,
        assignmentId: input.assignmentId,
        now,
      }));

      db.execute(pcoreCmdTouchMarketplaceTask({
        tenantId: input.tenantId,
        taskId: input.taskId,
        now,
      }));

      recordBusinessAuditLog(db, {
        tenantId: input.tenantId,
        /* ADR-0048：自主提交审计为 system（系统代 persona 经 pipeline 执行） */
        actorType: input.actor === 'autonomous' ? 'system' : 'user',
        actorId: input.actor === 'autonomous' ? assignment.personaId : input.ownerUserId,
        actionType: 'task.submission',
        targetType: 'task_result',
        targetId: resultId,
        createdAt: now,
        payload: {
          taskId: input.taskId,
          assignmentId: input.assignmentId,
          resultUri: input.resultUri,
          actor: input.actor ?? 'human',
        },
      });
    });

    /* 零回归（调用矩阵 D7）：insertMemory 现状在事务【外】调用，保持位置不变。 */
    this.ctx.memoryHook.insertMemoryInTx(db, {
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

    const persona = this.ctx.getPersonaById(input.tenantId, assignment.personaId);
    if (!persona || this.ctx.isTerminalStatus(persona.status)) return null;

    const now = Date.now();
    const qualityScore = clamp(input.qualityScore, 0, 1);
    const clientRating = Math.round(clamp(input.clientRating, 1, 5));
    const rewardSignal = Math.max(task.reward, 1) / 100;
    const growthDelta = round(rewardSignal * (0.6 + qualityScore));
    const reputationDelta = round((qualityScore - 0.5) * 8 + rewardSignal * 3 + (clientRating - 3) * 0.8);
    const totalAmountMinor = toMinor(task.reward);
    /* 纵深防御：零金额在**任何写入之前**拒绝。
     *
     * 主防线已上移到 `publishTask`（零/负奖励任务根本发不出来），这里保留是为了
     * 挡住历史数据 —— 修复前入库的 reward=0 任务仍可能存在。
     *
     * 为什么必须前置：`settleTaskPaymentInTx` 有 `if (totalAmountMinor <= 0)
     * return null`，而验收是「先提交验收事务、再另开事务结算」的两阶段时序，
     * 若放到写入之后，reward=0 会**验收提交、结算失败**，任务永久停在
     * `completed` 却没有结算记录，重试又被终态拒绝（实测复现过）。
     *
     * ⚠️ 此处拒绝后任务保持 submitted。本服务**没有改价接口**（已核对：
     * 无 updateTask/editTask，5 条 `UPDATE marketplace_tasks` 无一改 reward），
     * 历史零奖励任务的唯一出路是 `rejectSubmittedTask` 退回重开。 */
    if (totalAmountMinor <= 0) return null;

    const split = { ownerPct: 60, personaPct: 20, platformPct: 20 };
    const {
      ownerAmountMinor,
      personaAmountMinor,
      platformAmountMinor,
    } = this.computeSettlementSplit(totalAmountMinor, split.ownerPct, split.personaPct, split.platformPct);

    const db = this.source.forTenant(input.tenantId);
    let claimedAccept = true;
    try {
      db.transaction(() => {
      db.execute(pcoreCmdAcceptTaskResult({
        tenantId: input.tenantId,
        resultId: result.id,
        qualityScore,
        clientRating,
        now,
      }));

      db.execute(pcoreCmdAcceptTaskAssignment({
        tenantId: input.tenantId,
        assignmentId: assignment.id,
        now,
      }));

      /* 与 completeTask 同一道 CAS：`pcoreCmdCompleteMarketplaceTask` 带
       * `AND status = 'accepted'` 谓词。两个并发的验收都能通过事务外的
       * `assignment.status !== 'submitted'` 判定，只有抢到状态迁移的那个
       * 才可以继续分账，否则**重复结算**。 */
      const claim = db.execute(pcoreCmdCompleteMarketplaceTask({
        tenantId: input.tenantId,
        taskId: input.taskId,
        qualityScore,
        growthDelta,
        now,
      }));
      if (claim.rowsAffected !== 1) {
        claimedAccept = false;
        throw new LeaseLostError();
      }

      db.execute(pcoreCmdUpdatePersonaTaskAccepted({
        tenantId: input.tenantId,
        personaId: assignment.personaId,
        growthDelta,
        reputationDelta,
        now,
      }));

      this.ctx.insertReputationHistoryInTx(
        db,
        input.tenantId,
        assignment.personaId,
        persona.reputation,
        persona.reputation + reputationDelta,
        `task_accepted:${task.id}`,
      );

      this.ctx.insertGrowthEventInTx(db, {
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

      this.ctx.memoryHook.insertMemoryInTx(db, {
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
        this.ctx.governanceHook.insertGovernanceEventInTx(db, {
          tenantId: input.tenantId,
          personaId: assignment.personaId,
          eventType: 'reward',
          severity: 2,
          summary: `高质量任务被验收: ${task.title}`,
          payload: { taskId: task.id, qualityScore, clientRating },
          actorUserId: input.actorUserId,
        });
      }

      publishObservabilityEvent(db, {
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

      recordBusinessAuditLog(db, {
        tenantId: input.tenantId,
        actorType: 'user',
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
    } catch (err) {
      /* 只吞哨兵：CAS 抢占失败 → 事务已 ROLLBACK，无任何副作用。其余异常照常上抛。 */
      if (!(err instanceof LeaseLostError)) throw err;
    }

    /* CAS 失败（并发下别人先验收了）→ 事务已整体回滚（result/assignment 的
     * accepted 写入也一并撤销），**绝不能继续结算**，否则同一笔分账两次。 */
    if (!claimedAccept) return null;

    /* 零回归：保持两阶段时序——先提交上面的验收事务，再独立调 public settleTaskPayment
     * （另开事务结算）。settleTaskPaymentInTx 变体本 task 仅为契约完整存在，此处不改调它。 */
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
    const db = this.source.forTenant(input.tenantId);
    db.transaction(() => {
      db.execute(pcoreCmdRejectTaskResult({
        tenantId: input.tenantId,
        resultId: result.id,
        reason: input.reason,
        now,
      }));

      db.execute(pcoreCmdRejectTaskAssignment({
        tenantId: input.tenantId,
        assignmentId: assignment.id,
        now,
      }));

      db.execute(pcoreCmdRejectTaskApplication({
        tenantId: input.tenantId,
        applicationId: assignment.applicationId,
        now,
      }));

      db.execute(pcoreCmdReopenMarketplaceTask({
        tenantId: input.tenantId,
        taskId: input.taskId,
        now,
      }));

      publishObservabilityEvent(db, {
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

    /* 零回归（调用矩阵 D8）：insertMemory 现状在事务【外】调用，保持位置不变。 */
    this.ctx.memoryHook.insertMemoryInTx(db, {
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
    const governanceCase = this.ctx.governanceHook.openGovernanceCase({
      tenantId: input.tenantId,
      actorUserId: input.actorUserId,
      personaId: task.assigneePersonaId,
      taskId: task.id,
      triggerType: 'task_dispute',
      severity: 'medium',
      details: { reason: input.reason, taskId: task.id, assignmentId: assignment.id },
    });
    if (!governanceCase) return null;

    /* 零回归：保持现有两阶段时序——openGovernanceCase 在上方先独立提交（自开事务），
     * 再开下面的 dispute 事务。openGovernanceCaseInTx 变体本 task 仅为契约完整存在，此处不改调。 */
    const now = Date.now();
    const db = this.source.forTenant(input.tenantId);
    db.transaction(() => {
      db.execute(pcoreCmdDisputeTaskAssignment({
        tenantId: input.tenantId,
        assignmentId: assignment.id,
        now,
      }));

      if (result) {
        db.execute(pcoreCmdDisputeTaskResult({
          tenantId: input.tenantId,
          resultId: result.id,
          now,
        }));
      }

      db.execute(pcoreCmdTouchMarketplaceTask({
        tenantId: input.tenantId,
        taskId: task.id,
        now,
      }));

      publishObservabilityEvent(db, {
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
    const nextCase = this.ctx.governanceHook.getGovernanceCaseById(input.tenantId, governanceCase.id);
    if (!nextTask || !nextAssignment || !nextCase) return null;

    return {
      task: nextTask,
      assignment: nextAssignment,
      result: nextResult,
      governanceCase: nextCase,
    };
  }

  /* ── Governance domain (delegated to PersonaGovernanceService — Step 16c) ──
   * Public methods are thin pass-throughs; the still-in-core methods
   * (addGovernanceEvent / disputeTask) call into the same sub-service
   * via `this.ctx.governanceHook.{insertGovernanceEvent, severityToLevel,
   * openGovernanceCase, getGovernanceCaseById}` so the governance
   * write path stays single-sourced. */

  publishTask(input: PublishMarketplaceTaskInput): MarketplaceTask {
    /* ⚠️ 审计 P1（独立审查补漏）：零/负奖励任务**从源头拒绝**。
     *
     * 此前 API 允许 `reward = 0`（`z.number().min(0)`），而结算路径有
     * `totalAmountMinor <= 0 → return null`。我第一版只在 acceptSubmittedTask
     * 入口前置拒绝，**漏了 completeTask**——审查实测：`completeTask(reward=0)`
     * 仍能把任务推到 completed 且零结算记录（它走 wallet 直更、不产生结算行）。
     * 逐个入口打补丁必然漏，故改在源头消灭这种任务：不存在零奖励任务，
     * 两个入口就都不用特判。 */
    if (!Number.isFinite(input.reward) || input.reward <= 0) {
      throw new ValidationError('任务奖励必须为正数', ErrorCode.VALIDATION_RANGE);
    }
    const now = Date.now();
    const taskId = generatePrefixedId('mkt');
    this.source.forTenant(input.tenantId).execute(pcoreCmdPublishMarketplaceTask({
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
    return this.source.forTenant(tenantId).queryMany(pcoreQueryMarketplaceTasksByTenant({ tenantId, status })).map(taskFromRow);
  }

  getMarketplaceTaskById(tenantId: string, taskId: string): MarketplaceTask | null {
    return this.getMarketplaceTask(tenantId, taskId);
  }

  acceptTask(input: AcceptMarketplaceTaskInput): MarketplaceTask | null {
    const persona = this.ctx.getPersonaDetail(input.tenantId, input.ownerUserId, input.personaId);
    if (!persona || persona.status !== 'active') return null;
    if (input.forkId && !this.ctx.forkBelongsToPersona(input.tenantId, input.personaId, input.forkId)) return null;

    const task = this.getMarketplaceTask(input.tenantId, input.taskId);
    if (!task || task.status !== 'open') return null;

    const now = Date.now();
    const db = this.source.forTenant(input.tenantId);
    db.transaction(() => {
      db.execute(pcoreCmdAcceptMarketplaceTaskLegacy({
        tenantId: input.tenantId,
        taskId: input.taskId,
        personaId: input.personaId,
        forkId: input.forkId ?? null,
        now,
      }));

      this.ctx.memoryHook.insertMemoryInTx(db, {
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
    const persona = this.ctx.getPersonaDetail(input.tenantId, input.ownerUserId, personaId);
    if (!persona || this.ctx.isTerminalStatus(persona.status)) return null;

    const now = Date.now();
    const qualityScore = clamp(input.qualityScore, 0, 1);
    const ownerTrainingHours = Math.max(0, input.ownerTrainingHours ?? 0);
    const rewardSignal = Math.max(task.reward, 1) / 100;
    const growthDelta = round(rewardSignal * (0.6 + qualityScore) + ownerTrainingHours * 0.15);
    const reputationDelta = round((qualityScore - 0.5) * 8 + rewardSignal * 3);
    const payout = round(task.reward * Math.max(qualityScore, 0.2), 2);
    const tokenReward = round(growthDelta * 8, 2);

    const db = this.source.forTenant(input.tenantId);
    let claimed = true;
    try {
      db.transaction(() => {
      /* ⚠️ 审计 P1：状态迁移必须是 CAS —— 上面的 `task.status !== 'accepted'` 判定发生在
       * **事务之外**，两个并发调用会都读到 'accepted' 并都通过。真正的互斥点在这条
       * `WHERE ... AND status = 'accepted'` 上：只有抢到的那次 rowsAffected=1。
       * 没抢到就**必须中止**，否则钱包/成长/声誉等副作用照样执行 → 重复结算
       * （实测：reward=100 交错完成两次 → 余额 90 变 180）。 */
      const claim = db.execute(pcoreCmdCompleteMarketplaceTask({
        tenantId: input.tenantId,
        taskId: input.taskId,
        qualityScore,
        growthDelta,
        now,
      }));
      if (claim.rowsAffected !== 1) {
        claimed = false;
        throw new LeaseLostError();
      }

      db.execute(pcoreCmdCompleteTaskWalletUpdate({
        tenantId: input.tenantId,
        personaId,
        payout,
        tokenReward,
        now,
      }));

      db.execute(pcoreCmdCompleteTaskPersonaUpdate({
        tenantId: input.tenantId,
        personaId,
        growthDelta,
        reputationDelta,
        ownerTrainingHours,
        now,
      }));

      this.ctx.insertReputationHistoryInTx(
        db,
        input.tenantId,
        personaId,
        persona.reputation,
        persona.reputation + reputationDelta,
        `task_completed:${task.id}`,
      );

      this.ctx.insertGrowthEventInTx(db, {
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

      this.ctx.memoryHook.insertMemoryInTx(db, {
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
        this.ctx.governanceHook.insertGovernanceEventInTx(db, {
          tenantId: input.tenantId,
          personaId,
          eventType: 'reward',
          severity: 2,
          summary: `高质量完成任务: ${task.title}`,
          payload: { taskId: task.id, qualityScore },
          actorUserId: input.ownerUserId,
        });
      }

      publishObservabilityEvent(db, {
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
    } catch (err) {
      if (!(err instanceof LeaseLostError)) throw err;
    }

    /* CAS 失败（并发下别人先完成了这个任务）→ 事务已 ROLLBACK，无副作用，返回 null。
     * 与「任务不存在 / 状态不对」走同一条返回路径，调用方无需区分。 */
    if (!claimed) return null;

    const nextTask = this.getMarketplaceTask(input.tenantId, task.id);
    /* Reach wallet via walletHook.getWalletByPersonaId since the
     * facade's getWallet would create a cross-service round trip. */
    const wallet = this.ctx.walletHook.getWalletByPersonaId(input.tenantId, personaId);
    const nextPersona = this.ctx.getPersonaDetail(input.tenantId, input.ownerUserId, personaId);
    if (!nextTask || !wallet || !nextPersona) return null;

    return {
      task: nextTask,
      wallet,
      persona: nextPersona,
    };
  }

  private getMarketplaceTask(tenantId: string, taskId: string): MarketplaceTask | null {
    const row = this.source.forTenant(tenantId).queryOne(pcoreQueryMarketplaceTaskById({ tenantId, taskId }));
    return row ? taskFromRow(row) : null;
  }

  private getTaskAssignmentById(tenantId: string, assignmentId: string): TaskAssignment | null {
    const row = this.source.forTenant(tenantId).queryOne(pcoreQueryTaskAssignmentById({ tenantId, assignmentId }));
    return row ? taskAssignmentFromRow(row) : null;
  }

  private getLatestTaskAssignmentByTask(tenantId: string, taskId: string): TaskAssignment | null {
    const row = this.source.forTenant(tenantId).queryOne(pcoreQueryLatestTaskAssignmentByTask({ tenantId, taskId }));
    return row ? taskAssignmentFromRow(row) : null;
  }

  private getLatestTaskAssignmentForPersonaAndTask(tenantId: string, personaId: string, taskId: string): TaskAssignment | null {
    const row = this.source.forTenant(tenantId).queryOne(pcoreQueryLatestTaskAssignmentForPersonaTask({ tenantId, personaId, taskId }));
    return row ? taskAssignmentFromRow(row) : null;
  }

  private getLatestTaskResultByAssignment(tenantId: string, assignmentId: string): TaskResult | null {
    const row = this.source.forTenant(tenantId).queryOne(pcoreQueryLatestTaskResultByAssignment({ tenantId, assignmentId }));
    return row ? taskResultFromRow(row) : null;
  }

  /* getGovernanceCaseById / getGovernanceActionById moved to
   * PersonaGovernanceService as part of the Step 16c split. The
   * still-in-core disputeTask calls through
   * `this.ctx.governanceHook.getGovernanceCaseById(...)`. */
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

  private getRankingTaskStats(
    tenantId: string,
    personaId: string,
    category?: MarketplaceTask['category'],
  ): { completedTasks: number; avgQuality: number; responseSpeed: number } {
    const db = this.source.forTenant(tenantId);
    const row = category
      ? db.queryOne(pcoreQueryRankingTaskStats({ tenantId, personaId, category }))
      : db.queryOne(pcoreQueryRankingTaskStatsUncategorized({ tenantId, personaId }));

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

}
