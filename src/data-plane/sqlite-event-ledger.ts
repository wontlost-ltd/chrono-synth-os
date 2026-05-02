import { randomUUID } from 'node:crypto';
import type { IDatabase } from '../storage/database.js';
import {
  type EventLedger,
  type AuthoritySwitch,
  type AuthorityMode,
  type LedgerEvent,
  type DraftEvent,
  type AppendResult,
  type ConsumerBatch,
  VersionConflictError,
} from '@chrono/data-plane';

interface EventLedgerRow {
  event_id: string;
  tenant_id: string;
  stream_id: string;
  stream_version: number;
  event_type: string;
  schema_version: number;
  occurred_at: number;
  command_id: string;
  payload_json: string;
  backfill_source_id: string | null;
}

interface CheckpointRow {
  consumer_id: string;
  last_event_id: string;
  updated_at: number;
}

interface AuthorityRow {
  mode: string;
  changed_at: number;
  changed_reason: string;
}

function toEvent(row: EventLedgerRow): LedgerEvent {
  return {
    eventId: row.event_id,
    tenantId: row.tenant_id,
    streamId: row.stream_id,
    streamVersion: row.stream_version,
    eventType: row.event_type,
    schemaVersion: row.schema_version,
    occurredAt: row.occurred_at,
    commandId: row.command_id,
    payloadJson: row.payload_json,
    ...(row.backfill_source_id !== null ? { backfillSourceId: row.backfill_source_id } : {}),
  };
}

export class SqliteEventLedger implements EventLedger {
  constructor(private readonly db: IDatabase) {}

  async append(
    tenantId: string,
    streamId: string,
    events: readonly [DraftEvent, ...DraftEvent[]],
    expectedVersion?: number,
  ): Promise<AppendResult> {
    let newVersion = 0;

    this.db.transaction(() => {
      const maxRow = this.db
        .prepare<{ max_v: number | null }>(
          'SELECT MAX(stream_version) AS max_v FROM event_ledger WHERE tenant_id = ? AND stream_id = ?',
        )
        .get(tenantId, streamId);
      const currentVersion = maxRow?.max_v ?? -1;

      if (expectedVersion !== undefined && currentVersion !== expectedVersion) {
        throw new VersionConflictError(streamId, expectedVersion, currentVersion);
      }

      const insert = this.db.prepare(
        `INSERT INTO event_ledger
          (event_id, tenant_id, stream_id, stream_version, event_type, schema_version,
           occurred_at, command_id, payload_json, backfill_source_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(event_id) DO NOTHING`,
      );

      let version = currentVersion;
      for (const draft of events) {
        version += 1;
        insert.run(
          randomUUID(),
          tenantId,
          streamId,
          version,
          draft.eventType,
          draft.schemaVersion,
          Date.now(),
          draft.commandId,
          draft.payloadJson,
          draft.backfillSourceId ?? null,
        );
      }
      newVersion = version;
    });

    return { newVersion, eventCount: events.length };
  }

  async loadStream(
    tenantId: string,
    streamId: string,
    sinceVersion = -1,
  ): Promise<readonly LedgerEvent[]> {
    const rows = this.db
      .prepare<EventLedgerRow>(
        `SELECT * FROM event_ledger
         WHERE tenant_id = ? AND stream_id = ? AND stream_version > ?
         ORDER BY stream_version ASC`,
      )
      .all(tenantId, streamId, sinceVersion);
    return rows.map(toEvent);
  }

  async nextBatch(_consumerId: string, batchSize: number): Promise<ConsumerBatch> {
    const consumerId = _consumerId;
    const checkpoint = this.db
      .prepare<CheckpointRow>(
        'SELECT * FROM event_ledger_consumer_checkpoints WHERE consumer_id = ?',
      )
      .get(consumerId);

    let rows: EventLedgerRow[];
    if (!checkpoint) {
      rows = this.db
        .prepare<EventLedgerRow>(
          'SELECT * FROM event_ledger ORDER BY occurred_at ASC, event_id ASC LIMIT ?',
        )
        .all(batchSize);
    } else {
      rows = this.db
        .prepare<EventLedgerRow>(
          `SELECT * FROM event_ledger
           WHERE occurred_at > (SELECT occurred_at FROM event_ledger WHERE event_id = ?)
              OR (
                occurred_at = (SELECT occurred_at FROM event_ledger WHERE event_id = ?)
                AND event_id > ?
              )
           ORDER BY occurred_at ASC, event_id ASC
           LIMIT ?`,
        )
        .all(checkpoint.last_event_id, checkpoint.last_event_id, checkpoint.last_event_id, batchSize);
    }

    const lastEventId = rows.length > 0 ? rows[rows.length - 1]!.event_id : (checkpoint?.last_event_id ?? '');
    const batchHandle = Buffer.from(lastEventId).toString('base64');

    return { events: rows.map(toEvent), batchHandle };
  }

  async ackBatch(consumerId: string, batchHandle: string): Promise<void> {
    const lastEventId = Buffer.from(batchHandle, 'base64').toString('utf-8');
    this.db
      .prepare(
        `INSERT INTO event_ledger_consumer_checkpoints(consumer_id, last_event_id, updated_at)
         VALUES(?, ?, ?)
         ON CONFLICT(consumer_id) DO UPDATE SET last_event_id = excluded.last_event_id, updated_at = excluded.updated_at`,
      )
      .run(consumerId, lastEventId, Date.now());
  }
}

export class SqliteAuthoritySwitch implements AuthoritySwitch {
  constructor(private readonly db: IDatabase) {}

  async currentMode(): Promise<AuthorityMode> {
    const row = this.db
      .prepare<AuthorityRow>('SELECT mode FROM event_ledger_authority WHERE singleton = 1')
      .get();
    return (row?.mode ?? 'tables_primary') as AuthorityMode;
  }

  async switchTo(mode: AuthorityMode, reason: string): Promise<void> {
    this.db
      .prepare(
        `UPDATE event_ledger_authority SET mode = ?, changed_at = ?, changed_reason = ? WHERE singleton = 1`,
      )
      .run(mode, Date.now(), reason);
  }
}
