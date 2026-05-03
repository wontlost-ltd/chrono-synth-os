import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { NodeFieldCrypto, NoopFieldCrypto } from '../../storage/node-field-crypto.js';

describe('NodeFieldCrypto', () => {
  it('wraps FieldEncryption for encrypted round trips', async () => {
    const crypto = new NodeFieldCrypto({
      enabled: true,
      masterKey: randomBytes(32).toString('base64'),
      defaultKeyRef: 'tenant-key',
      keyring: {
        'tenant-key': randomBytes(32).toString('base64'),
      },
      keyRotationIntervalDays: 90,
    });

    const ciphertext = await crypto.encrypt({
      plaintext: 'tenant-secret',
      tenantId: 'tenant-a',
      keyRef: 'tenant-key',
    });

    assert.notEqual(ciphertext, 'tenant-secret');
    assert.match(ciphertext, /^v2\.tenant-key\./);
    assert.equal(await crypto.decrypt({ ciphertext, tenantId: 'tenant-a' }), 'tenant-secret');
    assert.equal(await crypto.isEnabled('tenant-a'), true);
  });

  it('passes plaintext through when encryption is disabled', async () => {
    const crypto = new NodeFieldCrypto({
      enabled: false,
      masterKey: randomBytes(32).toString('base64'),
      keyRotationIntervalDays: 90,
    });

    assert.equal(await crypto.encrypt({ plaintext: 'plain', tenantId: 'tenant-a' }), 'plain');
    assert.equal(await crypto.decrypt({ ciphertext: 'plain', tenantId: 'tenant-a' }), 'plain');
    assert.equal(await crypto.isEnabled('tenant-a'), false);
  });
});

describe('NoopFieldCrypto', () => {
  it('passes values through and reports disabled', async () => {
    const crypto = new NoopFieldCrypto();

    assert.equal(
      await crypto.encrypt({ plaintext: 'plain', tenantId: 'tenant-a', keyRef: 'ignored' }),
      'plain',
    );
    assert.equal(await crypto.decrypt({ ciphertext: 'cipher', tenantId: 'tenant-a' }), 'cipher');
    assert.equal(await crypto.isEnabled('tenant-a'), false);
  });
});
