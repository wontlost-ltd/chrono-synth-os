import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createImportTokenStore } from '../../privacy/import-token-store.js';
import { createMemoryDatabase, runMigrations, type IDatabase } from '../../storage/index.js';

function withDb(fn: (db: IDatabase) => void): void {
  const db = createMemoryDatabase();
  try {
    runMigrations(db);
    fn(db);
  } finally {
    db.close();
  }
}

const TENANT = 'tenant_1';
const TOKEN = 'tok_abc123';
const IMPORT_ID = 'import_xyz';
const CHECKSUM = 'sha256checksum';
const FUTURE = Date.now() + 60_000;
const PAST = Date.now() - 1;

describe('ImportTokenStore', () => {
  it('issues and consumes a valid token', () => withDb((db) => {
    const store = createImportTokenStore(db);
    store.issue(TOKEN, TENANT, IMPORT_ID, CHECKSUM, FUTURE);
    const result = store.consume(TOKEN, TENANT, CHECKSUM);
    assert.deepStrictEqual(result, { importId: IMPORT_ID });
  }));

  it('returns null when tenant does not match', () => withDb((db) => {
    const store = createImportTokenStore(db);
    store.issue(TOKEN, TENANT, IMPORT_ID, CHECKSUM, FUTURE);
    const result = store.consume(TOKEN, 'other_tenant', CHECKSUM);
    assert.strictEqual(result, null);
  }));

  it('returns null when checksum does not match', () => withDb((db) => {
    const store = createImportTokenStore(db);
    store.issue(TOKEN, TENANT, IMPORT_ID, CHECKSUM, FUTURE);
    const result = store.consume(TOKEN, TENANT, 'wrong_checksum');
    assert.strictEqual(result, null);
  }));

  it('enforces single-use: second consume returns null', () => withDb((db) => {
    const store = createImportTokenStore(db);
    store.issue(TOKEN, TENANT, IMPORT_ID, CHECKSUM, FUTURE);
    const first = store.consume(TOKEN, TENANT, CHECKSUM);
    assert.deepStrictEqual(first, { importId: IMPORT_ID });
    const second = store.consume(TOKEN, TENANT, CHECKSUM);
    assert.strictEqual(second, null);
  }));

  it('returns null for expired tokens', () => withDb((db) => {
    const store = createImportTokenStore(db);
    store.issue(TOKEN, TENANT, IMPORT_ID, CHECKSUM, PAST);
    const result = store.consume(TOKEN, TENANT, CHECKSUM);
    assert.strictEqual(result, null);
  }));

  it('pruneExpired removes only expired tokens', () => withDb((db) => {
    const store = createImportTokenStore(db);
    store.issue('tok_expired', TENANT, 'import_old', CHECKSUM, PAST);
    store.issue('tok_valid', TENANT, 'import_new', CHECKSUM, FUTURE);
    store.pruneExpired();
    assert.strictEqual(store.consume('tok_expired', TENANT, CHECKSUM), null);
    assert.deepStrictEqual(store.consume('tok_valid', TENANT, CHECKSUM), { importId: 'import_new' });
  }));
});
