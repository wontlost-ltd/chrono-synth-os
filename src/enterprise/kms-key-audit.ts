import { randomUUID } from 'node:crypto';
import type { IDatabase } from '../storage/database.js';
import type { KmsProvider } from './kms-client.js';

export interface KeyAuditEntry {
  eventId: string;
  tenantId: string;
  operation: 'generate' | 'unwrap' | 'rotate';
  provider: KmsProvider;
  keyRef: string;
  performedAt: string;
  success: boolean;
  errorCode?: string;
}

export function auditKeyOperation(
  db: IDatabase,
  entry: Omit<KeyAuditEntry, 'eventId' | 'performedAt'>,
): void {
  const eventId = randomUUID();
  const performedAt = new Date().toISOString();
  db.prepare<void>(
    `INSERT INTO kms_key_audit (event_id, tenant_id, operation, provider, key_ref, performed_at, success, error_code)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    eventId,
    entry.tenantId,
    entry.operation,
    entry.provider,
    entry.keyRef,
    performedAt,
    entry.success ? 1 : 0,
    entry.errorCode ?? null,
  );
}
