import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createPlatformTenantVault } from '../../data-plane/tenant-vault.js';
import { createStorageProviderResolver } from '../../data-plane/storage-provider-resolver.js';
import { createMemoryDatabase, runDslSqliteMigrations, type IDatabase } from '../../storage/index.js';
import { TestClock } from '../../utils/clock.js';

async function withDb(fn: (db: IDatabase) => Promise<void> | void): Promise<void> {
  const db = createMemoryDatabase();
  try {
    runDslSqliteMigrations(db);
    await fn(db);
  } finally {
    db.close();
  }
}

interface CountRow {
  count: number;
}

const TENANT = 'tenant-vault-test';
const KEY_REF = 'tenant-key';

describe('TenantVault', () => {
  it('wraps and unwraps a data key', async () => withDb(async (db) => {
    const vault = createPlatformTenantVault(db);
    const plaintextDataKey = randomBytes(32);

    const wrapped = await vault.wrapDataKey({ tenantId: TENANT, keyRef: KEY_REF, plaintextDataKey });
    const unwrapped = await vault.unwrapDataKey({
      tenantId: TENANT,
      keyRef: KEY_REF,
      wrappedDataKey: wrapped.wrappedDataKey,
    });

    assert.equal(wrapped.keyVersion, 1);
    assert.notDeepEqual(Buffer.from(wrapped.wrappedDataKey), plaintextDataKey);
    assert.deepEqual(Buffer.from(unwrapped), plaintextDataKey);
  }));

  it('signs and verifies a payload', async () => withDb(async (db) => {
    const vault = createPlatformTenantVault(db);
    const payload = Buffer.from('payload to sign');

    const signed = await vault.sign({ tenantId: TENANT, keyRef: KEY_REF, payload });
    const verified = await vault.verify({
      tenantId: TENANT,
      keyRef: KEY_REF,
      payload,
      signature: signed.signature,
    });
    const tampered = await vault.verify({
      tenantId: TENANT,
      keyRef: KEY_REF,
      payload: Buffer.from('payload to sign!'),
      signature: signed.signature,
    });

    assert.equal(signed.algorithm, 'HMAC-SHA256');
    assert.equal(signed.keyVersion, 1);
    assert.equal(verified, true);
    assert.equal(tampered, false);
  }));

  it('throws when the latest key version is revoked', async () => withDb(async (db) => {
    const vault = createPlatformTenantVault(db);
    await vault.sign({ tenantId: TENANT, keyRef: KEY_REF, payload: Buffer.from('prime key version') });

    db.prepare(
      `UPDATE tenant_key_versions
       SET status = 'revoked', revoked_at = ?
       WHERE tenant_id = ? AND key_ref = ?`,
    ).run(Date.now(), TENANT, KEY_REF);

    await assert.rejects(
      vault.sign({ tenantId: TENANT, keyRef: KEY_REF, payload: Buffer.from('blocked') }),
      /key revoked: tenant-key/,
    );
  }));

  it('writes audit rows after operations', async () => withDb(async (db) => {
    const vault = createPlatformTenantVault(db);
    const dataKey = randomBytes(32);
    const wrapped = await vault.wrapDataKey({ tenantId: TENANT, keyRef: KEY_REF, plaintextDataKey: dataKey });
    await vault.unwrapDataKey({ tenantId: TENANT, keyRef: KEY_REF, wrappedDataKey: wrapped.wrappedDataKey });
    const signed = await vault.sign({ tenantId: TENANT, keyRef: KEY_REF, payload: Buffer.from('payload') });
    await vault.verify({ tenantId: TENANT, keyRef: KEY_REF, payload: Buffer.from('payload'), signature: signed.signature });

    const row = db
      .prepare<CountRow>('SELECT COUNT(*) AS count FROM tenant_vault_audit WHERE tenant_id = ?')
      .get(TENANT);

    assert.equal(row?.count, 4);
  }));

  it('注入 Clock 时时间戳确定可复现（确定性 P1）', async () => withDb(async (db) => {
    const fixed = 1_700_000_000_000;
    const vault = createPlatformTenantVault(db, new TestClock(fixed));
    await vault.sign({ tenantId: TENANT, keyRef: KEY_REF, payload: Buffer.from('det') });

    /* 密钥版本创建时间戳 == 注入时钟 */
    const keyRow = db
      .prepare<{ created_at: number }>(
        'SELECT created_at FROM tenant_key_versions WHERE tenant_id = ? AND key_ref = ?',
      )
      .get(TENANT, KEY_REF);
    assert.equal(Number(keyRow?.created_at), fixed, '密钥版本 created_at 须等于注入时钟');

    /* 审计 performed_at == 注入时钟 */
    const auditRow = db
      .prepare<{ performed_at: number }>(
        'SELECT performed_at FROM tenant_vault_audit WHERE tenant_id = ? ORDER BY performed_at DESC LIMIT 1',
      )
      .get(TENANT);
    assert.equal(Number(auditRow?.performed_at), fixed, '审计 performed_at 须等于注入时钟');
  }));
});

describe('StorageProviderResolver', () => {
  it('returns platform default for an unknown tenant', async () => withDb(async (db) => {
    const resolver = createStorageProviderResolver(db);

    const storage = await resolver.resolveTenantStorage('unknown-tenant');

    assert.deepEqual(storage, {
      provider: 'platform',
      bucketOrPath: 'platform',
    });
  }));

  it('returns bound storage', async () => withDb(async (db) => {
    const resolver = createStorageProviderResolver(db);
    db.prepare(
      `INSERT INTO tenant_storage_bindings(
        tenant_id, provider, bucket_or_path, region, encryption_key_ref, created_at, updated_at
      )
      VALUES(?, ?, ?, ?, ?, ?, ?)`,
    ).run(TENANT, 's3', 'chrono-tenant-bucket', 'us-west-2', KEY_REF, Date.now(), Date.now());

    const storage = await resolver.resolveTenantStorage(TENANT);

    assert.deepEqual(storage, {
      provider: 's3',
      bucketOrPath: 'chrono-tenant-bucket',
      region: 'us-west-2',
      encryptionKeyRef: KEY_REF,
    });
  }));
});
