/**
 * Persona governance sub-service — Step 16c.
 *
 * Owns the case / action / appeal lifecycle for the governance domain.
 * Splits cleanly from the still-in-core lifecycle methods
 * (markDeceased, evaluateLifecycle, addGovernanceEvent) which reach
 * into multiple domains (memory + growth + reputation) and remain on
 * the facade until those crossings can be untangled.
 *
 * What this sub-service owns:
 *   - listGovernanceCases (read)
 *   - openGovernanceCase (case + initiating event + memory + audit)
 *   - applyGovernanceAction (case status transition + persona status
 *     transition + reputation/growth deltas + audit)
 *   - appealGovernanceCase (appeal JSON + review event)
 *   - All governance-private helpers:
 *       severityToLevel, resolvePersonaStatusForAction,
 *       reputationDeltaForAction, governanceEventTypeForAction,
 *       getGovernanceCaseById, getGovernanceActionById,
 *       insertGovernanceEvent
 *
 * What stays on PersonaCoreService:
 *   - addGovernanceEvent (touches memory + growth + reputation +
 *     lifecycle status — cross-domain), markDeceased, evaluateLifecycle
 *   - insertGrowthEvent + insertReputationHistory (persona-state
 *     writes used by every domain, not governance-specific)
 *
 * Cross-domain dependencies (injected via PersonaGovernanceContext):
 *   - getPersonaById — persona-state lookup by id (no owner check),
 *     used by case open / action apply / appeal
 *   - personaExists — owner check for listGovernanceCases
 *   - toLegacyStatus — facade-private mapper from new persona-status
 *     enum to the legacy status column
 *   - insertGrowthEvent + insertReputationHistory — persona-state
 *     writes (kept on the facade because they're called by many
 *     domains, not just governance)
 *   - insertMemory (via memoryHook) — memory write capability for the
 *     governance audit trail
 *
 * Direct infrastructure dependencies (NOT injected, called as plain
 * function imports — these are stateless module-level helpers that
 * write to the same shared tx the service already holds):
 *   - publishObservabilityEvent (../observability/observability-outbox)
 *   - recordBusinessAuditLog (../audit/audit-log-store)
 * If a future sub-service ever needs to substitute these (e.g. for
 * a test sink), promote them to PersonaGovernanceContext at that point.
 */

import type { SyncWriteUnitOfWork } from '@chrono/kernel';
import {
  pcoreCmdAppealGovernanceCase,
  pcoreCmdApplyGovernanceActionToPersona,
  pcoreCmdCreateGovernanceAction,
  pcoreCmdCreateGovernanceCase,
  pcoreCmdInsertGovernanceEvent,
  pcoreCmdUpdateGovernanceCaseAction,
  pcoreQueryGovernanceActionById,
  pcoreQueryGovernanceCaseById,
  pcoreQueryGovernanceCasesByPersona,
  type PcoreGovernanceActionRow,
  type PcoreGovernanceCaseRow,
} from '@chrono/kernel';
import { generatePrefixedId } from '../utils/id-generator.js';
import { OBSERVABILITY_TOPIC, publishObservabilityEvent } from '../observability/observability-outbox.js';
import { recordBusinessAuditLog } from '../audit/audit-log-store.js';
import { clamp, round, safeJsonParse } from './persona-core-utils.js';
import type {
  AppealGovernanceCaseInput,
  ApplyGovernanceActionInput,
  GovernanceAction,
  GovernanceActionType,
  GovernanceCase,
  GovernanceCaseSeverity,
  OpenGovernanceCaseInput,
  PersonaCore,
  PersonaGovernanceEvent,
  PersonaMemory,
  PersonaMemorySensitivity,
} from './types.js';

/* ── Row mappers (exported for facade reuse if needed) ─────────── */

export function governanceCaseFromRow(row: PcoreGovernanceCaseRow): GovernanceCase {
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

export function governanceActionFromRow(row: PcoreGovernanceActionRow): GovernanceAction {
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

/* ── Service ───────────────────────────────────────────────────── */

/**
 * Memory hook used by the governance service to write entries into
 * the persona's memory trail. Mirrors the PersonaMemoryService
 * surface that the facade already uses internally; we accept just
 * the insertMemory shape so the governance service doesn't need a
 * reference to the whole memory service.
 */
export interface GovernanceMemoryHook {
  insertMemory(input: {
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

export interface PersonaGovernanceContext {
  /** Owner-aware persona lookup — true iff persona exists AND caller
   *  is the owner. Used by listGovernanceCases for read authorization. */
  personaExists(tenantId: string, ownerUserId: string, personaId: string): boolean;
  /** Persona lookup by id WITHOUT owner check. Used by openGovernanceCase
   *  (administrator action against any persona) and applyGovernanceAction
   *  (acting on the case's bound persona regardless of who triggered it). */
  getPersonaById(tenantId: string, personaId: string): PersonaCore | null;
  /** Map the new persona-status enum to the legacy status column.
   *  Kept on the facade because the new/legacy mapping is part of the
   *  persona model, not the governance model. */
  toLegacyStatus(status: PersonaCore['status']): Exclude<PersonaCore['status'], 'draft' | 'suspended' | 'dormant'>;
  /** Persona-state writes used by applyGovernanceAction. Kept on the
   *  facade because growth + reputation writes happen from many
   *  domains. */
  insertGrowthEvent(input: {
    tenantId: string;
    personaId: string;
    taskId?: string | null;
    eventType: 'governance' | 'task_completed' | 'knowledge_sync' | 'training';
    growthDelta: number;
    reputationDelta: number;
    trainingDelta: number;
    payload: Record<string, unknown>;
  }): void;
  insertReputationHistory(
    tenantId: string,
    personaId: string,
    from: number,
    to: number,
    reason: string,
  ): void;
  /** Memory hook (memory service insertMemory passthrough). */
  memoryHook: GovernanceMemoryHook;
}

export class PersonaGovernanceService {
  constructor(
    private readonly tx: SyncWriteUnitOfWork,
    private readonly ctx: PersonaGovernanceContext,
  ) {}

  /* ── Public API ─────────────────────────────────────────────── */

  listGovernanceCases(tenantId: string, ownerUserId: string, personaId: string): GovernanceCase[] | null {
    if (!this.ctx.personaExists(tenantId, ownerUserId, personaId)) return null;
    return this.tx.queryMany(pcoreQueryGovernanceCasesByPersona({ tenantId, personaId })).map(governanceCaseFromRow);
  }

  openGovernanceCase(input: OpenGovernanceCaseInput): GovernanceCase | null {
    const persona = this.ctx.getPersonaById(input.tenantId, input.personaId);
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

      this.ctx.memoryHook.insertMemory({
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

      publishObservabilityEvent(this.tx, {
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

      recordBusinessAuditLog(this.tx, {
        tenantId: input.tenantId,
        actorType: 'user',
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

    const persona = this.ctx.getPersonaById(input.tenantId, governanceCase.personaId);
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
        legacyStatus: this.ctx.toLegacyStatus(nextStatus),
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

      this.ctx.memoryHook.insertMemory({
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
        this.ctx.insertGrowthEvent({
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

        this.ctx.insertReputationHistory(
          input.tenantId,
          governanceCase.personaId,
          persona.reputation,
          persona.reputation + reputationDelta,
          `governance_action:${input.actionType}`,
        );
      }

      publishObservabilityEvent(this.tx, {
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

      recordBusinessAuditLog(this.tx, {
        tenantId: input.tenantId,
        actorType: 'user',
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

    const persona = this.ctx.getPersonaById(input.tenantId, governanceCase.personaId);
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

  /* ── Internal API (used by the still-in-core methods that touch
   *    governance) ──────────────────────────────────────────────── */

  /**
   * @internal — also called by addGovernanceEvent / settleTaskPayment
   * / submitTaskResult / acceptSubmittedTask / disputeTask in the
   * core file. Once those move to their respective sub-services, this
   * becomes private. */
  insertGovernanceEvent(input: {
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

  /** @internal — used by disputeTask in core to look up the case it
   *  just opened. */
  getGovernanceCaseById(tenantId: string, caseId: string): GovernanceCase | null {
    const row = this.tx.queryOne(pcoreQueryGovernanceCaseById({ tenantId, caseId }));
    return row ? governanceCaseFromRow(row) : null;
  }

  /** @internal */
  getGovernanceActionById(tenantId: string, actionId: string): GovernanceAction | null {
    const row = this.tx.queryOne(pcoreQueryGovernanceActionById({ tenantId, actionId }));
    return row ? governanceActionFromRow(row) : null;
  }

  /** @internal — severity-enum to numeric level used by every
   *  governance write path. Exposed so still-in-core methods that
   *  build governance events (settleTaskPayment, submitTaskResult,
   *  etc.) compute the same level for the same severity. */
  severityToLevel(severity: GovernanceCaseSeverity): number {
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

  /* ── Private helpers ────────────────────────────────────────── */

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
}
