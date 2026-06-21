import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDatabase } from '../../storage/database.js';
import { runDslSqliteMigrations } from '../../storage/index.js';
import type { IDatabase } from '../../storage/database.js';
import { WorkerCollaborationMemoryStore } from '../../storage/worker-collaboration-memory-store.js';
import { CompanionRelationshipStore } from '../../storage/companion-relationship-store.js';

/* C1 协作记忆：per-counterpart，解串味。worker 对多个对手方各记各的，互不污染。 */
describe('WorkerCollaborationMemoryStore（C1 解串味）', () => {
  let db: IDatabase;
  let store: WorkerCollaborationMemoryStore;

  beforeEach(() => {
    db = createMemoryDatabase();
    runDslSqliteMigrations(db);
    store = new WorkerCollaborationMemoryStore(db, 'tenant-a');
  });

  it('无记录 → undefined', () => {
    assert.equal(store.get('org-1', 'w1', 'worker', 'alice'), undefined);
  });

  it('记一次协作：首次设 first，++count，更新 last', () => {
    store.recordCollaboration('org-1', 'w1', 'worker', 'alice', 1000);
    let m = store.get('org-1', 'w1', 'worker', 'alice')!;
    assert.equal(m.interactionCount, 1);
    assert.equal(m.firstCollaboratedAt, 1000);
    assert.equal(m.lastCollaboratedAt, 1000);
    store.recordCollaboration('org-1', 'w1', 'worker', 'alice', 2000);
    m = store.get('org-1', 'w1', 'worker', 'alice')!;
    assert.equal(m.interactionCount, 2);
    assert.equal(m.firstCollaboratedAt, 1000, 'first 不变');
    assert.equal(m.lastCollaboratedAt, 2000, 'last 更新');
  });

  it('★解串味核心★：worker 对 alice 和 bob 各记各的，互不污染', () => {
    /* w1 跟 alice 协作 3 次，跟 bob 协作 1 次。 */
    store.recordCollaboration('org-1', 'w1', 'worker', 'alice', 1000);
    store.recordCollaboration('org-1', 'w1', 'worker', 'alice', 2000);
    store.recordCollaboration('org-1', 'w1', 'worker', 'alice', 3000);
    store.recordCollaboration('org-1', 'w1', 'worker', 'bob', 4000);
    /* alice 的记忆 = 3 次，bob 的 = 1 次——不串味。 */
    assert.equal(store.get('org-1', 'w1', 'worker', 'alice')!.interactionCount, 3);
    assert.equal(store.get('org-1', 'w1', 'worker', 'bob')!.interactionCount, 1);
  });

  it('★不同 worker 同 counterpart★：w1 和 w2 对 alice 各记各的', () => {
    store.recordCollaboration('org-1', 'w1', 'worker', 'alice', 1000);
    store.recordCollaboration('org-1', 'w2', 'worker', 'alice', 1000);
    store.recordCollaboration('org-1', 'w2', 'worker', 'alice', 2000);
    assert.equal(store.get('org-1', 'w1', 'worker', 'alice')!.interactionCount, 1);
    assert.equal(store.get('org-1', 'w2', 'worker', 'alice')!.interactionCount, 2);
  });

  it('不同 counterpartType（worker/team/external）各自一行', () => {
    store.recordCollaboration('org-1', 'w1', 'worker', 'x', 1000);
    store.recordCollaboration('org-1', 'w1', 'team', 'x', 1000);
    store.recordCollaboration('org-1', 'w1', 'external', 'x', 1000);
    /* 同 id 但不同 type → 三行。 */
    assert.equal(store.listForWorker('org-1', 'w1').length, 3);
  });

  it('listForWorker：列出一个 worker 全部对手方', () => {
    store.recordCollaboration('org-1', 'w1', 'worker', 'alice', 1000);
    store.recordCollaboration('org-1', 'w1', 'team', 'support', 1000);
    assert.equal(store.listForWorker('org-1', 'w1').length, 2);
  });

  it('setNote round-trip + 清洗（控制字符/markup）', () => {
    store.recordCollaboration('org-1', 'w1', 'worker', 'alice', 1000);
    store.setNote('org-1', 'w1', 'worker', 'alice', '常一起\n处理退款<b>', 2000);
    const m = store.get('org-1', 'w1', 'worker', 'alice')!;
    assert.equal(m.note, '常一起处理退款b');
    assert.equal(m.interactionCount, 1, '设备注不动计数');
  });

  it('setNote 不冒充协作时间（Codex 复审）：未协作就设备注 → 时间戳仍 null', () => {
    store.setNote('org-1', 'w1', 'worker', 'newbie', '新同事', 5000);
    const m = store.get('org-1', 'w1', 'worker', 'newbie')!;
    assert.equal(m.note, '新同事');
    assert.equal(m.interactionCount, 0, '设备注不算协作');
    assert.equal(m.firstCollaboratedAt, null, '没真协作就不冒充协作时间');
    assert.equal(m.lastCollaboratedAt, null);
    /* 之后真协作 → 时间戳才落。 */
    store.recordCollaboration('org-1', 'w1', 'worker', 'newbie', 6000);
    const m2 = store.get('org-1', 'w1', 'worker', 'newbie')!;
    assert.equal(m2.firstCollaboratedAt, 6000);
    assert.equal(m2.note, '新同事', '备注保留');
  });

  it('★与 companion_relationship 完全独立★：写协作记忆不影响 companion 关系，反之亦然', () => {
    /* 同 tenant 下，组织协作记忆和 companion 单飞关系是两套表，互不影响。 */
    store.recordCollaboration('org-1', 'w1', 'worker', 'alice', 1000);
    const companionRel = new CompanionRelationshipStore(db, 'tenant-a', 'default');
    companionRel.recordInteraction(1000);
    companionRel.setUserName('小明', 1000);
    /* companion 关系是「那个用户=小明」，不受组织协作记忆影响。 */
    assert.equal(companionRel.get().userName, '小明');
    assert.equal(companionRel.get().interactionCount, 1);
    /* 组织协作记忆是 per-counterpart，不受 companion 影响。 */
    assert.equal(store.get('org-1', 'w1', 'worker', 'alice')!.interactionCount, 1);
  });

  it('租户隔离：A 的协作记忆 B 看不到', () => {
    store.recordCollaboration('org-1', 'w1', 'worker', 'alice', 1000);
    const storeB = new WorkerCollaborationMemoryStore(db, 'tenant-b');
    assert.equal(storeB.get('org-1', 'w1', 'worker', 'alice'), undefined);
  });

  it('PG bigint string → number 强转（时间戳）', () => {
    /* 模拟 PG 返回 string-bigint。 */
    const pgRow = { worker_id: 'w1', counterpart_type: 'worker', counterpart_id: 'a', interaction_count: '5', first_collaborated_at: '1000', last_collaborated_at: '432001000', note: null };
    const fakeDb = { prepare: () => ({ get: () => pgRow, all: () => [pgRow] }) } as unknown as IDatabase;
    const m = new WorkerCollaborationMemoryStore(fakeDb, 'tenant-a').get('org-1', 'w1', 'worker', 'a')!;
    assert.equal(m.interactionCount, 5);
    assert.equal(m.firstCollaboratedAt, 1000);
    assert.equal(m.lastCollaboratedAt, 432001000);
  });
});
