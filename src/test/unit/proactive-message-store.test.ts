import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDatabase, runDslSqliteMigrations } from '../../storage/index.js';
import { ProactiveMessageStore } from '../../storage/proactive-message-store.js';
import type { IDatabase } from '../../storage/database.js';

/**
 * 主动消息 outbound 队列 store（ADR-0054 Phase 2）。重点验证 ADR 红线：
 *   - 红线 8 幂等：同一信号(signalType+sourceId+signalVersion) 最多一条；
 *   - 红线 7 归属：跨租户/跨 persona 不串读、不串改。
 */
describe('ProactiveMessageStore（ADR-0054 Phase 2 outbound 管道）', () => {
  let db: IDatabase;
  let clock: number;
  let store: ProactiveMessageStore;

  beforeEach(() => {
    db = createMemoryDatabase();
    runDslSqliteMigrations(db);
    clock = 1000;
    store = new ProactiveMessageStore(db, () => clock, 'tenant-a');
  });

  it('enqueue → list → 读回主动消息', () => {
    const inserted = store.enqueue({
      personaId: 'default', signalType: 'core:memory-consolidated',
      sourceId: 'mem-1', body: '我最近一直在想这件事', kind: 'memory',
    });
    assert.ok(typeof inserted === 'string' && inserted.startsWith('pmsg'), '首次入队应返回新消息 id');
    const rows = store.list('default');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, inserted, '返回的 id 即落库行 id');
    assert.equal(rows[0].body, '我最近一直在想这件事');
    assert.equal(rows[0].status, 'unread');
    assert.equal(rows[0].kind, 'memory');
  });

  it('幂等（红线 8）：同一信号重复 enqueue 只落一条', () => {
    const sig = { personaId: 'default', signalType: 'core:narrative-changed', sourceId: 'nar-1', signalVersion: 3, body: 'A' };
    assert.ok(store.enqueue(sig), '首次应插入（返回 id）');
    assert.equal(store.enqueue({ ...sig, body: 'B' }), null, '同信号重复应被幂等忽略（返回 null）');
    assert.equal(store.enqueue({ ...sig, body: 'C' }), null, '再次重复仍忽略');
    const rows = store.list('default');
    assert.equal(rows.length, 1, '同信号最多一条');
    assert.equal(rows[0].body, 'A', '保留首次入队内容，不被后续覆盖');
  });

  it('signalVersion 不同 → 视为不同信号，各落一条', () => {
    const base = { personaId: 'default', signalType: 'system:evolution-completed', sourceId: 'evo-1', body: 'x' };
    assert.ok(store.enqueue({ ...base, signalVersion: 1 }), '应插入（返回 id）');
    assert.ok(store.enqueue({ ...base, signalVersion: 2 }), '应插入（返回 id）');
    assert.equal(store.list('default').length, 2, '不同 signalVersion 是不同信号');
  });

  it('listUnread 只返回未读；markRead 后从未读列表消失', () => {
    store.enqueue({ personaId: 'default', signalType: 's', sourceId: 'a', body: '1' });
    store.enqueue({ personaId: 'default', signalType: 's', sourceId: 'b', body: '2' });
    const unread = store.listUnread('default');
    assert.equal(unread.length, 2);

    const ok = store.markRead(unread[0].id, 'default');
    assert.equal(ok, 'marked', '未读→已读应成功');
    assert.equal(store.listUnread('default').length, 1, '已读的从未读列表移除');

    /* 重复 markRead 同一条 → 'already_read'（幂等，route 会返回 200）。 */
    assert.equal(store.markRead(unread[0].id, 'default'), 'already_read', '已读再标记幂等');
  });

  it('markRead 不存在的 id → not_found', () => {
    assert.equal(store.markRead('pmsg-nonexistent', 'default'), 'not_found');
  });

  it('租户隔离（红线 7）：另一租户读不到 / 改不动本租户消息', () => {
    store.enqueue({ personaId: 'default', signalType: 's', sourceId: 'a', body: 'tenant-a 的消息' });
    const idA = store.list('default')[0].id;

    const storeB = new ProactiveMessageStore(db, () => clock, 'tenant-b');
    assert.equal(storeB.list('default').length, 0, 'tenant-b 读不到 tenant-a 的主动消息');
    /* 跨租户 markRead → not_found（不泄漏存在性，且改不动）。 */
    assert.equal(storeB.markRead(idA, 'default'), 'not_found', 'tenant-b 改不动 tenant-a 的消息');
    /* tenant-a 的消息仍未读（未被 tenant-b 误改）。 */
    assert.equal(store.list('default')[0].status, 'unread');
  });

  it('persona 隔离：另一 persona 读不到 / 改不动', () => {
    store.enqueue({ personaId: 'persona-1', signalType: 's', sourceId: 'a', body: 'p1' });
    const id1 = store.list('persona-1')[0].id;
    assert.equal(store.list('persona-2').length, 0, '另一 persona 读不到');
    assert.equal(store.markRead(id1, 'persona-2'), 'not_found', '另一 persona 改不动');
  });
});
