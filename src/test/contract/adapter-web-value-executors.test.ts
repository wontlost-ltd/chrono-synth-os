/**
 * Contract test: @chrono/adapter-web core_values executors.
 * Demonstrates extending the adapter to additional kernel domains.
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
} from '@chrono/kernel';

function setup() {
  const tables = new InMemoryTables();
  const registry = createExecutorRegistry();
  registerValueExecutors(registry);
  const tx = new WebUnitOfWork(tables, registry);
  return { tables, tx };
}

describe('@chrono/adapter-web core_values', () => {
  it('create + queryById round-trip', () => {
    const { tx } = setup();
    tx.transaction(() => {
      tx.execute(createValueCmd({
        id: 'patience',
        label: 'Patience',
        weight: 0.9,
        timeDiscount: 0.1,
        emotionAmplifier: 1.0,
        updatedAt: 1700000000000,
      }));
    });
    const v = tx.queryOne(valueById('patience'));
    assert.ok(v);
    assert.equal(v?.label, 'Patience');
    assert.equal(v?.weight, 0.9);
  });

  it('create rejects duplicate id', () => {
    const { tx } = setup();
    tx.transaction(() => {
      tx.execute(createValueCmd({
        id: 'patience', label: 'Patience',
        weight: 0.9, timeDiscount: 0.1, emotionAmplifier: 1.0,
        updatedAt: 1700000000000,
      }));
    });
    assert.throws(() => {
      tx.transaction(() => {
        tx.execute(createValueCmd({
          id: 'patience', label: 'Dup',
          weight: 0.5, timeDiscount: 0.1, emotionAmplifier: 1.0,
          updatedAt: 1700000000001,
        }));
      });
    });
  });

  it('update applies patch and bumps updatedAt', () => {
    const { tx } = setup();
    tx.transaction(() => {
      tx.execute(createValueCmd({
        id: 'precision', label: 'Precision',
        weight: 0.5, timeDiscount: 0.1, emotionAmplifier: 1.0,
        updatedAt: 1700000000000,
      }));
    });
    tx.execute(updateValueCmd({
      id: 'precision',
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
    tx.execute(upsertValueCmd({
      id: 'curiosity', label: 'Curiosity',
      weight: 0.4, timeDiscount: 0.1, emotionAmplifier: 1.0,
      updatedAt: 1700000000000,
    }));
    tx.execute(upsertValueCmd({
      id: 'curiosity', label: 'Curiosity',
      weight: 0.85, timeDiscount: 0.2, emotionAmplifier: 1.2,
      updatedAt: 1700000900000,
    }));
    const v = tx.queryOne(valueById('curiosity'));
    assert.equal(v?.weight, 0.85);
    assert.equal(v?.emotionAmplifier, 1.2);
  });

  it('allValues returns rows sorted by weight desc, then id asc', () => {
    const { tx } = setup();
    tx.transaction(() => {
      for (const [id, weight] of [['z', 0.5], ['a', 0.9], ['m', 0.5]] as const) {
        tx.execute(createValueCmd({
          id, label: id.toUpperCase(),
          weight, timeDiscount: 0.1, emotionAmplifier: 1.0,
          updatedAt: 1700000000000,
        }));
      }
    });
    const all = tx.queryMany(allValues());
    assert.deepEqual(all.map((v) => v.id), ['a', 'm', 'z']);
  });

  it('deleteValueCmd removes row', () => {
    const { tx } = setup();
    tx.execute(upsertValueCmd({
      id: 'tmp', label: 'tmp',
      weight: 0.1, timeDiscount: 0.1, emotionAmplifier: 1.0,
      updatedAt: 1700000000000,
    }));
    const result = tx.execute(deleteValueCmd('tmp'));
    assert.equal(result.rowsAffected, 1);
    assert.equal(tx.queryOne(valueById('tmp')), null);
  });

  it('deleteAllValuesCmd clears the table', () => {
    const { tx } = setup();
    tx.transaction(() => {
      for (const id of ['a', 'b', 'c']) {
        tx.execute(createValueCmd({
          id, label: id, weight: 0.5, timeDiscount: 0.1, emotionAmplifier: 1.0,
          updatedAt: 1700000000000,
        }));
      }
    });
    const result = tx.execute(deleteAllValuesCmd());
    assert.equal(result.rowsAffected, 3);
    assert.equal(tx.queryMany(allValues()).length, 0);
  });
});
