/**
 * ADR-0047：响应模板专用持久表（ResponseTemplateStore）。
 * 用真实 better-sqlite3 + 全量 DSL 迁移（含 v082 response_templates）验证：
 *   - appendVersion 版本递增（同 intent 每次 +1，从 1 起）+ 留史
 *   - getLatestByIntent 取最高版本
 *   - listVersionsByIntent / listByPersona
 *   - tenant + persona + intent 维度隔离
 *   - 持久性：模板不随 memory 衰减（它根本不在 memory_nodes 里）
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDatabase, runDslSqliteMigrations } from '../../storage/index.js';
import type { IDatabase } from '../../storage/index.js';
import { ResponseTemplateStore } from '../../storage/response-template-store.js';

const T = 'default';
const P1 = 'persona_1';
const P2 = 'persona_2';

describe('ResponseTemplateStore (ADR-0047 durable versioned templates)', () => {
  let db: IDatabase;
  let store: ResponseTemplateStore;

  beforeEach(() => {
    db = createMemoryDatabase();
    runDslSqliteMigrations(db);
    store = new ResponseTemplateStore(db, T);
  });

  it('首次 appendVersion → version 1，可按 intent 取回', () => {
    const v = store.appendVersion(P1, 'greeting', '你好', 'dart-1', 1000);
    assert.equal(v, 1);
    const tpl = store.getLatestByIntent(P1, 'greeting');
    assert.equal(tpl?.template, '你好');
    assert.equal(tpl?.version, 1);
    assert.equal(tpl?.artifactId, 'dart-1');
    assert.equal(tpl?.createdAt, 1000);
  });

  it('同 intent 再 appendVersion → version 递增、getLatest 取最新、留史', () => {
    store.appendVersion(P1, 'greeting', 'v1', null, 1000);
    const v2 = store.appendVersion(P1, 'greeting', 'v2', null, 2000);
    const v3 = store.appendVersion(P1, 'greeting', 'v3', null, 3000);
    assert.equal(v2, 2);
    assert.equal(v3, 3);
    assert.equal(store.getLatestByIntent(P1, 'greeting')?.template, 'v3');
    assert.equal(store.getLatestByIntent(P1, 'greeting')?.version, 3);
    /* 留史：三个版本都在，最新在前 */
    const versions = store.listVersionsByIntent(P1, 'greeting');
    assert.deepEqual(versions.map((t) => t.version), [3, 2, 1]);
    assert.deepEqual(versions.map((t) => t.template), ['v3', 'v2', 'v1']);
  });

  it('不同 intent 各自独立计版本', () => {
    store.appendVersion(P1, 'greeting', 'g1', null, 1000);
    store.appendVersion(P1, 'greeting', 'g2', null, 1100);
    const f1 = store.appendVersion(P1, 'farewell', 'f1', null, 1200);
    assert.equal(f1, 1, 'different intent starts its own version sequence');
    assert.equal(store.getLatestByIntent(P1, 'greeting')?.version, 2);
    assert.equal(store.getLatestByIntent(P1, 'farewell')?.version, 1);
  });

  it('persona 维度隔离：P2 看不到 P1 的模板', () => {
    store.appendVersion(P1, 'greeting', 'p1 文案', null, 1000);
    assert.equal(store.getLatestByIntent(P2, 'greeting'), undefined);
    /* P2 自己的同 intent 从 version 1 起 */
    assert.equal(store.appendVersion(P2, 'greeting', 'p2 文案', null, 1000), 1);
    assert.equal(store.getLatestByIntent(P1, 'greeting')?.template, 'p1 文案');
    assert.equal(store.getLatestByIntent(P2, 'greeting')?.template, 'p2 文案');
  });

  it('tenant 维度隔离', () => {
    const other = new ResponseTemplateStore(db, 'tenant_b');
    store.appendVersion(P1, 'greeting', 'A 租户', null, 1000);
    assert.equal(other.getLatestByIntent(P1, 'greeting'), undefined);
    assert.equal(other.appendVersion(P1, 'greeting', 'B 租户', null, 1000), 1, 'other tenant independent versioning');
  });

  it('getLatestByIntent 未命中 → undefined', () => {
    assert.equal(store.getLatestByIntent(P1, 'nope'), undefined);
  });

  it('listByPersona 返回该 persona 全部模板（每 intent 每版本一行）', () => {
    store.appendVersion(P1, 'greeting', 'g1', null, 1000);
    store.appendVersion(P1, 'greeting', 'g2', null, 1100);
    store.appendVersion(P1, 'farewell', 'f1', null, 1200);
    const all = store.listByPersona(P1);
    assert.equal(all.length, 3);
    /* 含 greeting 两版 + farewell 一版 */
    assert.equal(all.filter((t) => t.intent === 'greeting').length, 2);
    assert.equal(all.filter((t) => t.intent === 'farewell').length, 1);
  });

  it('持久性：模板落 response_templates 表，不在 memory_nodes（不受衰减/驱逐影响）', () => {
    store.appendVersion(P1, 'greeting', '持久文案', null, 1000);
    const inTemplates = db.prepare<{ c: number }>('SELECT COUNT(*) AS c FROM response_templates').get()?.c;
    const inMemory = db.prepare<{ c: number }>("SELECT COUNT(*) AS c FROM memory_nodes WHERE content LIKE '%持久文案%'").get()?.c;
    assert.equal(inTemplates, 1);
    assert.equal(inMemory, 0, '不应写入会衰减的 memory_nodes');
  });
});
