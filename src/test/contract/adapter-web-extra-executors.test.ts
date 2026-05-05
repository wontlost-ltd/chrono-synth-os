/**
 * Contract test: adapter-web's narrative / decision-style / memory executors.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  InMemoryTables,
  WebUnitOfWork,
  createExecutorRegistry,
  registerMemoryExecutors,
  registerNarrativeExecutors,
  registerDecisionStyleExecutors,
} from '@chrono/adapter-web';
import {
  narrativeGet,
  narrativeSetCmd,
  decisionStyleGet,
  decisionStyleSetCmd,
} from '@chrono/kernel';
import {
  MEM_CMD_INSERT,
  MEM_CMD_UPSERT,
  MEM_CMD_DELETE,
  MEM_QUERY_BY_ID,
  MEM_QUERY_ALL,
  MEM_QUERY_COUNT,
  type MemInsertParams,
} from '@chrono/kernel';

function setupAll() {
  const tables = new InMemoryTables();
  const registry = createExecutorRegistry();
  registerNarrativeExecutors(registry);
  registerDecisionStyleExecutors(registry);
  registerMemoryExecutors(registry);
  const tx = new WebUnitOfWork(tables, registry);
  return { tables, tx };
}

describe('adapter-web narrative executors', () => {
  it('set then get returns the content', () => {
    const { tx } = setupAll();
    tx.execute(narrativeSetCmd({
      tenantId: 'default',
      content: '我是一名耐心的助手',
      updatedAt: 1700000000000,
    }));
    assert.equal(tx.queryOne(narrativeGet('default')), '我是一名耐心的助手');
  });

  it('get returns null before any set', () => {
    const { tx } = setupAll();
    assert.equal(tx.queryOne(narrativeGet('unknown')), null);
  });

  it('repeated set overwrites the same row', () => {
    const { tx } = setupAll();
    tx.execute(narrativeSetCmd({ tenantId: 'default', content: 'v1', updatedAt: 1 }));
    tx.execute(narrativeSetCmd({ tenantId: 'default', content: 'v2', updatedAt: 2 }));
    assert.equal(tx.queryOne(narrativeGet('default')), 'v2');
  });
});

describe('adapter-web decision-style executors', () => {
  it('set then get returns the row with parsed updatedAt', () => {
    const { tx } = setupAll();
    tx.execute(decisionStyleSetCmd({
      tenantId: 'default',
      styleJson: '{"riskTolerance":0.4}',
      updatedAt: 1700000000000,
    }));
    const row = tx.queryOne(decisionStyleGet('default'));
    assert.equal(row?.styleJson, '{"riskTolerance":0.4}');
    assert.equal(row?.updatedAt, 1700000000000);
  });

  it('get returns null before any set', () => {
    const { tx } = setupAll();
    assert.equal(tx.queryOne(decisionStyleGet('default')), null);
  });
});

describe('adapter-web memory executors', () => {
  function makeNode(id: string, salience = 0.5): MemInsertParams {
    return {
      id, kind: 'episodic', content: `node ${id}`,
      valence: 0, salience,
      createdAt: 1700000000000, lastAccessedAt: 1700000000000,
      accessCount: 0, decayLambda: 0.1, lastDecayedAt: 1700000000000,
      consolidatedFrom: null,
    };
  }

  it('insert + queryById round-trip', () => {
    const { tx } = setupAll();
    tx.execute({ kind: MEM_CMD_INSERT, params: makeNode('m1') });
    const node = tx.queryOne({ kind: MEM_QUERY_BY_ID, params: { id: 'm1' } });
    assert.ok(node);
    assert.equal((node as { id: string }).id, 'm1');
  });

  it('insert rejects duplicate ids', () => {
    const { tx } = setupAll();
    tx.execute({ kind: MEM_CMD_INSERT, params: makeNode('m1') });
    assert.throws(() => {
      tx.execute({ kind: MEM_CMD_INSERT, params: makeNode('m1') });
    });
  });

  it('upsert overwrites on duplicate id', () => {
    const { tx } = setupAll();
    tx.execute({ kind: MEM_CMD_UPSERT, params: makeNode('m1', 0.4) });
    tx.execute({ kind: MEM_CMD_UPSERT, params: makeNode('m1', 0.9) });
    const node = tx.queryOne({ kind: MEM_QUERY_BY_ID, params: { id: 'm1' } });
    assert.equal((node as { salience: number }).salience, 0.9);
  });

  it('queryAll sorts by createdAt desc and queryCount returns size', () => {
    const { tx } = setupAll();
    tx.transaction(() => {
      for (const id of ['m1', 'm2', 'm3']) {
        tx.execute({ kind: MEM_CMD_INSERT, params: makeNode(id) });
      }
    });
    const all = tx.queryMany({ kind: MEM_QUERY_ALL, params: undefined });
    assert.equal(all.length, 3);
    const count = tx.queryOne({ kind: MEM_QUERY_COUNT, params: undefined });
    assert.equal((count as { count: number }).count, 3);
  });

  it('delete removes one row', () => {
    const { tx } = setupAll();
    tx.execute({ kind: MEM_CMD_INSERT, params: makeNode('m1') });
    const result = tx.execute({ kind: MEM_CMD_DELETE, params: { id: 'm1' } });
    assert.equal(result.rowsAffected, 1);
    assert.equal(tx.queryOne({ kind: MEM_QUERY_BY_ID, params: { id: 'm1' } }), null);
  });
});
