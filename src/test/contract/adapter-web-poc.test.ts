/**
 * Contract test: @chrono/adapter-web PoC end-to-end.
 *
 * Demonstrates that the kernel's SyncWriteUnitOfWork port can be
 * satisfied by an in-memory web adapter, including:
 *   - hydrate from a WebKVStore
 *   - execute a Command and observe via Query
 *   - transactional rollback on thrown error
 *   - debounced persistence flush
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  InMemoryTables,
  MemoryWebKVStore,
  WebPersistenceController,
  WebUnitOfWork,
  createExecutorRegistry,
  registerToolPermissionExecutors,
} from '@chrono/adapter-web';
import { tpermCmdGrant, tpermCmdRevoke, tpermQueryByPersonaTool } from '@chrono/kernel';

function setup() {
  const tables = new InMemoryTables();
  const registry = createExecutorRegistry();
  registerToolPermissionExecutors(registry);
  const store = new MemoryWebKVStore();
  const persistence = new WebPersistenceController(tables, store, { debounceMs: 5 });
  const tx = new WebUnitOfWork(tables, registry);
  tx.onCommit(() => persistence.onCommit());
  return { tables, registry, store, persistence, tx };
}

describe('@chrono/adapter-web PoC', () => {
  it('grant + queryByPersonaTool round-trip', () => {
    const { tx } = setup();
    tx.transaction(() => {
      tx.execute(tpermCmdGrant({
        id: 'tperm_1',
        tenantId: 'default',
        personaId: 'p1',
        toolId: 'web_search',
        scope: 'execute',
        constraintsJson: '{}',
        grantedBy: 'admin',
        now: 1700000000000,
        expiresAt: null,
        revocationKey: 'rk_xyz',
      }));
    });

    const row = tx.queryOne(tpermQueryByPersonaTool({
      tenantId: 'default',
      personaId: 'p1',
      toolId: 'web_search',
    }));
    assert.ok(row);
    assert.equal(row?.id, 'tperm_1');
    assert.equal(row?.scope, 'execute');
    assert.equal(row?.revoked_at, null);
  });

  it('transaction rolls back on thrown error', () => {
    const { tx } = setup();
    tx.transaction(() => {
      tx.execute(tpermCmdGrant({
        id: 'tperm_keep',
        tenantId: 'default', personaId: 'p1', toolId: 'web_search',
        scope: 'execute', constraintsJson: '{}', grantedBy: 'admin',
        now: 1700000000000, expiresAt: null, revocationKey: 'rk_keep',
      }));
    });
    assert.throws(() => {
      tx.transaction(() => {
        tx.execute(tpermCmdGrant({
          id: 'tperm_doomed',
          tenantId: 'default', personaId: 'p1', toolId: 'email',
          scope: 'execute', constraintsJson: '{}', grantedBy: 'admin',
          now: 1700000000001, expiresAt: null, revocationKey: 'rk_doomed',
        }));
        throw new Error('rollback me');
      });
    });
    /* keep should survive, doomed should be gone */
    assert.ok(tx.queryOne(tpermQueryByPersonaTool({
      tenantId: 'default', personaId: 'p1', toolId: 'web_search',
    })));
    assert.equal(tx.queryOne(tpermQueryByPersonaTool({
      tenantId: 'default', personaId: 'p1', toolId: 'email',
    })), null);
  });

  it('persistence flushNow snapshots to WebKVStore and rehydrates cleanly', async () => {
    const { tables, persistence, store, tx } = setup();
    tx.transaction(() => {
      tx.execute(tpermCmdGrant({
        id: 'tperm_persist',
        tenantId: 'default', personaId: 'p1', toolId: 'web_search',
        scope: 'execute', constraintsJson: '{}', grantedBy: 'admin',
        now: 1700000000000, expiresAt: null, revocationKey: 'rk_persist',
      }));
    });
    await persistence.flushNow();
    /* Rehydrate into a fresh adapter pointing at the same store */
    const tables2 = new InMemoryTables();
    const persistence2 = new WebPersistenceController(tables2, store);
    await persistence2.hydrate();
    /* Sanity: the in-memory state of the new instance equals the original */
    assert.deepEqual(tables2.serialize(), tables.serialize());
  });

  it('revoke updates revoked_at and revocation_reason', () => {
    const { tx } = setup();
    tx.transaction(() => {
      tx.execute(tpermCmdGrant({
        id: 'tperm_rev',
        tenantId: 'default', personaId: 'p1', toolId: 'web_search',
        scope: 'execute', constraintsJson: '{}', grantedBy: 'admin',
        now: 1700000000000, expiresAt: null, revocationKey: 'rk_rev',
      }));
    });
    const result = tx.execute(tpermCmdRevoke({
      id: 'tperm_rev',
      reason: 'no longer needed',
      now: 1700000900000,
    }));
    assert.equal(result.rowsAffected, 1);
    const row = tx.queryOne(tpermQueryByPersonaTool({
      tenantId: 'default', personaId: 'p1', toolId: 'web_search',
    }));
    assert.equal(row?.revoked_at, 1700000900000);
    assert.equal(row?.revocation_reason, 'no longer needed');
  });
});
