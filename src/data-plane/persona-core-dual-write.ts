import type { IDatabase } from '../storage/database.js';
import type { EventLedger } from '@chrono/data-plane';
import { generatePrefixedId } from '../utils/id-generator.js';

interface OutboxRow {
  id: string;
  tenant_id: string;
  stream_id: string;
  payload_json: string;
  event_type: string;
  command_id: string;
  created_at: number;
  attempts: number;
  last_attempted_at: number | null;
  error: string | null;
}

export interface PersonaCoreDualWriteService {
  enqueuePersonaEvent(
    db: IDatabase,
    tenantId: string,
    streamId: string,
    eventType: string,
    commandId: string,
    payloadJson: string,
  ): void;
  flushOutbox(db: IDatabase, ledger: EventLedger): Promise<{ flushed: number; failed: number }>;
}

function enqueuePersonaEvent(
  db: IDatabase,
  tenantId: string,
  streamId: string,
  eventType: string,
  commandId: string,
  payloadJson: string,
): void {
  db.prepare(
    `INSERT INTO persona_core_ledger_outbox
      (id, tenant_id, stream_id, payload_json, event_type, command_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    generatePrefixedId('pco'),
    tenantId,
    streamId,
    payloadJson,
    eventType,
    commandId,
    Date.now(),
  );
}

async function flushOutbox(
  db: IDatabase,
  ledger: EventLedger,
): Promise<{ flushed: number; failed: number }> {
  const pending = db
    .prepare<OutboxRow>(
      `SELECT * FROM persona_core_ledger_outbox WHERE attempts < 3 ORDER BY created_at ASC LIMIT 100`,
    )
    .all();

  let flushed = 0;
  let failed = 0;

  // Group by (tenantId, streamId) to append in order
  const groups = new Map<string, OutboxRow[]>();
  for (const row of pending) {
    const key = `${row.tenant_id}::${row.stream_id}`;
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }

  for (const [, rows] of groups) {
    const first = rows[0]!;
    const drafts = rows.map(r => ({
      eventType: r.event_type,
      schemaVersion: 1,
      commandId: r.command_id,
      payloadJson: r.payload_json,
    }));

    try {
      await ledger.append(first.tenant_id, first.stream_id, [drafts[0]!, ...drafts.slice(1)]);
      const ids = rows.map(() => '?').join(',');
      db.prepare(`DELETE FROM persona_core_ledger_outbox WHERE id IN (${ids})`).run(
        ...rows.map(r => r.id),
      );
      flushed += rows.length;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      const now = Date.now();
      for (const row of rows) {
        db.prepare(
          `UPDATE persona_core_ledger_outbox
           SET attempts = attempts + 1, last_attempted_at = ?, error = ?
           WHERE id = ?`,
        ).run(now, errorMsg, row.id);
      }
      failed += rows.length;
    }
  }

  return { flushed, failed };
}

export const personaCoreDualWrite: PersonaCoreDualWriteService = {
  enqueuePersonaEvent,
  flushOutbox,
};
