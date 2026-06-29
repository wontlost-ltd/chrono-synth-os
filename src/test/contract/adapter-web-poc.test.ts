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

  it('InMemoryTables.upsert 拒绝缺主键的行（P2-r：String(undefined) 不应绕过校验）', () => {
    const tables = new InMemoryTables();
    tables.defineTable('t');

    /* 缺主键（id=undefined）必须抛错，而非静默存到 'undefined' 键下互相覆盖 */
    assert.throws(
      () => tables.upsert('t', { name: 'no-id' }),
      /missing primary key/,
      '缺主键的行应被拒绝',
    );

    /* 合法主键值（含数字 0）应被接受并可回读 */
    tables.upsert('t', { id: 0, name: 'zero' });
    tables.upsert('t', { id: 'a', name: 'alpha' });
    assert.equal(tables.rows('t').length, 2, '两个不同主键应各自落库（含 id=0）');
    assert.ok(tables.find('t', (r) => r.id === 0), 'id=0 的行应可查到');
  });

  it('InMemoryTables.hydrate 跳过缺主键的污染行（P2-r 读写对称）', () => {
    const tables = new InMemoryTables();
    /* 模拟旧快照：含一个合法行 + 一个缺主键的污染行（fix 前会被存到 "undefined" 键） */
    tables.hydrate({
      tables: {
        t: {
          primaryKey: 'id',
          rows: [
            { id: 'good', name: 'valid' },
            { name: 'orphan-no-id' }, // 缺主键 → 必须被跳过
          ],
        },
      },
    });
    assert.equal(tables.rows('t').length, 1, '污染行应被跳过，仅合法行恢复');
    assert.ok(tables.find('t', (r) => r.id === 'good'), '合法行应正常恢复');
    assert.ok(!tables.find('t', (r) => r.name === 'orphan-no-id'), '缺主键行不应以 undefined 键复活');
  });
});
