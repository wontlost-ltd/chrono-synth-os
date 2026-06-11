/**
 * ADR-0047：规则专用持久表（RuleStore）。
 * 用真实 better-sqlite3 + 全量 DSL 迁移（含 v083 persona_rules）验证：
 *   - appendVersion 版本递增（同 ruleId 每次 +1，从 1 起）+ 留史
 *   - getActiveRules 取每个 ruleId 的最高版本
 *   - listByPersona
 *   - tenant + persona + ruleId 维度隔离
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDatabase, runDslSqliteMigrations } from '../../storage/index.js';
import type { IDatabase } from '../../storage/index.js';
import { RuleStore } from '../../storage/rule-store.js';
import { ValidationError } from '../../errors/index.js';
import type { SyncWriteUnitOfWork, RulePayload } from '@chrono/kernel';

const T = 'default';
const P1 = 'persona_1';
const P2 = 'persona_2';

const preferQuality: RulePayload = {
  ruleId: 'prefer_quality',
  condition: '质量',
  action: 'prefer',
  weight: 0.7,
  description: '优先质量',
};

describe('RuleStore (ADR-0047 durable versioned rules)', () => {
  let db: IDatabase;
  let store: RuleStore;

  beforeEach(() => {
    db = createMemoryDatabase();
    runDslSqliteMigrations(db);
    store = new RuleStore(db, T);
  });

  it('首次 appendVersion → version 1，可按 active rules 取回', () => {
    const v = store.appendVersion(P1, preferQuality, 'dart-1', 1000);
    assert.equal(v, 1);
    const active = store.getActiveRules(P1);
    assert.deepEqual(active, [preferQuality]);
    const rows = store.listByPersona(P1);
    assert.equal(rows[0].artifactId, 'dart-1');
    assert.equal(rows[0].version, 1);
    assert.equal(rows[0].createdAt, 1000);
  });

  it('同 ruleId 再 appendVersion → version 递增、getActiveRules 取最高版本、留史', () => {
    store.appendVersion(P1, preferQuality, null, 1000);
    const v2 = store.appendVersion(P1, { ...preferQuality, weight: 0.9 }, null, 2000);
    const v3 = store.appendVersion(P1, { ...preferQuality, action: 'avoid', condition: '拖延' }, null, 3000);
    assert.equal(v2, 2);
    assert.equal(v3, 3);
    assert.deepEqual(store.getActiveRules(P1), [
      { ...preferQuality, action: 'avoid', condition: '拖延' },
    ]);
    assert.deepEqual(store.listByPersona(P1).map((r) => r.version), [3, 2, 1]);
  });

  it('不同 ruleId 各自独立计版本，active 返回每个 ruleId 最新版本', () => {
    store.appendVersion(P1, preferQuality, null, 1000);
    store.appendVersion(P1, { ...preferQuality, weight: 0.8 }, null, 1100);
    const avoidDelay: RulePayload = { ruleId: 'avoid_delay', condition: '拖延', action: 'avoid', weight: 0.6 };
    assert.equal(store.appendVersion(P1, avoidDelay, null, 1200), 1);
    const active = store.getActiveRules(P1);
    assert.deepEqual(active.map((r) => r.ruleId), ['avoid_delay', 'prefer_quality']);
    assert.equal(active.find((r) => r.ruleId === 'prefer_quality')?.weight, 0.8);
  });

  it('persona 维度隔离：P2 看不到 P1 的规则', () => {
    store.appendVersion(P1, preferQuality, null, 1000);
    assert.deepEqual(store.getActiveRules(P2), []);
    assert.equal(store.appendVersion(P2, preferQuality, null, 1000), 1);
    assert.equal(store.getActiveRules(P1).length, 1);
    assert.equal(store.getActiveRules(P2).length, 1);
  });

  it('tenant 维度隔离', () => {
    const other = new RuleStore(db, 'tenant_b');
    store.appendVersion(P1, preferQuality, null, 1000);
    assert.deepEqual(other.getActiveRules(P1), []);
    assert.equal(other.appendVersion(P1, preferQuality, null, 1000), 1);
  });

  it('复合主键冲突显式抛 ValidationError，不静默吞', () => {
    const tx: SyncWriteUnitOfWork = {
      queryOne: <TResult>() => ({ max_version: 0 }) as TResult,
      queryMany: <TResult>() => [] as TResult[],
      execute: () => {
        throw new Error('UNIQUE constraint failed: persona_rules.tenant_id, persona_rules.persona_id, persona_rules.rule_id, persona_rules.version');
      },
      transaction: (fn) => fn(),
    };
    const conflicting = new RuleStore(tx, T);
    assert.throws(
      () => conflicting.appendVersion(P1, preferQuality, null, 1000),
      ValidationError,
    );
  });
});
