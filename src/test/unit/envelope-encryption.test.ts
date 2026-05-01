import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDatabase, runMigrations } from '../../storage/index.js';
import { PlatformKmsClient, createKmsClient } from '../../enterprise/kms-client.js';
import { EnvelopeEncryption } from '../../enterprise/envelope-encryption.js';
import { loadConfig } from '../../config/schema.js';

// 有效的 32 字节 base64 测试用主密钥
const TEST_MASTER_KEY = Buffer.alloc(32, 0x42).toString('base64');

function makeDb() {
  const db = createMemoryDatabase();
  runMigrations(db);
  return db;
}

describe('EnvelopeEncryption — PlatformKmsClient 端到端', () => {
  it('平台 KMS 加密解密往返', async () => {
    const db = makeDb();
    const kms = new PlatformKmsClient(TEST_MASTER_KEY);
    const enc = new EnvelopeEncryption(kms, db, 'tenant-1', 'master');

    const plaintext = '敏感数据 hello world 123';
    const ciphertext = await enc.encrypt(plaintext);
    const decrypted = await enc.decrypt(ciphertext);

    assert.equal(decrypted, plaintext);
  });

  it('密文以 env.v1. 开头', async () => {
    const db = makeDb();
    const kms = new PlatformKmsClient(TEST_MASTER_KEY);
    const enc = new EnvelopeEncryption(kms, db, 'tenant-1', 'master');

    const ciphertext = await enc.encrypt('test');
    assert.ok(ciphertext.startsWith('env.v1.'), `密文应以 env.v1. 开头，实际: ${ciphertext.slice(0, 20)}`);
  });

  it('加密写入 generate 审计记录', async () => {
    const db = makeDb();
    const kms = new PlatformKmsClient(TEST_MASTER_KEY);
    const enc = new EnvelopeEncryption(kms, db, 'tenant-audit', 'some-key-ref');

    await enc.encrypt('audit test');

    const row = db.prepare<{ operation: string; tenant_id: string; success: number }>(
      'SELECT operation, tenant_id, success FROM kms_key_audit WHERE tenant_id = ? ORDER BY performed_at DESC LIMIT 1',
    ).get('tenant-audit');

    assert.ok(row, '应写入审计记录');
    assert.equal(row.operation, 'generate');
    assert.equal(row.tenant_id, 'tenant-audit');
    assert.equal(row.success, 1);
  });

  it('解密写入 unwrap 审计记录', async () => {
    const db = makeDb();
    const kms = new PlatformKmsClient(TEST_MASTER_KEY);
    const enc = new EnvelopeEncryption(kms, db, 'tenant-unwrap', 'key-ref-x');

    const ciphertext = await enc.encrypt('test unwrap audit');
    // 清除 generate 记录，方便后续断言 unwrap
    db.prepare<void>('DELETE FROM kms_key_audit').run();

    await enc.decrypt(ciphertext);

    const row = db.prepare<{ operation: string; success: number }>(
      'SELECT operation, success FROM kms_key_audit WHERE tenant_id = ? ORDER BY performed_at DESC LIMIT 1',
    ).get('tenant-unwrap');

    assert.ok(row, '应写入解密审计记录');
    assert.equal(row.operation, 'unwrap');
    assert.equal(row.success, 1);
  });

  it('不同 masterKey 导致解密失败', async () => {
    const db = makeDb();
    const kms1 = new PlatformKmsClient(TEST_MASTER_KEY);
    const enc1 = new EnvelopeEncryption(kms1, db, 'tenant-x', 'ref');
    const ciphertext = await enc1.encrypt('secret');

    const wrongKey = Buffer.alloc(32, 0xAB).toString('base64');
    const kms2 = new PlatformKmsClient(wrongKey);
    const enc2 = new EnvelopeEncryption(kms2, db, 'tenant-x', 'ref');

    await assert.rejects(async () => enc2.decrypt(ciphertext), 'wrongKey 解密应抛出错误');
  });

  it('createKmsClient 对 platform provider 返回 PlatformKmsClient', () => {
    const config = loadConfig({
      encryption: {
        enabled: true,
        masterKey: TEST_MASTER_KEY,
        defaultKeyRef: 'master',
        keyring: {},
        keyRotationIntervalDays: 90,
      },
    });
    const client = createKmsClient('platform', config);
    assert.ok(client instanceof PlatformKmsClient);
    assert.equal(client.provider, 'platform');
  });
});
