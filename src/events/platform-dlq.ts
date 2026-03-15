import type { IDatabase } from '../storage/database.js';
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

export function recordPlatformDlqEvent(db: IDatabase, input: RecordPlatformDlqInput): string {
  const id = generatePrefixedId('dlq');
  const createdAt = input.createdAt ?? Date.now();
  const eventType = input.eventType ?? 'unknown';
  db.prepare<void>(
    `INSERT INTO platform_dlq_events (
      id, tenant_id, source_component, source_topic, dlq_topic, event_type,
      partition_key, payload_json, error_message, status, created_at, replayed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, NULL)`,
  ).run(
    id,
    input.tenantId,
    input.sourceComponent,
    input.sourceTopic,
    resolvePlatformDlqTopic(eventType),
    eventType,
    input.partitionKey ?? null,
    JSON.stringify(input.payload ?? null),
    input.errorMessage,
    createdAt,
  );
  return id;
}

export function listPlatformDlqEvents(db: IDatabase, tenantId: string, limit = 100): PlatformDlqEvent[] {
  return db.prepare<PlatformDlqRow>(
    `SELECT * FROM platform_dlq_events
     WHERE tenant_id = ?
     ORDER BY created_at DESC
     LIMIT ?`,
  ).all(tenantId, limit).map(platformDlqFromRow);
}

export function getPlatformDlqBacklog(db: IDatabase): { pending: number; replayed: number } {
  const pending = db.prepare<{ count: number }>(
    `SELECT COUNT(*) AS count FROM platform_dlq_events WHERE status = 'pending'`,
  ).get()?.count ?? 0;
  const replayed = db.prepare<{ count: number }>(
    `SELECT COUNT(*) AS count FROM platform_dlq_events WHERE status = 'replayed'`,
  ).get()?.count ?? 0;
  return { pending, replayed };
}

export function replayPlatformDlqEvent(db: IDatabase, id: string): boolean {
  const row = db.prepare<PlatformDlqRow>(
    `SELECT * FROM platform_dlq_events
     WHERE id = ?
     LIMIT 1`,
  ).get(id);
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

  publishObservabilityEvent(db, {
    tenantId: row.tenant_id,
    topic: OBSERVABILITY_TOPIC,
    eventType: row.event_type as ObservabilityEventType,
    partitionKey: row.partition_key ?? row.id,
    payload: payload as Record<string, unknown>,
  });

  db.prepare<void>(
    `UPDATE platform_dlq_events
     SET status = 'replayed', replayed_at = ?
     WHERE id = ?`,
  ).run(Date.now(), id);
  return true;
}

function platformDlqFromRow(row: PlatformDlqRow): PlatformDlqEvent {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    sourceComponent: row.source_component,
    sourceTopic: row.source_topic,
    dlqTopic: row.dlq_topic,
    eventType: row.event_type,
    partitionKey: row.partition_key,
    payload: safeParsePayload(row.payload_json),
    errorMessage: row.error_message,
    status: row.status,
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
