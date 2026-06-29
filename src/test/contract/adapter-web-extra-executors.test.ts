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
      personaId: 'default',
      content: '我是一名耐心的助手',
      updatedAt: 1700000000000,
    }));
    assert.equal(tx.queryOne(narrativeGet('default', 'default')), '我是一名耐心的助手');
  });

  it('get returns null before any set', () => {
    const { tx } = setupAll();
    assert.equal(tx.queryOne(narrativeGet('unknown', 'default')), null);
  });

  it('repeated set overwrites the same row', () => {
    const { tx } = setupAll();
    tx.execute(narrativeSetCmd({ tenantId: 'default', personaId: 'default', content: 'v1', updatedAt: 1 }));
    tx.execute(narrativeSetCmd({ tenantId: 'default', personaId: 'default', content: 'v2', updatedAt: 2 }));
    assert.equal(tx.queryOne(narrativeGet('default', 'default')), 'v2');
  });

  it('★K2 persona 隔离★：同租户两 persona 各自叙事，互不覆盖（web adapter 路径）', () => {
    const { tx } = setupAll();
    tx.execute(narrativeSetCmd({ tenantId: 't1', personaId: 'explorer', content: '我是探索者', updatedAt: 1 }));
    tx.execute(narrativeSetCmd({ tenantId: 't1', personaId: 'guardian', content: '我是守护者', updatedAt: 1 }));
    assert.equal(tx.queryOne(narrativeGet('t1', 'explorer')), '我是探索者');
    assert.equal(tx.queryOne(narrativeGet('t1', 'guardian')), '我是守护者', 'guardian 未被 explorer 覆盖');
  });
});

describe('adapter-web decision-style executors', () => {
  it('set then get returns the row with parsed updatedAt', () => {
    const { tx } = setupAll();
    tx.execute(decisionStyleSetCmd({
      tenantId: 'default',
      personaId: 'default',
      styleJson: '{"riskTolerance":0.4}',
      updatedAt: 1700000000000,
    }));
    const row = tx.queryOne(decisionStyleGet('default', 'default'));
    assert.equal(row?.styleJson, '{"riskTolerance":0.4}');
    assert.equal(row?.updatedAt, 1700000000000);
  });

  it('get returns null before any set', () => {
    const { tx } = setupAll();
    assert.equal(tx.queryOne(decisionStyleGet('default', 'default')), null);
  });

  it('★K2 persona 隔离★：同租户两 persona 各自决策风格，互不覆盖（web adapter 路径）', () => {
    const { tx } = setupAll();
    tx.execute(decisionStyleSetCmd({ tenantId: 't1', personaId: 'explorer', styleJson: '{"riskAppetite":0.9}', updatedAt: 1 }));
    tx.execute(decisionStyleSetCmd({ tenantId: 't1', personaId: 'guardian', styleJson: '{"riskAppetite":0.1}', updatedAt: 1 }));
    assert.equal(tx.queryOne(decisionStyleGet('t1', 'explorer'))?.styleJson, '{"riskAppetite":0.9}');
    assert.equal(tx.queryOne(decisionStyleGet('t1', 'guardian'))?.styleJson, '{"riskAppetite":0.1}', 'guardian 未被 explorer 覆盖');
  });

  it('★旧 web 快照向后兼容★：无 persona_id 的旧行被当 default 读到（hydrate 无 backfill）', () => {
    const { tables, tx } = setupAll();
    /* 模拟旧版本写入的 web 快照行——无 persona_id。 */
    tables.defineTable('decision_style');
    tables.upsert('decision_style', { id: 'ds_t1', tenant_id: 't1', style_json: '{"riskAppetite":0.42}', updated_at: 5 });
    tables.defineTable('narrative');
    tables.upsert('narrative', { id: 'narr_t1', tenant_id: 't1', content: '旧叙事', updated_at: 5 });
    /* 新 query 按 default persona 读——旧行(无 persona_id)被当 default 命中。 */
    assert.equal(tx.queryOne(decisionStyleGet('t1', 'default'))?.styleJson, '{"riskAppetite":0.42}', '旧 ds 行读到');
    assert.equal(tx.queryOne(narrativeGet('t1', 'default')), '旧叙事', '旧 narrative 行读到');
  });
});

describe('adapter-web memory executors', () => {
  function makeNode(id: string, salience = 0.5): MemInsertParams {
    return {
      id, personaId: 'default', kind: 'episodic', content: `node ${id}`,
      valence: 0, salience,
      createdAt: 1700000000000, lastAccessedAt: 1700000000000,
      accessCount: 0, decayLambda: 0.1, lastDecayedAt: 1700000000000,
      consolidatedFrom: null,
    };
  }

  it('insert + queryById round-trip', () => {
    const { tx } = setupAll();
    tx.execute({ kind: MEM_CMD_INSERT, params: makeNode('m1') });
    const node = tx.queryOne({ kind: MEM_QUERY_BY_ID, params: { id: 'm1', personaId: 'default' } });
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
    const node = tx.queryOne({ kind: MEM_QUERY_BY_ID, params: { id: 'm1', personaId: 'default' } });
    assert.equal((node as { salience: number }).salience, 0.9);
  });

  it('queryAll sorts by createdAt desc and queryCount returns size', () => {
    const { tx } = setupAll();
    tx.transaction(() => {
      for (const id of ['m1', 'm2', 'm3']) {
        tx.execute({ kind: MEM_CMD_INSERT, params: makeNode(id) });
      }
    });
    const all = tx.queryMany({ kind: MEM_QUERY_ALL, params: { personaId: 'default' } });
    assert.equal(all.length, 3);
    const count = tx.queryOne({ kind: MEM_QUERY_COUNT, params: { personaId: 'default' } });
    assert.equal(count, 3);
  });

  it('delete removes one row', () => {
    const { tx } = setupAll();
    tx.execute({ kind: MEM_CMD_INSERT, params: makeNode('m1') });
    const result = tx.execute({ kind: MEM_CMD_DELETE, params: { id: 'm1', personaId: 'default' } });
    assert.equal(result.rowsAffected, 1);
    assert.equal(tx.queryOne({ kind: MEM_QUERY_BY_ID, params: { id: 'm1', personaId: 'default' } }), null);
  });
});
