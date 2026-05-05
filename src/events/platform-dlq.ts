/**
 * Platform DLQ — 死信队列记录与重放
 * 通过 SyncWriteUnitOfWork 的 Query/Command 契约访问数据
 */

import type { IDatabase } from '../storage/database.js';
import type { SyncWriteUnitOfWork, DlqEventRow } from '@chrono/kernel';
import {
  dlqQueryByTenant, dlqQueryBacklogPending, dlqQueryBacklogReplayed,
  dlqQueryById, dlqCmdRecord, dlqCmdMarkReplayed,
} from '@chrono/kernel';
import { directUnitOfWork } from '../storage/direct-uow-adapter.js';
import { registerCoreSelfExecutors } from '../storage/executors/index.js';
import { OBSERVABILITY_TOPIC, publishObservabilityEvent, type ObservabilityEventType } from '../observability/observability-outbox.js';
import { generatePrefixedId } from '../utils/id-generator.js';

export type PlatformDlqTopic = 'runtime.dlq' | 'wallet.dlq' | 'governance.dlq';
export type PlatformDlqStatus = 'pending' | 'replayed';

export interface PlatformDlqRow {
  id: string;
  tenant_id: string;
  source_component: string;
  source_topic: string;
  dlq_topic: PlatformDlqTopic;
  event_type: string;
  partition_key: string | null;
  payload_json: string;
  error_message: string;
  status: PlatformDlqStatus;
  created_at: number;
  replayed_at: number | null;
}

export interface PlatformDlqEvent {
  id: string;
  tenantId: string;
  sourceComponent: string;
  sourceTopic: string;
  dlqTopic: PlatformDlqTopic;
  eventType: string;
  partitionKey: string | null;
  payload: unknown;
  errorMessage: string;
  status: PlatformDlqStatus;
  createdAt: number;
  replayedAt: number | null;
}

export interface RecordPlatformDlqInput {
  tenantId: string;
  sourceComponent: string;
  sourceTopic: string;
  eventType?: string | null;
  partitionKey?: string | null;
  payload: unknown;
  errorMessage: string;
  createdAt?: number;
}

const OBSERVABILITY_EVENT_TYPES = new Set<ObservabilityEventType>([
  'runtime.completed',
  'task.outcome',
  'wallet.settlement_completed',
  'governance.case_opened',
  'governance.action_applied',
  'persona.growth_recorded',
]);

export function resolvePlatformDlqTopic(eventType?: string | null): PlatformDlqTopic {
  if (eventType?.startsWith('wallet.')) return 'wallet.dlq';
  if (eventType?.startsWith('governance.')) return 'governance.dlq';
  return 'runtime.dlq';
}

function getTx(db: IDatabase): SyncWriteUnitOfWork {
  registerCoreSelfExecutors();
  return directUnitOfWork(db);
}

export function recordPlatformDlqEvent(db: IDatabase, input: RecordPlatformDlqInput): string {
  const tx = getTx(db);
  const id = generatePrefixedId('dlq');
  const createdAt = input.createdAt ?? Date.now();
  const eventType = input.eventType ?? 'unknown';
  tx.execute(dlqCmdRecord({
    id,
    tenantId: input.tenantId,
    sourceComponent: input.sourceComponent,
    sourceTopic: input.sourceTopic,
    dlqTopic: resolvePlatformDlqTopic(eventType),
    eventType,
    partitionKey: input.partitionKey ?? null,
    payloadJson: JSON.stringify(input.payload ?? null),
    errorMessage: input.errorMessage,
    createdAt,
  }));
  return id;
}

export function listPlatformDlqEvents(db: IDatabase, tenantId: string, limit = 100): PlatformDlqEvent[] {
  const tx = getTx(db);
  const rows = tx.queryMany(dlqQueryByTenant(tenantId, limit));
  return rows.map(platformDlqFromRow);
}

export function getPlatformDlqBacklog(db: IDatabase): { pending: number; replayed: number } {
  const tx = getTx(db);
  const pending = tx.queryOne(dlqQueryBacklogPending())?.count ?? 0;
  const replayed = tx.queryOne(dlqQueryBacklogReplayed())?.count ?? 0;
  return { pending, replayed };
}

export function replayPlatformDlqEvent(db: IDatabase, id: string): boolean {
  const tx = getTx(db);
  const row = tx.queryOne(dlqQueryById(id));
  if (!row || row.status !== 'pending') return false;
  if (row.source_topic !== OBSERVABILITY_TOPIC) {
    throw new Error(`暂不支持重放 source_topic=${row.source_topic} 的 DLQ 事件`);
  }
  if (!OBSERVABILITY_EVENT_TYPES.has(row.event_type as ObservabilityEventType)) {
    throw new Error(`暂不支持重放 event_type=${row.event_type} 的 DLQ 事件`);
  }

  const payload = safeParsePayload(row.payload_json);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('DLQ payload 不是可重放的对象');
  }

  publishObservabilityEvent(tx, {
    tenantId: row.tenant_id,
    topic: OBSERVABILITY_TOPIC,
    eventType: row.event_type as ObservabilityEventType,
    partitionKey: row.partition_key ?? row.id,
    payload: payload as Record<string, unknown>,
  });

  tx.execute(dlqCmdMarkReplayed({ id, now: Date.now() }));
  return true;
}

function platformDlqFromRow(row: DlqEventRow): PlatformDlqEvent {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    sourceComponent: row.source_component,
    sourceTopic: row.source_topic,
    dlqTopic: row.dlq_topic as PlatformDlqTopic,
    eventType: row.event_type,
    partitionKey: row.partition_key,
    payload: safeParsePayload(row.payload_json),
    errorMessage: row.error_message,
    status: row.status as PlatformDlqStatus,
    createdAt: Number(row.created_at),
    replayedAt: row.replayed_at === null ? null : Number(row.replayed_at),
  };
}

function safeParsePayload(payloadJson: string): unknown {
  try {
    return JSON.parse(payloadJson) as unknown;
  } catch {
    return payloadJson;
  }
}
