import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createKmsClient } from '../../enterprise/kms-client.js';
import { EnvelopeEncryption } from '../../enterprise/envelope-encryption.js';
import { LocalObjectStorageClient } from '../../privacy/object-storage-client.js';
import { loadConfig } from '../../config/schema.js';
import { createMemoryDatabase } from '../../storage/database.js';
import { runDslSqliteMigrations } from '../../storage/index.js';

describe('BYOK/BYOS GA roundtrip', () => {
  it('roundtrips envelope encryption and local object storage', async () => {
    const db = createMemoryDatabase();
    runDslSqliteMigrations(db);
    const tmpDir = await mkdtemp(join(tmpdir(), 'chrono-byok-byos-'));

    try {
      const config = loadConfig({
        encryption: {
          enabled: true,
          masterKey: randomBytes(32).toString('base64'),
          defaultKeyRef: 'master',
          keyring: {},
          keyRotationIntervalDays: 90,
        },
      });
      const kms = createKmsClient('platform', config);
      const envelope = new EnvelopeEncryption(kms, db, 'tenant-byok', 'master');

      const plaintext = 'known plaintext for byok-byos roundtrip';
      const ciphertext = await envelope.encrypt(plaintext);
      const decrypted = await envelope.decrypt(ciphertext);

      assert.ok(ciphertext.startsWith('env.v1.'));
      assert.equal(decrypted, plaintext);

      const storage = new LocalObjectStorageClient(tmpDir);
      const data = Buffer.from('stored payload');
      const key = await storage.upload('objects/roundtrip.bin', data, 'application/octet-stream');
      const url = await storage.presignUrl(key, 60);

      assert.ok(url.startsWith('file://'));
      await access(url.replace(/^file:\/\//, ''));
    } finally {
      db.close();
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});
