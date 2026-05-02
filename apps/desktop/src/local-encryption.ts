import { EnvelopeEncryption } from '../../../dist/enterprise/envelope-encryption.js';
import { createKmsClient } from '../../../dist/enterprise/kms-client.js';
import { createMemoryDatabase } from '../../../dist/storage/database.js';
import { runMigrations } from '../../../dist/storage/migrations.js';

// Desktop persistence is scheduled for Phase 4; Phase 3 uses the shared envelope path with an in-memory DB.
export function createDesktopEncryption(masterKey: string, tenantId: string): EnvelopeEncryption {
  const db = createMemoryDatabase();
  runMigrations(db);
  const kmsClient = createKmsClient('platform', { encryption: { masterKey, enabled: true } } as any);
  return new EnvelopeEncryption(kmsClient, db, tenantId, 'master');
}
