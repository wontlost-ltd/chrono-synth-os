import { obsCmdClaimEvent } from '@chrono/kernel';
import type { IDatabase } from '../storage/database.js';
import { directUnitOfWork } from '../storage/direct-uow-adapter.js';
import { registerCoreSelfExecutors } from '../storage/executors/index.js';
import { applyObservabilityRollupDelta, type ObservabilityEventType, type ObservabilityRollupDelta } from './observability-outbox.js';

export interface ObservabilityStoredEvent {
  id?: string;
  tenantId: string;
  eventType: ObservabilityEventType;
  payload: Record<string, unknown>;
  createdAt: number;
}

export function applyObservabilityStoredEvent(db: IDatabase, event: ObservabilityStoredEvent): boolean {
  if (event.id && !claimObservabilityEvent(db, event)) {
    return false;
  }
  applyObservabilityRollupDelta(db, event.tenantId, toRollupDelta(event));
  return true;
}

export function toRollupDelta(event: ObservabilityStoredEvent): ObservabilityRollupDelta {
  const updatedAt = numberValue(event.payload.updatedAt) ?? event.createdAt;

  switch (event.eventType) {
    case 'runtime.completed':
      return {
        runtimeCompletedCount: 1,
        runtimeDurationTotalMs: nonNegativeInt(event.payload.durationMs),
        updatedAt,
      };

    case 'task.outcome': {
      const outcome = stringValue(event.payload.outcome);
      const isTerminal = event.payload.terminal === undefined ? true : event.payload.terminal === true;
      const isSuccess = event.payload.success === true;
      return {
        taskTerminalCount: isTerminal ? 1 : 0,
        taskSuccessCount: isTerminal && isSuccess ? 1 : 0,
        taskRejectedCount: isTerminal && outcome === 'rejected' ? 1 : 0,
        taskDisputedCount: isTerminal && outcome === 'disputed' ? 1 : 0,
        updatedAt,
      };
    }

    case 'wallet.settlement_completed':
      return {
        walletSettlementCount: 1,
        walletSettlementTotalAmountMinor: nonNegativeInt(event.payload.totalAmountMinor),
        walletSettlementLatencyTotalMs: nonNegativeInt(event.payload.latencyMs),
        updatedAt,
      };

    case 'governance.case_opened':
      return {
        governanceCaseOpenedCount: 1,
        governanceCaseActiveCount: 1,
        updatedAt,
      };

    case 'governance.action_applied': {
      const previousStatus = stringValue(event.payload.previousStatus);
      const nextStatus = stringValue(event.payload.caseStatus);
      const shouldCloseActiveCase =
        previousStatus !== undefined &&
        nextStatus !== undefined &&
        ['open', 'appealed'].includes(previousStatus) &&
        !['open', 'appealed'].includes(nextStatus);
      return {
        governanceActionAppliedCount: 1,
        governanceCaseActiveCount: shouldCloseActiveCase ? -1 : 0,
        updatedAt,
      };
    }

    case 'persona.growth_recorded':
      return {
        personaGrowthTotal: numberValue(event.payload.growthDelta) ?? 0,
        personaGrowthEventCount: 1,
        personaReputationDeltaTotal: numberValue(event.payload.reputationDelta) ?? 0,
        updatedAt,
      };
  }
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function nonNegativeInt(value: unknown): number {
  const numeric = numberValue(value);
  if (numeric === undefined) return 0;
  return Math.max(0, Math.round(numeric));
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function claimObservabilityEvent(db: IDatabase, event: ObservabilityStoredEvent): boolean {
  registerCoreSelfExecutors();
  const tx = directUnitOfWork(db);
  const result = tx.execute(obsCmdClaimEvent({
    eventId: event.id!,
    tenantId: event.tenantId,
    eventType: event.eventType,
    processedAt: Date.now(),
  }));
  return result.rowsAffected > 0;
}
