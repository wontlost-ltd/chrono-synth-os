import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDatabase } from '../../storage/database.js';
import { runDslSqliteMigrations } from '../../storage/index.js';
import { PlatformKeyResolver } from '../../data-plane/platform-key-resolver.js';
import type { IDatabase } from '../../storage/database.js';

const TEST_KEY = Buffer.alloc(32).toString('base64');

function makeResolver(db: IDatabase): PlatformKeyResolver {
  return new PlatformKeyResolver(
    { defaultKeyRef: 'master', keyring: { master: TEST_KEY } },
    db,
  );
}

describe('PlatformKeyResolver', () => {
  let db: IDatabase;

  beforeEach(() => {
    db = createMemoryDatabase();
    runDslSqliteMigrations(db);
  });

  it('resolve() returns KeyHandle with correct algorithm', async () => {
    const resolver = makeResolver(db);
    const handle = await resolver.resolve('master', 'encrypt');
    assert.equal(handle.keyRef, 'master');
    assert.equal(handle.algorithm, 'aes-256-gcm');
  });

  it('resolve() with decrypt purpose returns valid KeyHandle', async () => {
    const resolver = makeResolver(db);
    const handle = await resolver.resolve('master', 'decrypt');
    assert.equal(handle.keyRef, 'master');
    assert.equal(handle.algorithm, 'aes-256-gcm');
  });

  it('resolve() throws for unknown keyRef', async () => {
    const resolver = makeResolver(db);
    await assert.rejects(() => resolver.resolve('nonexistent', 'encrypt'));
  });

  it('rotate() returns KeyRotationResult with new keyRef', async () => {
    const resolver = makeResolver(db);
    const result = await resolver.rotate('master');
    assert.equal(result.previousKeyRef, 'master');
    assert.ok(result.newKeyRef.startsWith('master.v'));
    assert.equal(result.algorithm, 'aes-256-gcm');
  });

  it('rotate() returns newKeyRef starting with master.v', async () => {
    const resolver = makeResolver(db);
    const result = await resolver.rotate('master');
    assert.ok(result.newKeyRef.startsWith('master.v'));
  });

  it('revoke() is idempotent - second call does not throw', async () => {
    const resolver = makeResolver(db);

    await resolver.revoke('master');
    await assert.doesNotReject(() => resolver.revoke('master'));

    const row = db.prepare<{ count: number }>(
      'SELECT COUNT(*) AS count FROM platform_key_revocations WHERE key_ref = ?',
    ).get('master');
    assert.equal(row?.count, 1);
  });

  it('revoke() then resolve() throws revoked error', async () => {
    const resolver = makeResolver(db);
    await resolver.revoke('master');
    await assert.rejects(
      () => resolver.resolve('master', 'decrypt'),
      (err: unknown) => err instanceof Error && (err as Error).message.includes('已撤销'),
    );
  });

  it('revoked keys persist across resolver instances', async () => {
    const resolver1 = makeResolver(db);
    await resolver1.revoke('master');

    const resolver2 = makeResolver(db);
    await assert.rejects(() => resolver2.resolve('master', 'decrypt'));
  });
});
