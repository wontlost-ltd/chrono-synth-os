import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { FieldEncryption } from '../../storage/encryption.js';

describe('FieldEncryption keyRef 兼容性', () => {
  it('保留旧版 master 密文格式兼容', () => {
    const encryption = new FieldEncryption({
      enabled: true,
      masterKey: randomBytes(32).toString('base64'),
      keyRotationIntervalDays: 90,
    });

    const ciphertext = encryption.encrypt('legacy-payload');
    assert.doesNotMatch(ciphertext, /^v2\./);
    assert.equal(encryption.decrypt(ciphertext), 'legacy-payload');
  });

  it('支持带 keyRef 的 v2 密文读写', () => {
    const encryption = new FieldEncryption({
      enabled: true,
      masterKey: randomBytes(32).toString('base64'),
      defaultKeyRef: 'tenant-a',
      keyring: {
        'tenant-a': randomBytes(32).toString('base64'),
      },
      keyRotationIntervalDays: 90,
    });

    const ciphertext = encryption.encrypt('tenant-secret');
    assert.match(ciphertext, /^v2\.tenant-a\./);
    assert.equal(encryption.decrypt(ciphertext), 'tenant-secret');
  });
});

