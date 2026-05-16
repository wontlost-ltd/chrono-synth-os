import { EnvelopeEncryption } from '../../../dist/enterprise/envelope-encryption.js';
import { createKmsClient } from '../../../dist/enterprise/kms-client.js';
import { createMemoryDatabase } from '../../../dist/storage/database.js';
import { runDslSqliteMigrations } from '../../../dist/storage/index.js';

// Desktop persistence is scheduled for Phase 4; Phase 3 uses the shared envelope path with an in-memory DB.
export function createDesktopEncryption(masterKey: string, tenantId: string): EnvelopeEncryption {
  const db = createMemoryDatabase();
  runDslSqliteMigrations(db);
  const kmsClient = createKmsClient('platform', { encryption: { masterKey, enabled: true } } as any);
  return new EnvelopeEncryption(kmsClient, db, tenantId, 'master');
}
