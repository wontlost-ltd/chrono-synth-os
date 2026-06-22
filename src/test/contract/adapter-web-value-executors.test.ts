/**
 * Contract test: @chrono/adapter-web core_values executors.
 * Demonstrates extending the adapter to additional kernel domains.
 *
 * ADR-0056 K5b：core_values 按 persona_id 隔离（adapter-web 单租户本地库，按 persona 区分）。
 * 命令默认 personaId='default'；新增 persona 隔离用例证明不同 persona 价值互不可见/覆盖。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  InMemoryTables,
  WebUnitOfWork,
  createExecutorRegistry,
  registerValueExecutors,
} from '@chrono/adapter-web';
import {
  allValues,
  createValueCmd,
  deleteAllValuesCmd,
  deleteValueCmd,
  updateValueCmd,
  upsertValueCmd,
  valueById,
  type CreateValueParams,
} from '@chrono/kernel';

function setup() {
  const tables = new InMemoryTables();
  const registry = createExecutorRegistry();
  registerValueExecutors(registry);
  const tx = new WebUnitOfWork(tables, registry);
  return { tables, tx };
}

/** 价值命令参数构造器：默认 personaId='default'，可覆盖。 */
function mk(over: Partial<CreateValueParams> & Pick<CreateValueParams, 'id' | 'label' | 'weight' | 'updatedAt'>): CreateValueParams {
  return {
    personaId: 'default',
    timeDiscount: 0.1,
    emotionAmplifier: 1.0,
    ...over,
  };
}

describe('@chrono/adapter-web core_values', () => {
  it('create + queryById round-trip', () => {
    const { tx } = setup();
    tx.transaction(() => {
      tx.execute(createValueCmd(mk({ id: 'patience', label: 'Patience', weight: 0.9, updatedAt: 1700000000000 })));
    });
    const v = tx.queryOne(valueById('patience'));
    assert.ok(v);
    assert.equal(v?.label, 'Patience');
    assert.equal(v?.weight, 0.9);
  });

  it('create rejects duplicate id', () => {
    const { tx } = setup();
    tx.transaction(() => {
      tx.execute(createValueCmd(mk({ id: 'patience', label: 'Patience', weight: 0.9, updatedAt: 1700000000000 })));
    });
    assert.throws(() => {
      tx.transaction(() => {
        tx.execute(createValueCmd(mk({ id: 'patience', label: 'Dup', weight: 0.5, updatedAt: 1700000000001 })));
      });
    });
  });

  it('update applies patch and bumps updatedAt', () => {
    const { tx } = setup();
    tx.transaction(() => {
      tx.execute(createValueCmd(mk({ id: 'precision', label: 'Precision', weight: 0.5, updatedAt: 1700000000000 })));
    });
    tx.execute(updateValueCmd({
      id: 'precision',
      personaId: 'default',
      patch: { weight: 0.7, emotionAmplifier: 1.5 },
      updatedAt: 1700000900000,
    }));
    const v = tx.queryOne(valueById('precision'));
    assert.equal(v?.weight, 0.7);
    assert.equal(v?.emotionAmplifier, 1.5);
    assert.equal(v?.timeDiscount, 0.1);
    assert.equal(v?.updatedAt, 1700000900000);
  });

  it('upsert overwrites existing', () => {
    const { tx } = setup();
    tx.execute(upsertValueCmd(mk({ id: 'curiosity', label: 'Curiosity', weight: 0.4, updatedAt: 1700000000000 })));
    tx.execute(upsertValueCmd(mk({ id: 'curiosity', label: 'Curiosity', weight: 0.85, timeDiscount: 0.2, emotionAmplifier: 1.2, updatedAt: 1700000900000 })));
    const v = tx.queryOne(valueById('curiosity'));
    assert.equal(v?.weight, 0.85);
    assert.equal(v?.emotionAmplifier, 1.2);
  });

  it('allValues returns rows sorted by weight desc, then id asc', () => {
    const { tx } = setup();
    tx.transaction(() => {
      for (const [id, weight] of [['z', 0.5], ['a', 0.9], ['m', 0.5]] as const) {
        tx.execute(createValueCmd(mk({ id, label: id.toUpperCase(), weight, updatedAt: 1700000000000 })));
      }
    });
    const all = tx.queryMany(allValues());
    assert.deepEqual(all.map((v) => v.id), ['a', 'm', 'z']);
  });

  it('deleteValueCmd removes row', () => {
    const { tx } = setup();
    tx.execute(upsertValueCmd(mk({ id: 'tmp', label: 'tmp', weight: 0.1, updatedAt: 1700000000000 })));
    const result = tx.execute(deleteValueCmd('tmp'));
    assert.equal(result.rowsAffected, 1);
    assert.equal(tx.queryOne(valueById('tmp')), null);
  });

  it('deleteAllValuesCmd clears the table', () => {
    const { tx } = setup();
    tx.transaction(() => {
      for (const id of ['a', 'b', 'c']) {
        tx.execute(createValueCmd(mk({ id, label: id, weight: 0.5, updatedAt: 1700000000000 })));
      }
    });
    const result = tx.execute(deleteAllValuesCmd());
    assert.equal(result.rowsAffected, 3);
    assert.equal(tx.queryMany(allValues()).length, 0);
  });

  /* ── ADR-0056 K5b：persona 隔离 ── */

  it('★persona 隔离★：不同 persona 的价值互不可见，allValues 按 persona 过滤', () => {
    const { tx } = setup();
    tx.transaction(() => {
      tx.execute(createValueCmd(mk({ id: 'v-alice', personaId: 'p-alice', label: '探索', weight: 0.9, updatedAt: 1000 })));
      tx.execute(createValueCmd(mk({ id: 'v-bob', personaId: 'p-bob', label: '稳健', weight: 0.8, updatedAt: 1000 })));
    });
    /* alice 只看到自己的价值。 */
    assert.deepEqual(tx.queryMany(allValues('p-alice')).map((v) => v.id), ['v-alice']);
    assert.deepEqual(tx.queryMany(allValues('p-bob')).map((v) => v.id), ['v-bob']);
    /* byId 按 persona 过滤：alice 的 id 在 bob 视角看不到。 */
    assert.ok(tx.queryOne(valueById('v-alice', 'p-alice')));
    assert.equal(tx.queryOne(valueById('v-alice', 'p-bob')), null, '跨 persona 不可见');
  });

  it('★persona deleteAll 只清自己★：清 alice 不波及 bob', () => {
    const { tx } = setup();
    tx.transaction(() => {
      tx.execute(createValueCmd(mk({ id: 'v-alice', personaId: 'p-alice', label: 'A', weight: 0.5, updatedAt: 1000 })));
      tx.execute(createValueCmd(mk({ id: 'v-bob', personaId: 'p-bob', label: 'B', weight: 0.5, updatedAt: 1000 })));
    });
    tx.execute(deleteAllValuesCmd('p-alice'));
    assert.equal(tx.queryMany(allValues('p-alice')).length, 0, 'alice 已清');
    assert.deepEqual(tx.queryMany(allValues('p-bob')).map((v) => v.id), ['v-bob'], 'bob 不受影响');
  });
});
